/**
 * Politeness layer. The brief: at most one request per second per portal, no logins,
 * no captcha solving. Every outgoing request to a portal goes through here, including
 * the requests a headless browser makes.
 */
import { chromium, type Browser, type Page } from "playwright";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "./config.js";
import type { PoliteBrowser, PoliteHttp } from "../shared/modules.js";

// ------------------------------------------------------------ per-host gate

const nextSlot = new Map<string, number>();

/** Waits until this host may be called again, then reserves the next slot. */
export async function gate(host: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + config.minRequestGapMs);
  const wait = slot - now;
  if (wait > 0) await delay(wait, undefined, { signal });
}

/** Pushes the next allowed slot after an outgoing request finishes/responds so IPC or network lag cannot compress gaps under 1 req/s. */
function bumpGap(host: string): void {
  const next = Date.now() + config.minRequestGapMs;
  if (next > (nextSlot.get(host) ?? 0)) nextSlot.set(host, next);
}

// ------------------------------------------------------------ robots.txt

export type RobotsRules = { allow: string[]; disallow: string[] };

/** Our product token for robots.txt groups, e.g. "watchtowerbot" from "WatchtowerBot/0.1 (...)". */
const botToken = () => (config.userAgent.split(/[/\s]/)[0] ?? "").toLowerCase();

/**
 * Parses robots.txt (RFC 9309): consecutive User-agent lines share one group, the group naming
 * our bot wins over "*", and Allow/Disallow support "*" and a trailing "$".
 */
export function parseRobots(text: string, token = botToken()): RobotsRules {
  type Group = { agents: string[]; rules: RobotsRules };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0]!.trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !current) groups.push((current = { agents: [], rules: { allow: [], disallow: [] } }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" && value) current.rules.allow.push(value);
    else if (key === "disallow" && value) current.rules.disallow.push(value);
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return {
    allow: chosen.flatMap((g) => g.rules.allow),
    disallow: chosen.flatMap((g) => g.rules.disallow),
  };
}

function patternMatch(pattern: string, pathAndQuery: string): number {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(pathAndQuery) ? pattern.length : -1;
}

/** Longest matching rule wins; on a tie Allow wins. No rule matching means allowed. */
export function robotsAllow(rules: RobotsRules, pathAndQuery: string): boolean {
  const best = (patterns: string[]) => Math.max(-1, ...patterns.map((p) => patternMatch(p, pathAndQuery)));
  const allow = best(rules.allow);
  const disallow = best(rules.disallow);
  return disallow < 0 || allow >= disallow;
}

const robotsCache = new Map<string, Promise<RobotsRules>>();

/** Rules for one origin, fetched once (through the gate) and shared by HTTP and the browser. */
function rulesFor(origin: string, signal?: AbortSignal): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;
  const loading = (async () => {
    await gate(new URL(origin).host, signal);
    const res = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": config.userAgent }, signal });
    bumpGap(new URL(origin).host);
    // Missing or broken robots.txt means no rules (RFC 9309 treats 4xx as "allow all").
    return res.ok ? parseRobots(await res.text()) : { allow: [], disallow: [] };
  })();
  robotsCache.set(origin, loading);
  // Don't cache a failure (abort, network error): the next request asks again.
  loading.catch(() => {
    if (robotsCache.get(origin) === loading) robotsCache.delete(origin);
  });
  return loading;
}

/** True when robots.txt lets us fetch this URL. Network errors fetching robots.txt count as allowed. */
export async function robotsAllows(url: string, signal?: AbortSignal): Promise<boolean> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  if (u.pathname === "/robots.txt") return true;
  try {
    return robotsAllow(await rulesFor(u.origin, signal), u.pathname + u.search);
  } catch (e) {
    if (signal?.aborted) throw e;
    return true;
  }
}

// ------------------------------------------------------------ HTTP

const MAX_REDIRECTS = 10;

/**
 * Plain HTTP for one run. Redirects are followed by hand so every hop passes robots.txt and the
 * per-host gate (fetch's own "follow" would fire the whole chain at once). Cookies a portal sets
 * are kept for the run and sent back to the same host, which ends cookie-based locale loops.
 */
export function politeHttp(signal: AbortSignal, onRequest?: () => void): PoliteHttp {
  const jar = new Map<string, Map<string, string>>();
  const remember = (host: string, res: Response) => {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const pair = line.split(";")[0]!;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const cookies = jar.get(host) ?? new Map<string, string>();
      cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      jar.set(host, cookies);
    }
  };

  return {
    async fetch(url, init) {
      // The reader may set a shorter deadline than the job; neither may outlive the other.
      const requestSignal = init?.signal && init.signal !== signal ? AbortSignal.any([signal, init.signal]) : signal;
      let current = url;
      let method = (init?.method ?? "GET").toUpperCase();
      let body = init?.body;
      for (let hop = 0; ; hop++) {
        const u = new URL(current);
        if (!(await robotsAllows(current, requestSignal))) throw new Error(`robots.txt disallows ${u.pathname}`);
        await gate(u.host, requestSignal);
        onRequest?.();
        const headers = new Headers(init?.headers);
        if (!headers.has("user-agent")) headers.set("user-agent", config.userAgent);
        if (!headers.has("accept-language")) headers.set("accept-language", "en;q=0.8,de;q=0.7,fr;q=0.6,nl;q=0.6,es;q=0.6");
        const cookies = jar.get(u.host);
        if (cookies?.size && !headers.has("cookie")) headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
        if (method === "GET" || method === "HEAD") headers.delete("content-type");

        const res = await fetch(current, { ...init, method, body: method === "GET" || method === "HEAD" ? undefined : body, headers, signal: requestSignal, redirect: "manual" });
        bumpGap(u.host);
        remember(u.host, res);
        const location = res.headers.get("location");
        if (res.status < 300 || res.status > 399 || res.status === 304 || !location) return res;

        await res.body?.cancel().catch(() => {});
        if (hop + 1 >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}) starting at ${url}`);
        current = new URL(location, current).toString();
        // 303, and 301/302 after a POST, continue as GET without a body (as browsers do).
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
      }
    },
  };
}

// ------------------------------------------------------------ browser

let browserPromise: Promise<Browser> | null = null;
type Launch = () => Promise<Browser>;
const defaultLaunch: Launch = () => chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] }); // Docker gives /dev/shm only 64 MB
let launch: Launch = defaultLaunch;

/** Tests swap in a fake Chromium; null restores the real one. */
export function setBrowserLaunchForTests(fn: Launch | null): void {
  launch = fn ?? defaultLaunch;
  browserPromise = null;
}

async function sharedBrowser(): Promise<Browser> {
  // A Chromium that crashed or was killed is never handed out again: the next page gets a new one.
  if (browserPromise) {
    const current = browserPromise;
    const alive = await current.then((b) => b.isConnected(), () => false);
    if (!alive && browserPromise === current) browserPromise = null;
  }
  if (!browserPromise) {
    const launching = launch();
    browserPromise = launching;
    // A failed launch must not be cached forever: the next page tries again.
    launching.catch(() => {
      if (browserPromise === launching) browserPromise = null;
    });
    launching.then((b) => b.on("disconnected", () => {
      if (browserPromise === launching) browserPromise = null;
    }), () => {});
  }
  return browserPromise;
}

/** Closes the shared Chromium (tests and shutdown). The next withPage launches a new one. */
export async function closeSharedBrowser(): Promise<void> {
  const b = browserPromise;
  browserPromise = null;
  if (b) await (await b).close().catch(() => {});
}

export function politeBrowser(signal: AbortSignal, onRequest?: () => void): PoliteBrowser {
  return {
    async withPage(fn) {
      // All portals share one Chromium. If it crashes (or another portal's page takes it down), this
      // portal's page dies with it through no fault of its own: retry once on a fresh browser.
      // An error from the portal's own work, while the browser is still up, is never retried.
      for (let attempt = 0; ; attempt++) {
        let browser: Browser | null = null;
        try {
          browser = await sharedBrowser();
          return await pageIn(browser, fn);
        } catch (e) {
          if (signal.aborted || attempt >= 1 || !browser || browser.isConnected()) throw e;
        }
      }
    },
  };

  async function pageIn<T>(browser: Browser, fn: (page: Page) => Promise<T>): Promise<T> {
    {
      if (signal.aborted) throw new Error("aborted");
      const context = await browser.newContext({ userAgent: config.userAgent, acceptDownloads: true });
      // DELETE must stop traffic within a minute: closing the context kills its pages,
      // pending navigations, clicks and downloads at once, instead of waiting for fn to finish.
      const stop = () => void context.close().catch(() => {});
      signal.addEventListener("abort", stop, { once: true });
      try {
        await context.route("**/*", async (route) => {
          const req = route.request();
          if (["image", "font", "media"].includes(req.resourceType())) return route.abort();
          try {
            // Same robots.txt rules as plain HTTP, for every request the page makes.
            if (!(await robotsAllows(req.url(), signal))) return route.abort("blockedbyclient");
            await gate(new URL(req.url()).host, signal);
          } catch {
            return route.abort();
          }
          onRequest?.();
          return route.continue();
        });
        const page = await context.newPage();
        const notePageTraffic = (reqUrl: string) => {
          try {
            const parsed = new URL(reqUrl);
            if (parsed.protocol === "http:" || parsed.protocol === "https:") bumpGap(parsed.host);
          } catch {
            // ignore non-http urls
          }
        };
        page.on("response", (res) => notePageTraffic(res.url()));
        page.on("requestfinished", (req) => notePageTraffic(req.url()));
        return await fn(page);
      } finally {
        signal.removeEventListener("abort", stop);
        await context.close().catch(() => {});
      }
    }
  }
}
