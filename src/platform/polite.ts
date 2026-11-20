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

const robotsCache = new Map<string, string[]>();

async function disallowedPaths(origin: string, signal?: AbortSignal): Promise<string[]> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;
  let rules: string[] = [];
  try {
    await gate(new URL(origin).host, signal);
    const res = await fetch(`${origin}/robots.txt`, { headers: { "user-agent": config.userAgent }, signal });
    if (res.ok) {
      let applies = false;
      for (const raw of (await res.text()).split("\n")) {
        const line = raw.split("#")[0]!.trim();
        const [k, ...rest] = line.split(":");
        const key = k?.trim().toLowerCase();
        const value = rest.join(":").trim();
        if (key === "user-agent") applies = value === "*" || config.userAgent.toLowerCase().includes(value.toLowerCase());
        else if (applies && key === "disallow" && value) rules.push(value);
      }
    }
  } catch {
    rules = [];
  }
  robotsCache.set(origin, rules);
  return rules;
}

// ------------------------------------------------------------ HTTP

export function politeHttp(signal: AbortSignal, onRequest?: () => void): PoliteHttp {
  return {
    async fetch(url, init) {
      const u = new URL(url);
      const rules = await disallowedPaths(u.origin, signal);
      if (rules.some((r) => u.pathname.startsWith(r))) throw new Error(`robots.txt disallows ${u.pathname}`);
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
