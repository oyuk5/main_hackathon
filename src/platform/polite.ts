/**
 * Politeness layer. The brief: at most one request per second per portal, no logins,
 * no captcha solving. Every outgoing request to a portal goes through here, including
 * the requests a headless browser makes.
 */
import { chromium, type Browser } from "playwright";
import { config } from "./config.js";
import type { PoliteBrowser, PoliteHttp } from "../shared/modules.js";

// ------------------------------------------------------------ per-host gate

const nextSlot = new Map<string, number>();

/** Waits until this host may be called again, then reserves the next slot. */
export async function gate(host: string, signal?: AbortSignal): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + config.minRequestGapMs);
  const wait = slot - now;
  if (wait > 0) {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, wait);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      }, { once: true });
    });
  }
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

export function politeHttp(signal: AbortSignal, onRequest?: () => void): PoliteHttp {
  return {
    async fetch(url, init) {
      const u = new URL(url);
      if (!(await robotsAllows(url, signal))) throw new Error(`robots.txt disallows ${u.pathname}`);
      await gate(u.host, signal);
      onRequest?.();
      const headers = new Headers(init?.headers);
      if (!headers.has("user-agent")) headers.set("user-agent", config.userAgent);
      if (!headers.has("accept-language")) headers.set("accept-language", "en;q=0.8,de;q=0.7,fr;q=0.6,nl;q=0.6,es;q=0.6");
      return fetch(url, { ...init, headers, signal, redirect: "follow" });
    },
  };
}

// ------------------------------------------------------------ browser

let browserPromise: Promise<Browser> | null = null;
function sharedBrowser(): Promise<Browser> {
  if (!browserPromise) {
    const launching = chromium.launch({ headless: true });
    browserPromise = launching;
    // A failed launch must not be cached forever: the next page tries again.
    launching.catch(() => {
      if (browserPromise === launching) browserPromise = null;
    });
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
      if (signal.aborted) throw new Error("aborted");
      const browser = await sharedBrowser();
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
        return await fn(page);
      } finally {
        signal.removeEventListener("abort", stop);
        await context.close().catch(() => {});
      }
    },
  };
}
