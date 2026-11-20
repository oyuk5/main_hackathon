import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CheckResult, PortalContext, Verdict } from "../shared/modules.js";
import type { Recipe } from "../shared/recipe.js";
import {
  capturePortalSnapshot,
  compressHtml,
  compressJson,
  detectBlockInContent,
} from "./snapshot.js";
import { classifyWithRules, triageBreakage } from "./triage.js";
import type { SnapshotOutcome } from "./types.js";

function makeRecipe(tier: Recipe["tier"] = "html"): Recipe {
  return {
    schemaVersion: 1,
    family: null,
    tier,
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    list: {
      request: {
        url: "https://tenders.example.eu/notices?page={page}&size={pageSize}",
        method: "GET",
      },
      pagination: { type: "pageParam", start: 1, maxPages: 10 },
      item: tier === "jsonApi" ? "$.items[*]" : "tr.tender-row",
      emptyText: [],
    },
    listFields: {
      title: tier === "jsonApi" ? { jsonPath: "$.title" } : { css: ".title" },
    },
    detail: null,
    documents: null,
    withdrawnText: [],
  };
}

function makeOkSnapshot(overrides: Partial<Extract<SnapshotOutcome, { kind: "ok" }>> = {}): SnapshotOutcome {
  return {
    kind: "ok",
    url: "https://tenders.example.eu/notices?page=1&size=20",
    finalUrl: "https://tenders.example.eu/notices?page=1&size=20",
    httpStatus: 200,
    contentType: "text/html; charset=utf-8",
    compressedContent: "<main><table></table></main>",
    structureSummary: "tables=1 (rows=2)",
    ...overrides,
  };
}

function makeMockContext(opts: {
  llmResult?: unknown;
  llmError?: Error;
  fetchResponse?: Response;
  aborted?: boolean;
} = {}): { ctx: PortalContext; llmCalls: Array<{ purpose: string; model: string }>; fetchedUrls: string[] } {
  const llmCalls: Array<{ purpose: string; model: string }> = [];
  const fetchedUrls: string[] = [];
  const controller = new AbortController();
  if (opts.aborted) {
    controller.abort();
  }

  const ctx: PortalContext = {
    portalId: "portal-1",
    url: "https://tenders.example.eu/notices",
    http: {
      async fetch(url: string) {
        fetchedUrls.push(url);
        if (opts.fetchResponse) {
          return opts.fetchResponse;
        }
        return new Response("<html><body>OK</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    },
    browser: {
      async withPage() {
        throw new Error("browser not mocked in this test");
      },
    },
    llm: {
      async json(callOpts) {
        llmCalls.push({ purpose: callOpts.purpose, model: callOpts.model });
        if (opts.llmError) {
          throw opts.llmError;
        }
        return callOpts.schema.parse(opts.llmResult);
      },
    },
    log() {},
    signal: controller.signal,
  };

  return { ctx, llmCalls, fetchedUrls };
}

describe("compressHtml", () => {
  it("strips script, style, svg, noscript, and collapses repeated table rows to 2 examples", () => {
    const rows = Array.from(
      { length: 7 },
      (_, idx) => `<tr class="tender-row"><td>Tender #${idx + 1}</td><td>Buyer ${idx + 1}</td></tr>`,
    ).join("");
    const html = `
      <html>
        <head>
          <style>.hidden { display: none; }</style>
          <script>window.__DATA__ = [1, 2, 3];</script>
        </head>
        <body>
          <!-- original comment -->
          <svg><path d="M0 0 L10 10"/></svg>
          <noscript>Enable JS</noscript>
          <table class="results"><tbody>${rows}</tbody></table>
          <a rel="next" href="?page=2">Next</a>
        </body>
      </html>
    `;

    const { compressed, structureSummary } = compressHtml(html);

    assert.equal(compressed.includes("<script"), false);
    assert.equal(compressed.includes("<style"), false);
    assert.equal(compressed.includes("<svg"), false);
    assert.equal(compressed.includes("<noscript"), false);
    assert.equal(compressed.includes("original comment"), false);
    assert.equal(compressed.includes("Tender #1"), true);
    assert.equal(compressed.includes("Tender #2"), true);
    assert.equal(compressed.includes("Tender #3"), false);
    assert.equal(compressed.includes("<!-- ...5 more similar items -->"), true);
    assert.match(structureSummary, /tables=1 \(rows=7\)/);
    assert.match(structureSummary, /pagination=/);
  });

  it("collapses repeated card divs and respects maxChars cap", () => {
    const cards = Array.from(
      { length: 6 },
      (_, idx) => `<div class="tender-card"><h3>Notice ${idx + 1}</h3><p>Details ${idx + 1}</p></div>`,
    ).join("");
    const html = `<main><section class="list">${cards}</section></main>`;

    const { compressed } = compressHtml(html, 220);

    assert.ok(compressed.length <= 220);
    assert.equal(compressed.includes("Notice 1"), true);
    assert.equal(compressed.includes("Notice 3"), false);
  });

  it("preserves both first tender item and bottom pagination under tight maxChars", () => {
    const filler = Array.from({ length: 12 }, (_, idx) => `<p>Summary paragraph ${idx + 1} with extra procurement metadata text</p>`).join("");
    const html = `
      <main>
        <div class="tender-item">First Tender Item Title</div>
        ${filler}
        <footer><nav class="pagination"><a rel="next" href="?page=2">Next Page</a></nav></footer>
      </main>
    `;

    const { compressed } = compressHtml(html, 260);

    assert.ok(compressed.length <= 260);
    assert.equal(compressed.includes("First Tender Item Title"), true);
    assert.equal(compressed.includes('rel="next"'), true);
    assert.equal(compressed.includes("middle truncated"), true);
  });
});

describe("compressJson", () => {
  it("truncates arrays to 2 items and summarizes top-level and item keys", () => {
    const payload = JSON.stringify({
      total: 50,
      page: 1,
      notices: Array.from({ length: 10 }, (_, idx) => ({
        id: `T-${idx + 1}`,
        title: `Bridge Repair ${idx + 1}`,
        deadline: "2026-12-01",
      })),
    });

    const { compressed, structureSummary } = compressJson(payload);

    assert.equal(compressed.includes("T-1"), true);
    assert.equal(compressed.includes("T-2"), true);
    assert.equal(compressed.includes("T-3"), false);
    assert.equal(compressed.includes("8 more items, total 10"), true);
    assert.match(structureSummary, /rootKeys=\[total, page, notices\]/);
    assert.match(structureSummary, /notices=Array\(10\)\[id, title, deadline\]/);
  });
});

describe("detectBlockInContent", () => {
  it("detects HTTP 401 and 403", () => {
    assert.match(detectBlockInContent("<html>Denied</html>", 401) ?? "", /401/);
    assert.match(detectBlockInContent("<html>Forbidden</html>", 403) ?? "", /403/);
  });

  it("detects password login forms and captcha widgets", () => {
    const loginHtml = '<form action="/auth"><input type="text" name="u"><input type="password" name="p"></form>';
    assert.match(detectBlockInContent(loginHtml, 200) ?? "", /login|password/i);

    const recaptchaHtml = '<div class="g-recaptcha" data-sitekey="abc"></div>';
    assert.match(detectBlockInContent(recaptchaHtml, 200) ?? "", /reCAPTCHA/i);

    const turnstileHtml = '<div class="cf-turnstile" data-sitekey="xyz"></div>';
    assert.match(detectBlockInContent(turnstileHtml, 200) ?? "", /Turnstile/i);
  });

  it("does not false-trigger on normal tender HTML with a header login link", () => {
    const normalHtml = `
      <html>
        <head><title>Public Tenders - Procurement Portal</title></head>
        <body>
          <header><a href="/login">Anmelden</a></header>
          <main>
            <table>
              <tr class="tender-row"><td>Road maintenance 2026</td><td>City of Munich</td></tr>
            </table>
          </main>
        </body>
      </html>
    `;

    assert.equal(detectBlockInContent(normalHtml, 200), null);
  });

  it("ignores header login forms and passive recaptcha when substantial tender list content exists", () => {
    const rows = Array.from(
      { length: 4 },
      (_, idx) => `<tr class="tender-row"><td>Tender #${idx + 1}</td><td>Buyer ${idx + 1}</td></tr>`,
    ).join("");

    const headerLoginHtml = `
      <html>
        <head><title>Open Tenders</title></head>
        <body>
          <header><form action="/login"><input type="password" name="pw"></form></header>
          <main><table><tbody>${rows}</tbody></table></main>
        </body>
      </html>
    `;
    assert.equal(detectBlockInContent(headerLoginHtml, 200, "https://portal.example.eu/tenders"), null);

    const passiveCaptchaHtml = `
      <html>
        <head><title>Open Tenders</title><script src="https://www.google.com/recaptcha/api.js"></script></head>
        <body>
          <div class="g-recaptcha" data-sitekey="abc"></div>
          <main><table><tbody>${rows}</tbody></table></main>
        </body>
      </html>
    `;
    assert.equal(detectBlockInContent(passiveCaptchaHtml, 200, "https://portal.example.eu/tenders"), null);
  });

  it("still flags login redirect URL with password input even when links exist", () => {
    const links = Array.from({ length: 6 }, (_, idx) => `<a href="/help/${idx}">Help link item ${idx}</a>`).join("");
    const loginRedirectHtml = `
      <html>
        <head><title>Sign in</title></head>
        <body>
          <form action="/login"><input type="password" name="password"></form>
          <main>${links}</main>
        </body>
      </html>
    `;

    assert.match(
      detectBlockInContent(loginRedirectHtml, 200, "https://portal.example.eu/login") ?? "",
      /login|password/i,
    );
  });
});

describe("classifyWithRules", () => {
  it("classifies blocked and unreachable snapshots", () => {
    const recipe = makeRecipe("html");

    const blocked = classifyWithRules(recipe, [], {
      kind: "blocked",
      reason: "HTTP 403 Forbidden",
      httpStatus: 403,
    });
    assert.equal(blocked.category, "blocked");

    const unreachable = classifyWithRules(recipe, [], {
      kind: "unreachable",
      reason: "HTTP 503",
      httpStatus: 503,
    });
    assert.equal(unreachable.category, "unreachable");
  });

  it("classifies url-moved on HTTP 404 or significant path redirect", () => {
    const recipe = makeRecipe("html");

    const notFound = classifyWithRules(recipe, [], makeOkSnapshot({ httpStatus: 404 }));
    assert.equal(notFound.category, "url-moved");
    assert.equal(notFound.redirectUrl, "https://tenders.example.eu/notices?page=1&size=20");

    const redirected = classifyWithRules(
      recipe,
      [],
      makeOkSnapshot({
        url: "https://tenders.example.eu/old/notices",
        finalUrl: "https://tenders.example.eu/v2/procurement/list",
      }),
    );
    assert.equal(redirected.category, "url-moved");
    assert.equal(redirected.redirectUrl, "https://tenders.example.eu/v2/procurement/list");
  });

  it("classifies selector-broken, json-key-renamed, pagination-changed, format-changed, golden-mismatch, and unknown", () => {
    const okSnapshot = makeOkSnapshot();
    const fail = (name: string, detail = "failed"): CheckResult => ({ name, ok: false, detail });

    assert.equal(
      classifyWithRules(makeRecipe("html"), [fail("items", "0 items")], okSnapshot).category,
      "selector-broken",
    );
    assert.equal(
      classifyWithRules(makeRecipe("browser"), [fail("fill:title", "0% filled")], okSnapshot).category,
      "selector-broken",
    );
    assert.equal(
      classifyWithRules(makeRecipe("jsonApi"), [fail("items", "0 items")], okSnapshot).category,
      "json-key-renamed",
    );
    assert.equal(
      classifyWithRules(makeRecipe("jsonApi"), [fail("fill:buyerName", "0%")], okSnapshot).category,
      "json-key-renamed",
    );
    assert.equal(
      classifyWithRules(makeRecipe("html"), [fail("count-drop", "dropped from 40 to 10")], okSnapshot).category,
      "pagination-changed",
    );
    assert.equal(
      classifyWithRules(makeRecipe("html"), [fail("dates", "unparseable dates")], okSnapshot).category,
      "format-changed",
    );
    assert.equal(
      classifyWithRules(makeRecipe("html"), [fail("cpv-codes", "invalid cpv")], okSnapshot).category,
      "format-changed",
    );
    assert.equal(
      classifyWithRules(makeRecipe("html"), [fail("golden-records", "title mismatch")], okSnapshot).category,
      "golden-mismatch",
    );
    assert.equal(
      classifyWithRules(makeRecipe("html"), [fail("custom-check", "unexpected")], okSnapshot).category,
      "unknown",
    );
  });
});

describe("triageBreakage", () => {
  it("makes 0 LLM calls when rules classify the breakage", async () => {
    const { ctx, llmCalls } = makeMockContext();
    const verdict: Verdict = {
      kind: "broken",
      reason: "0 items extracted",
      checks: [{ name: "items", ok: false, detail: "extracted 0 items" }],
    };

    const report = await triageBreakage(
      { recipe: makeRecipe("html"), verdict, snapshot: makeOkSnapshot() },
      ctx,
    );

    assert.equal(report.category, "selector-broken");
    assert.equal(llmCalls.length, 0);
  });

  it("makes 1 fast triage LLM call only when rules return unknown", async () => {
    const { ctx, llmCalls } = makeMockContext({
      llmResult: {
        category: "pagination-changed",
        reason: "Portal switched to cursor pagination.",
        hint: "Switch recipe pagination to nextLink.",
      },
    });
    const verdict: Verdict = {
      kind: "broken",
      reason: "unexpected anomaly",
      checks: [{ name: "skeleton-drift", ok: false, detail: "major DOM shift" }],
    };

    const report = await triageBreakage(
      { recipe: makeRecipe("html"), verdict, snapshot: makeOkSnapshot() },
      ctx,
    );

    assert.equal(llmCalls.length, 1);
    assert.deepEqual(llmCalls[0], { purpose: "triage", model: "fast" });
    assert.equal(report.category, "pagination-changed");
    assert.match(report.reason, /cursor pagination/);
  });

  it("degrades gracefully to unknown if the LLM call fails", async () => {
    const { ctx, llmCalls } = makeMockContext({
      llmError: new Error("LLM timeout"),
    });
    const verdict: Verdict = {
      kind: "broken",
      reason: "mystery failure",
      checks: [{ name: "mystery", ok: false, detail: "unclear" }],
    };

    const report = await triageBreakage(
      { recipe: makeRecipe("html"), verdict, snapshot: makeOkSnapshot() },
      ctx,
    );

    assert.equal(llmCalls.length, 1);
    assert.equal(report.category, "unknown");
  });
});

describe("capturePortalSnapshot", () => {
  it("substitutes URL placeholders and compresses JSON responses", async () => {
    const body = JSON.stringify({ items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    const { ctx, fetchedUrls } = makeMockContext({
      fetchResponse: new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    const outcome = await capturePortalSnapshot(makeRecipe("jsonApi"), ctx);

    assert.equal(fetchedUrls[0], "https://tenders.example.eu/notices?page=1&size=20");
    assert.equal(outcome.kind, "ok");
    if (outcome.kind === "ok") {
      assert.match(outcome.structureSummary, /items=Array\(3\)/);
      assert.equal(outcome.compressedContent.includes("1 more items, total 3"), true);
    }
  });

  it("classifies HTTP 500 as unreachable and respects aborted signal", async () => {
    const serverErr = makeMockContext({
      fetchResponse: new Response("Internal Server Error", { status: 500 }),
    });
    const unreachable = await capturePortalSnapshot(makeRecipe("html"), serverErr.ctx);
    assert.equal(unreachable.kind, "unreachable");

    const aborted = makeMockContext({ aborted: true });
    const abortedOutcome = await capturePortalSnapshot(makeRecipe("html"), aborted.ctx);
    assert.equal(abortedOutcome.kind, "unreachable");
    assert.equal(aborted.fetchedUrls.length, 0);
  });
});
