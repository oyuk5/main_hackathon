import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Recipe } from "../shared/recipe.js";
import type {
  AttachOutcome,
  Baseline,
  ExtractedTender,
  PortalContext,
  ReadOutcome,
  Verdict,
} from "../shared/modules.js";
import { buildRepairSummary, summarizeRecipeChanges } from "./recipe-diff.js";
import { createMedic, type MedicDeps } from "./medic.js";
import type {
  GoldenVerificationResult,
  SnapshotOutcome,
  TriageReport,
} from "./types.js";

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    schemaVersion: 1,
    family: null,
    tier: "html",
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    list: {
      request: { url: "https://portal.example/tenders", method: "GET" },
      pagination: { type: "none" },
      item: "table.tenders tbody tr",
      emptyText: ["No tenders found"],
    },
    listFields: {
      id: { css: "td.id" },
      title: { css: "td.title" },
      url: { css: "td.title a", attr: "href", parse: "url" },
    },
    detail: null,
    documents: null,
    withdrawnText: [],
    ...overrides,
  };
}

function makeTender(id = "T-1"): ExtractedTender {
  return {
    id,
    title: "Road maintenance",
    url: `https://portal.example/tenders/${id}`,
    buyerName: "City Works",
    publicationDate: "2026-11-01",
    submissionDeadline: "2026-12-01T12:00:00+01:00",
    documentRefs: [],
  };
}

function makeOkRead(tenders: ExtractedTender[] = [makeTender()]): Extract<ReadOutcome, { kind: "ok" }> {
  return {
    kind: "ok",
    tenders,
    diagnostics: {
      requests: 1,
      listPages: 1,
      itemsSeen: tenders.length,
      fieldFill: { title: { filled: tenders.length, total: tenders.length } },
      durationMs: 120,
    },
  };
}

function makeBaseline(goldenCount = 1): Baseline {
  const golden = Array.from({ length: goldenCount }, (_, i) => ({
    id: `T-${i + 1}`,
    fields: { title: "Road maintenance" },
  }));
  return {
    lastGoodCount: 5,
    lastGoodFieldFill: { title: { filled: 5, total: 5 } },
    lastGoodSkeletonHash: "abc123",
    golden,
  };
}

function makeBrokenVerdict(): Verdict {
  return {
    kind: "broken",
    reason: "Item count dropped to zero",
    checks: [{ name: "count-drop", ok: false, detail: "0 items vs baseline 5" }],
  };
}

function makeOkSnapshot(): SnapshotOutcome {
  return {
    kind: "ok",
    url: "https://portal.example/tenders",
    finalUrl: "https://portal.example/tenders",
    httpStatus: 200,
    contentType: "text/html",
    compressedContent: "<div class='card'><h3>Road maintenance</h3></div>",
    structureSummary: "div.card (5 items)",
  };
}

function makeTriageReport(overrides: Partial<TriageReport> = {}): TriageReport {
  return {
    category: "selector-broken",
    reason: "List selector matched 0 items",
    hint: "Rows moved to div.card elements",
    failedChecks: [{ name: "count-drop", ok: false, detail: "0 items vs baseline 5" }],
    snapshot: makeOkSnapshot(),
    ...overrides,
  };
}

function makeContext(opts: {
  llmHandler?: (input: { purpose: string; model: string; system: string; user: string }) => Promise<unknown>;
  controller?: AbortController;
} = {}): { ctx: PortalContext; logs: Array<{ message: string; level?: string }>; llmCalls: Array<{ purpose: string; model: string; user: string }> } {
  const logs: Array<{ message: string; level?: string }> = [];
  const llmCalls: Array<{ purpose: string; model: string; user: string }> = [];
  const controller = opts.controller ?? new AbortController();

  const ctx: PortalContext = {
    portalId: "portal-1",
    url: "https://portal.example/tenders",
    http: {
      async fetch() {
        throw new Error("http.fetch should not be called directly in medic unit tests");
      },
    },
    browser: {
      async withPage() {
        throw new Error("browser.withPage should not be called directly in medic unit tests");
      },
    },
    llm: {
      async json(callOpts) {
        llmCalls.push({ purpose: callOpts.purpose, model: callOpts.model, user: callOpts.user });
        if (!opts.llmHandler) {
          throw new Error("Unexpected LLM call");
        }
        const raw = await opts.llmHandler(callOpts);
        return callOpts.schema.parse(raw);
      },
    },
    log(message, level) {
      logs.push({ message, level });
    },
    signal: controller.signal,
  };
  return { ctx, logs, llmCalls };
}

function makeDeps(overrides: Partial<MedicDeps> = {}): MedicDeps {
  return {
    extractor: {
      async read() {
        return makeOkRead();
      },
    },
    cartographer: {
      async attach(): Promise<AttachOutcome> {
        return { kind: "failed", reason: "Fresh attach failed" };
      },
    },
    evaluate: () => ({ kind: "healthy", reason: "All checks passed", checks: [] }),
    verifyGolden: (_tenders, golden): GoldenVerificationResult => ({
      checked: golden.length,
      matched: golden.length,
      mismatches: [],
    }),
    captureSnapshot: async () => makeOkSnapshot(),
    triage: async () => makeTriageReport(),
    ...overrides,
  };
}

describe("recipe-diff", () => {
  it("summarizes list selector and field rule changes", () => {
    const before = makeRecipe();
    const after = makeRecipe({
      list: { ...before.list, item: "div.card" },
      listFields: {
        id: { css: ".card-id" },
        title: { css: "h3.card-title" },
        url: { css: "a.card-link", attr: "href", parse: "url" },
      },
    });
    assert.equal(summarizeRecipeChanges(before, after), "updated list selector and 3 field rules");
  });

  it("summarizes URL, pagination, tier, detail fields, and documents changes", () => {
    const before = makeRecipe();
    const after = makeRecipe({
      tier: "jsonApi",
      list: {
        ...before.list,
        request: { url: "https://portal.example/api/v2/tenders", method: "GET" },
        pagination: { type: "pageParam", start: 1, maxPages: 20 },
      },
      detail: {
        urlFrom: "url",
        fields: { buyerName: { css: ".buyer" } },
      },
      documents: {
        hops: [],
        files: { css: "a.doc", attr: "href" },
        via: "http",
      },
    });
    assert.equal(
      summarizeRecipeChanges(before, after),
      "updated tier (html to jsonApi), list URL, pagination, 1 detail field rule, and document rules",
    );
  });

  it("returns no recipe changes when recipes are identical", () => {
    const recipe = makeRecipe();
    assert.equal(summarizeRecipeChanges(recipe, makeRecipe()), "no recipe changes");
  });

  it("builds a single plain-English sentence with golden clause", () => {
    const before = makeRecipe();
    const after = makeRecipe({
      list: { ...before.list, item: "div.card" },
      listFields: { ...before.listFields, title: { css: "h3" } },
    });
    const summary = buildRepairSummary({
      llmNote: "List moved from table rows to cards.",
      before,
      after,
      golden: { checked: 5, matched: 5, mismatches: [] },
    });
    assert.equal(
      summary,
      "List moved from table rows to cards; updated list selector and 1 field rule; 5 of 5 known tenders match.",
    );
  });

  it("omits the golden clause when golden.checked is 0", () => {
    const before = makeRecipe();
    const after = makeRecipe({
      list: {
        ...before.list,
        request: { url: "https://portal.example/v2/tenders", method: "GET" },
      },
    });
    const summary = buildRepairSummary({
      llmNote: "Portal moved to /v2/tenders",
      before,
      after,
      golden: { checked: 0, matched: 0, mismatches: [] },
    });
    assert.equal(summary, "Portal moved to /v2/tenders; updated list URL.");
  });
});

describe("createMedic", () => {
  it("returns failed with 0 LLM calls when triage classifies portal as blocked", async () => {
    const { ctx, llmCalls } = makeContext();
    const medic = createMedic(
      makeDeps({
        triage: async () =>
          makeTriageReport({
            category: "blocked",
            reason: "Cloudflare captcha is blocking access.",
            snapshot: { kind: "blocked", reason: "Captcha detected", httpStatus: 403 },
          }),
      }),
    );

    const outcome = await medic.repair(
      { recipe: makeRecipe(), verdict: makeBrokenVerdict(), baseline: makeBaseline() },
      ctx,
    );

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.reason, "Cloudflare captcha is blocking access.");
    assert.equal(llmCalls.length, 0);
  });

  it("returns failed with 0 LLM calls when triage classifies portal as unreachable", async () => {
    const { ctx, llmCalls } = makeContext();
    const medic = createMedic(
      makeDeps({
        triage: async () =>
          makeTriageReport({
            category: "unreachable",
            reason: "Portal returned HTTP 503.",
            snapshot: { kind: "unreachable", reason: "HTTP 503", httpStatus: 503 },
          }),
      }),
    );

    const outcome = await medic.repair(
      { recipe: makeRecipe(), verdict: makeBrokenVerdict(), baseline: makeBaseline() },
      ctx,
    );

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.reason, "Portal returned HTTP 503.");
    assert.equal(llmCalls.length, 0);
  });

  it("retries a patch that loses files or matches no known tender, and tells the model why", async () => {
    const before = makeRecipe();
    const patched = makeRecipe({ list: { ...before.list, item: "div.card" } });
    const { ctx, llmCalls } = makeContext({
      llmHandler: async () => ({ recipe: patched, changeNote: "List moved to cards" }),
    });
    const withFiles = { ...makeTender(), documentRefs: [{ url: "https://portal.example/a.pdf", via: "http" as const }] };
    const reads = [makeOkRead([withFiles]), makeOkRead([makeTender("X-9")]), makeOkRead([{ ...withFiles, documentRefs: [...withFiles.documentRefs, { url: "https://portal.example/b.pdf", via: "http" }] }])];
    const golden: GoldenVerificationResult[] = [
      { checked: 1, matched: 1, mismatches: [] },
      { checked: 0, matched: 0, mismatches: [] },
      { checked: 1, matched: 1, mismatches: [] },
    ];
    const medic = createMedic(
      makeDeps({
        extractor: { read: async () => reads.shift()! },
        verifyGolden: () => golden.shift()!,
      }),
    );
    const baseline = { ...makeBaseline(1), publishedDocumentCounts: { "T-1": 2 } };

    const outcome = await medic.repair({ recipe: before, verdict: makeBrokenVerdict(), baseline }, ctx);

    assert.equal(outcome.kind, "ok");
    assert.equal(llmCalls.length, 3);
    assert.match(llmCalls[1]!.user, /T-1: 1 of 2 previously delivered files/);
    assert.match(llmCalls[2]!.user, /None of the known \(golden\) tenders/);
  });

  it("shows the known tender and its linked document page in a minimal repair prompt", async () => {
    const before = makeRecipe({ documents: { hops: [], files: { css: "a.plik", attr: "href" }, via: "http" } });
    const { ctx, llmCalls } = makeContext({ llmHandler: async () => ({ recipe: before, changeNote: "Kept the list" }) });
    const urls: string[] = [];
    ctx.http.fetch = async (url) => {
      urls.push(url);
      const body = url.endsWith("/docs") ? '<a class="pobierz" href="file.zip">Download</a>' : '<table class="dane"></table><a class="zalaczniki-link" href="/docs">Dokumentacja</a>';
      return new Response(body, { headers: { "content-type": "text/html" } });
    };
    const baseline = makeBaseline(1);
    baseline.golden[0]!.fields.url = "https://portal.example/tender/1";
    const outcome = await createMedic(makeDeps()).repair({ recipe: before, verdict: makeBrokenVerdict(), baseline }, ctx);
    assert.equal(outcome.kind, "ok");
    assert.deepEqual(urls, ["https://portal.example/tender/1", "https://portal.example/docs"]);
    assert.match(llmCalls[0]!.user, /Known tender detail page[\s\S]*zalaczniki-link[\s\S]*Linked tender documents page[\s\S]*pobierz/);
  });

  it("returns ok with 1-sentence summary when first patch passes evaluate and golden check", async () => {
    const before = makeRecipe();
    const patched = makeRecipe({ list: { ...before.list, item: "div.card" } });
    const { ctx, llmCalls, logs } = makeContext({
      llmHandler: async () => ({
        recipe: patched,
        changeNote: "List moved from table rows to cards",
      }),
    });
    const medic = createMedic(makeDeps());

    const outcome = await medic.repair(
      { recipe: before, verdict: makeBrokenVerdict(), baseline: makeBaseline(2) },
      ctx,
    );

    assert.equal(outcome.kind, "ok");
    assert.equal(llmCalls.length, 1);
    assert.equal(llmCalls[0]?.purpose, "repair");
    assert.equal(llmCalls[0]?.model, "smart");
    assert.equal(outcome.recipe.list.item, "div.card");
    assert.equal(
      outcome.summary,
      "List moved from table rows to cards; updated list selector; 2 of 2 known tenders match.",
    );
    assert.ok(logs.some((l) => l.message === outcome.summary));
  });

  it("feeds golden mismatch feedback from attempt 1 into attempt 2 and succeeds", async () => {
    const before = makeRecipe();
    const badPatch = makeRecipe({ list: { ...before.list, item: "div.wrong" } });
    const goodPatch = makeRecipe({ list: { ...before.list, item: "div.card" } });
    let attempt = 0;

    const { ctx, llmCalls } = makeContext({
      llmHandler: async () => {
        attempt += 1;
        return attempt === 1
          ? { recipe: badPatch, changeNote: "Tried div.wrong" }
          : { recipe: goodPatch, changeNote: "Switched to div.card" };
      },
    });

    const medic = createMedic(
      makeDeps({
        verifyGolden: (_tenders, golden) =>
          attempt === 1
            ? { checked: golden.length, matched: 0, mismatches: ["T-1 title mismatch"] }
            : { checked: golden.length, matched: golden.length, mismatches: [] },
      }),
    );

    const outcome = await medic.repair(
      { recipe: before, verdict: makeBrokenVerdict(), baseline: makeBaseline(1) },
      ctx,
    );

    assert.equal(outcome.kind, "ok");
    assert.equal(llmCalls.length, 2);
    assert.match(llmCalls[1]?.user ?? "", /T-1 title mismatch/);
    assert.equal(outcome.recipe.list.item, "div.card");
  });

  it("recovers gracefully when an LLM attempt throws an error", async () => {
    const before = makeRecipe();
    const goodPatch = makeRecipe({ list: { ...before.list, item: "div.card" } });
    let attempt = 0;

    const { ctx, llmCalls, logs } = makeContext({
      llmHandler: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Rate limit exceeded");
        return { recipe: goodPatch, changeNote: "Switched to div.card" };
      },
    });

    const medic = createMedic(makeDeps());
    const outcome = await medic.repair(
      { recipe: before, verdict: makeBrokenVerdict(), baseline: makeBaseline(1) },
      ctx,
    );

    assert.equal(outcome.kind, "ok");
    assert.equal(llmCalls.length, 2);
    assert.ok(logs.some((l) => l.level === "warn"));
    assert.ok(logs.every((l) => !/Rate limit exceeded|Repair model error/i.test(l.message)));
  });

  it("stops immediately when verification detects portal is blocked", async () => {
    const before = makeRecipe();
    let attachCalled = false;
    const { ctx, llmCalls } = makeContext({
      llmHandler: async () => ({
        recipe: makeRecipe({ list: { ...before.list, item: "div.card" } }),
        changeNote: "Updated selector",
      }),
    });

    const medic = createMedic(
      makeDeps({
        evaluate: () => ({ kind: "blocked", reason: "Login wall appeared during verification." }),
        cartographer: {
          async attach() {
            attachCalled = true;
            return { kind: "failed", reason: "Should not be called" };
          },
        },
      }),
    );

    const outcome = await medic.repair(
      { recipe: before, verdict: makeBrokenVerdict(), baseline: makeBaseline() },
      ctx,
    );

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.reason, "Login wall appeared during verification.");
    assert.equal(llmCalls.length, 1);
    assert.equal(attachCalled, false);
  });

  it("falls back to cartographer.attach after 3 failed patches and succeeds", async () => {
    const before = makeRecipe();
    const attachedRecipe = makeRecipe({
      tier: "jsonApi",
      list: {
        ...before.list,
        request: { url: "https://portal.example/api/tenders", method: "GET" },
        item: "$.items[*]",
      },
    });
    let attachCalls = 0;

    const { ctx, llmCalls } = makeContext({
      llmHandler: async () => ({
        recipe: makeRecipe({ list: { ...before.list, item: "div.bad" } }),
        changeNote: "Attempted selector fix",
      }),
    });

    const medic = createMedic(
      makeDeps({
        evaluate: (read) =>
          read.kind === "ok" && read.tenders.length > 0
            ? { kind: "healthy", reason: "OK", checks: [] }
            : { kind: "broken", reason: "Still 0 items", checks: [] },
        extractor: {
          async read() {
            return makeOkRead([]);
          },
        },
        cartographer: {
          async attach() {
            attachCalls += 1;
            return {
              kind: "ok",
              recipe: attachedRecipe,
              golden: [],
              read: makeOkRead([makeTender("T-1")]),
              note: "Switched to portal JSON API",
            };
          },
        },
      }),
    );

    const outcome = await medic.repair(
      { recipe: before, verdict: makeBrokenVerdict(), baseline: makeBaseline(1) },
      ctx,
    );

    assert.equal(outcome.kind, "ok");
    assert.equal(llmCalls.length, 3);
    assert.equal(attachCalls, 1);
    assert.equal(outcome.recipe.tier, "jsonApi");
    assert.match(outcome.summary, /Switched to portal JSON API/);
  });

  it("returns failed with clear reason when all 3 patches and fallback attach fail", async () => {
    const before = makeRecipe();
    let attachCalls = 0;

    const { ctx, llmCalls } = makeContext({
      llmHandler: async () => ({
        recipe: before,
        changeNote: "No change",
      }),
    });

    const medic = createMedic(
      makeDeps({
        evaluate: () => ({
          kind: "broken",
          reason: "No items extracted",
          checks: [{ name: "count-drop", ok: false, detail: "0 items" }],
        }),
        cartographer: {
          async attach() {
            attachCalls += 1;
            return { kind: "failed", reason: "Could not locate tender list on portal" };
          },
        },
      }),
    );

    const outcome = await medic.repair(
      { recipe: before, verdict: makeBrokenVerdict(), baseline: makeBaseline() },
      ctx,
    );

    assert.equal(outcome.kind, "failed");
    assert.equal(llmCalls.length, 3);
    assert.equal(attachCalls, 1);
    assert.equal(outcome.reason, "Could not locate tender list on portal.");
  });

  it("aborts cleanly without extra LLM calls when AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let snapshotCalled = false;
    const { ctx, llmCalls } = makeContext({ controller });

    const medic = createMedic(
      makeDeps({
        captureSnapshot: async () => {
          snapshotCalled = true;
          return makeOkSnapshot();
        },
      }),
    );

    const outcome = await medic.repair(
      { recipe: makeRecipe(), verdict: makeBrokenVerdict(), baseline: makeBaseline() },
      ctx,
    );

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.reason, "Repair stopped.");
    assert.equal(snapshotCalled, false);
    assert.equal(llmCalls.length, 0);
  });

  it("aborts cleanly mid-loop without extra LLM calls or fallback attach", async () => {
    const controller = new AbortController();
    let attachCalled = false;
    const { ctx, llmCalls } = makeContext({
      controller,
      llmHandler: async () => {
        controller.abort();
        return { recipe: makeRecipe(), changeNote: "Attempt 1" };
      },
    });

    const medic = createMedic(
      makeDeps({
        cartographer: {
          async attach() {
            attachCalled = true;
            return { kind: "failed", reason: "Should not run" };
          },
        },
      }),
    );

    const outcome = await medic.repair(
      { recipe: makeRecipe(), verdict: makeBrokenVerdict(), baseline: makeBaseline() },
      ctx,
    );

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.reason, "Repair stopped.");
    assert.equal(llmCalls.length, 1);
    assert.equal(attachCalled, false);
  });

  it("includes prior attempt diff and sample extracted tenders in retry prompt", async () => {
    const before = makeRecipe();
    const attempt1Recipe = makeRecipe({ list: { ...before.list, item: "div.wrong-card" } });
    const attempt2Recipe = makeRecipe({ list: { ...before.list, item: "div.good-card" } });
    let callCount = 0;

    const { ctx, llmCalls } = makeContext({
      llmHandler: async () => {
        callCount += 1;
        return callCount === 1
          ? { recipe: attempt1Recipe, changeNote: "Tried div.wrong-card" }
          : { recipe: attempt2Recipe, changeNote: "Switched to div.good-card" };
      },
    });

    const medic = createMedic(
      makeDeps({
        extractor: {
          async read(recipe) {
            if (recipe.list.item === "div.wrong-card") {
              return makeOkRead([
                {
                  ...makeTender("BAD-1"),
                  title: "Extracted wrong sample title",
                },
              ]);
            }
            return makeOkRead([makeTender("T-1")]);
          },
        },
        evaluate: (read) =>
          read.kind === "ok" && read.tenders[0]?.id === "T-1"
            ? { kind: "healthy", reason: "OK", checks: [] }
            : { kind: "broken", reason: "Wrong title", checks: [{ name: "golden-records", ok: false, detail: "mismatch" }] },
        verifyGolden: (tenders) =>
          tenders[0]?.id === "T-1"
            ? { checked: 1, matched: 1, mismatches: [] }
            : { checked: 1, matched: 0, mismatches: ["T-1 missing"] },
      }),
    );

    const outcome = await medic.repair(
      { recipe: before, verdict: makeBrokenVerdict(), baseline: makeBaseline(1) },
      ctx,
    );

    assert.equal(outcome.kind, "ok");
    assert.equal(llmCalls.length, 2);
    const secondPrompt = llmCalls[1]?.user ?? "";
    assert.match(secondPrompt, /Attempt 1 \(updated list selector\)/);
    assert.match(secondPrompt, /Extracted wrong sample title/);
    assert.match(secondPrompt, /BAD-1/);
  });

  it("includes capturedApiUrls from snapshot in the repair prompt", async () => {
    const before = makeRecipe({ tier: "jsonApi" });
    const goodPatch = makeRecipe({
      tier: "jsonApi",
      list: {
        ...before.list,
        request: { url: "https://portal.example/api/v2/notices", method: "GET" },
      },
    });
    const snapshot: SnapshotOutcome = {
      kind: "ok",
      url: "https://portal.example/api/v1/notices",
      finalUrl: "https://portal.example/api/v1/notices",
      httpStatus: 404,
      contentType: "application/json",
      compressedContent: '{"error":"Not found"}',
      structureSummary: "rootKeys=[error]",
      capturedApiUrls: ["https://portal.example/api/v2/notices"],
    };

    const { ctx, llmCalls } = makeContext({
      llmHandler: async () => ({ recipe: goodPatch, changeNote: "Updated API endpoint to v2" }),
    });

    const medic = createMedic(
      makeDeps({
        captureSnapshot: async () => snapshot,
        triage: async () => makeTriageReport({ category: "url-moved", snapshot }),
      }),
    );

    const outcome = await medic.repair(
      { recipe: before, verdict: makeBrokenVerdict(), baseline: makeBaseline(1) },
      ctx,
    );

    assert.equal(outcome.kind, "ok");
    assert.match(llmCalls[0]?.user ?? "", /Discovered JSON API URLs:/);
    assert.match(llmCalls[0]?.user ?? "", /https:\/\/portal\.example\/api\/v2\/notices/);
  });

  it("never leaks raw JS errors, golden mismatch, snapshot status, or check names into operator reason or logs", async () => {
    const { ctx, logs } = makeContext({
      llmHandler: async () => {
        throw new Error("RAW_SOCKET_ERR: connect ECONNRESET 10.0.0.5:443");
      },
    });

    const medic = createMedic(
      makeDeps({
        cartographer: {
          async attach() {
            throw new TypeError("Cannot read properties of undefined (reading 'selector')\n    at attach (/app/src/attach/index.ts:12)");
          },
        },
      }),
    );

    const outcome = await medic.repair(
      { recipe: makeRecipe(), verdict: makeBrokenVerdict(), baseline: makeBaseline() },
      ctx,
    );

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.reason, "Could not repair the portal after 3 attempts and a fresh reconnect.");
    assert.equal(
      /RAW_SOCKET_ERR|ECONNRESET|TypeError|Cannot read|attach\.ts|golden mismatch|snapshot status|repair model error|fresh attach failed/i.test(
        outcome.reason,
      ),
      false,
    );
    assert.ok(logs.some((l) => l.message.startsWith("Diagnosed issue:")));
    assert.ok(logs.some((l) => l.message === "Targeted fixes did not pass verification; trying a fresh reconnect."));
    for (const entry of logs) {
      assert.equal(
        /RAW_SOCKET_ERR|ECONNRESET|TypeError|Cannot read|attach\.ts|golden mismatch|snapshot status|repair model error|fresh attach failed|selector-broken:/i.test(
          entry.message,
        ),
        false,
      );
    }
  });

  it("reports plain-English reason when attached portal fails known tender verification", async () => {
    const before = makeRecipe();
    const { ctx, logs } = makeContext({
      llmHandler: async () => ({ recipe: before, changeNote: "No change" }),
    });

    const medic = createMedic(
      makeDeps({
        evaluate: (read) =>
          read.kind === "ok" && read.tenders.length > 0
            ? { kind: "healthy", reason: "OK", checks: [] }
            : { kind: "broken", reason: "No tenders found on the list.", checks: [{ name: "item-count", ok: false, detail: "No tenders found on the list." }] },
        extractor: {
          async read() {
            return makeOkRead([]);
          },
        },
        verifyGolden: () => ({ checked: 2, matched: 1, mismatches: ['Known tender "T-2" title changed.'] }),
        cartographer: {
          async attach() {
            return {
              kind: "ok",
              recipe: before,
              golden: [],
              read: makeOkRead([makeTender("T-1")]),
              note: "Rebuilt recipe",
            };
          },
        },
      }),
    );

    const outcome = await medic.repair(
      { recipe: before, verdict: makeBrokenVerdict(), baseline: makeBaseline(2) },
      ctx,
    );

    assert.equal(outcome.kind, "failed");
    assert.equal(outcome.reason, "Only 1 of 2 known tenders matched after repair.");
    assert.equal(/golden mismatch|snapshot status/i.test(outcome.reason), false);
    assert.ok(logs.every((l) => !/golden mismatch|snapshot status|item-count:/i.test(l.message)));
  });

  it("uses Portal check failed instead of Snapshot status in repair prompt when snapshot is not ok", async () => {
    const before = makeRecipe();
    const goodPatch = makeRecipe({ list: { ...before.list, item: "div.card" } });
    const { ctx, llmCalls } = makeContext({
      llmHandler: async () => ({ recipe: goodPatch, changeNote: "Updated selector" }),
    });

    const medic = createMedic(
      makeDeps({
        triage: async () =>
          makeTriageReport({
            category: "unknown",
            snapshot: { kind: "unreachable", reason: "The portal timed out while loading." },
          }),
      }),
    );

    const outcome = await medic.repair(
      { recipe: before, verdict: makeBrokenVerdict(), baseline: makeBaseline(1) },
      ctx,
    );

    assert.equal(outcome.kind, "ok");
    assert.match(llmCalls[0]?.user ?? "", /Portal check failed: The portal timed out while loading\./);
    assert.equal(/Snapshot status:/i.test(llmCalls[0]?.user ?? ""), false);
  });

  it("rejects a patch that clears list.item or listFields when returning 0 tenders", async () => {
    const before = makeRecipe();
    const destructive = makeRecipe({
      list: { ...before.list, item: "", emptyText: ["No tenders today"] },
      listFields: {},
      documents: null,
    });
    const repaired = makeRecipe({
      list: { ...before.list, emptyText: ["No tenders found", "No tenders today"] },
    });
    let attempt = 0;
    const { ctx, llmCalls } = makeContext({
      llmHandler: async () => {
        attempt += 1;
        return attempt === 1
          ? { recipe: destructive, changeNote: "Cleared list selectors for empty page" }
          : { recipe: repaired, changeNote: "Preserved selectors and added empty-day phrase" };
      },
    });

    const medic = createMedic(
      makeDeps({
        extractor: {
          async read() {
            return makeOkRead([]);
          },
        },
        evaluate: () => ({ kind: "healthy", reason: "Portal says no tenders today.", checks: [] }),
        verifyGolden: () => ({ checked: 0, matched: 0, mismatches: [] }),
      }),
    );

    const outcome = await medic.repair(
      { recipe: before, verdict: makeBrokenVerdict(), baseline: makeBaseline(1) },
      ctx,
    );

    assert.equal(outcome.kind, "ok");
    if (outcome.kind === "ok") {
      assert.equal(outcome.recipe.list.item, before.list.item);
      assert.ok(Object.keys(outcome.recipe.listFields).length > 0);
    }
    assert.equal(llmCalls.length, 2);
    assert.match(llmCalls[1]?.user ?? "", /Do not clear list\.item/i);
  });
});
