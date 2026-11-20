/**
 * Browser tier: the pages of a JavaScript-only portal, rendered in the polite headless Chromium.
 * Owned by B.
 *
 * The Extractor still does all the reading (same cheerio rules, normalization and diagnostics):
 * this module only turns "open this address" and "click next" into rendered HTML. One browser
 * page serves the whole read, so the per-portal 1 request/second gate is the only limit.
 * No model call, ever.
 */
import type { Page as PwPage } from "playwright";
import type { PortalContext } from "../shared/modules.js";
import type { FetchedPage } from "./extractor.js";

/** How long one navigation, one wait for the list, or one click may take. */
export const BROWSER_STEP_MS = 30_000;
/** After the first list item shows up, how long we wait for the rest of the page to quiet down. */
const SETTLE_GRACE_MS = 5_000;
/** After a click on "next", how long the item list has to change before we call it the end. */
const NEXT_WAIT_MS = 15_000;
const POLL_MS = 250;

/** Where the Extractor gets its pages from when the recipe is browser tier. */
export interface PageSource {
  /** The Extractor's own time limit for one fetch from this source. */
  readonly timeoutMs: number;
  /** Opens `url` and returns the rendered page. `waitFor` is the list item selector, when known. */
  fetch(url: string, init: RequestInit, waitFor?: string): Promise<FetchedPage>;
  /**
   * Clicks `selector` and waits until the item list changes. Null when there is no enabled
   * "next" control or the list did not change: the end of the list.
   */
  clickNext(selector: string, itemsKey: (html: string) => string): Promise<FetchedPage | null>;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => (signal.removeEventListener("abort", onAbort), resolve()), ms);
    const onAbort = () => (clearTimeout(t), reject(new Error("aborted")));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Waits for the list to render: its first item, or the network going quiet (empty list, login wall). */
async function settle(page: PwPage, signal: AbortSignal, waitFor?: string): Promise<void> {
  const idle = page.waitForLoadState("networkidle", { timeout: BROWSER_STEP_MS }).catch(() => {});
  if (!waitFor) return idle;
  // A selector Playwright cannot parse (cheerio-only syntax) falls back to waiting for quiet.
  const item = page.waitForSelector(waitFor, { state: "attached", timeout: BROWSER_STEP_MS }).then(
    () => {},
    () => idle,
  );
  await Promise.race([item, idle]);
  await Promise.race([idle, delay(SETTLE_GRACE_MS, signal)]);
}

export function browserPages(page: PwPage, ctx: PortalContext, onRequest: () => void): PageSource {
  page.on("request", () => onRequest());
  let status = 200;
  let statusText = "";

  const snapshot = async (): Promise<FetchedPage> => ({
    url: page.url(),
    status,
    statusText,
    contentType: "text/html; charset=utf-8",
    text: await page.content(),
  });

  return {
    timeoutMs: 2 * BROWSER_STEP_MS + SETTLE_GRACE_MS + 5_000,

    async fetch(url, init, waitFor) {
      const method = (init.method ?? "GET").toUpperCase();
      if (method !== "GET") throw new Error("the browser tier opens pages with GET only; this list needs a POST");
      await page.setExtraHTTPHeaders(Object.fromEntries(new Headers(init.headers)));
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: BROWSER_STEP_MS });
      status = res?.status() ?? 200;
      statusText = res?.statusText() ?? "";
      const contentType = res?.headers()["content-type"] ?? "";
      // A JSON (or XML) answer is data, not a page to render.
      if (res && /json|xml/i.test(contentType) && !/html/i.test(contentType)) {
        return { url: page.url(), status, statusText, contentType, text: await res.text() };
      }
      await settle(page, ctx.signal, waitFor);
      return snapshot();
    },

    async clickNext(selector, itemsKey) {
      const before = itemsKey(await page.content());
      const next = page.locator(selector).first();
      if ((await next.count()) === 0) return null;
      const off = await next.evaluate((el) => {
        const marked = '.disabled, [disabled], [aria-disabled="true"]';
        return el.matches(marked) || el.closest(marked) !== null;
      });
      if (off || !(await next.isVisible())) return null;
      await next.click({ timeout: BROWSER_STEP_MS });

      // Wait for a different, non-empty item list that holds still for one poll.
      const deadline = Date.now() + NEXT_WAIT_MS;
      let seen: string | null = null;
      while (Date.now() < deadline) {
        await delay(POLL_MS, ctx.signal);
        let html: string;
        try {
          html = await page.content();
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          continue; // the click started a navigation; ask again
        }
        const key = itemsKey(html);
        if (key === "" || key === before) {
          seen = null;
          continue;
        }
        if (key === seen) {
          status = 200;
          statusText = "";
          return { url: page.url(), status, statusText, contentType: "text/html; charset=utf-8", text: html };
        }
        seen = key;
      }
      return null;
    },
  };
}
