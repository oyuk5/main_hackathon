/**
 * Staged enrichment (A's request): one read does detail and document work for a bounded number of
 * tenders, newest first, marks the rest pending, and later reads enrich the next batch through the
 * detail cache. Local fake portal only; no model, no external network.
 */
import { after, afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { clearDetailCache, detailBudget, DETAIL_TIME_BUDGET_MS, extractor, MAX_DETAIL_FETCHES, readSample } from "./extractor.js";
import { evaluateRead } from "../watch/checks.js";
import type { PortalContext, ReadOutcome } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";

const N = 40;
/** Detail page requests per tender id. */
const hits = new Map<string, number>();
let onDetail: (() => void) | null = null;
let server: http.Server;
let base = "";

/** Tender i is published on day i: the list shows the oldest first, so newest-first is visible. */
const pub = (i: number) => {
  const d = new Date(Date.UTC(2026, 8, 1 + i));
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
};
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", base).pathname;
    let body: string | null = null;
    if (path === "/st/list") {
      const rows = Array.from({ length: N }, (_, i) =>
        `<tr class="hit"><td class="nr">S-${i}</td><td><a href="/st/t/${i}">Bau ${i}</a></td><td class="pub">${pub(i)}</td><td class="frist">15.12.2026 10:00</td></tr>`,
      ).join("");
      body = page(`<table><tbody>${rows}</tbody></table>`);
    }
    const m = /^\/st\/t\/(\d+)$/.exec(path);
    if (m) {
      hits.set(m[1]!, (hits.get(m[1]!) ?? 0) + 1);
      onDetail?.();
      body = page(`<h1>Bau ${m[1]}</h1><dl><dt>Auftraggeber</dt><dd class="buyer">Stadt ${m[1]}</dd><dt>Nr</dt><dd class="ref">VG-${m[1]}</dd></dl><a class="file" href="/st/f/${m[1]}.pdf">Unterlagen.pdf</a>`);
    }
    // A few milliseconds per detail page, so the time budget test has time to pass.
    setTimeout(() => {
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(body ?? "not found");
    }, m ? 3 : 0);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  hits.clear();
  onDetail = null;
  clearDetailCache();
});
afterEach(() => {
  detailBudget.tenders = MAX_DETAIL_FETCHES;
  detailBudget.ms = DETAIL_TIME_BUDGET_MS;
});

function ctx(controller = new AbortController()): PortalContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    portalId: "pstaged",
    url: `${base}/st/list`,
    http: { fetch: (u, init) => fetch(u, init) },
    browser: { withPage: () => Promise.reject(new Error("no browser")) },
    llm: { json: () => Promise.reject(new Error("no model in reads")) },
    log: (m) => void logs.push(m),
    signal: controller.signal,
    logs,
  };
}

const recipe = (): Recipe =>
  Recipe.parse({
    schemaVersion: 1,
    tier: "html",
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    list: { request: { url: `${base}/st/list` }, pagination: { type: "none" }, item: "tr.hit" },
    listFields: { id: { css: "td.nr" }, url: { css: "a", attr: "href" }, title: { css: "a" }, publicationDate: { css: "td.pub" }, submissionDeadline: { css: "td.frist" } },
    detail: { urlFrom: "url", fields: { buyerName: { css: "dd.buyer" }, referenceNumber: { css: "dd.ref" } } },
    documents: { hops: [], files: { css: "a.file", attr: "href", all: true }, via: "http" },
  });

function ok(r: ReadOutcome): Extract<ReadOutcome, { kind: "ok" }> {
  assert.equal(r.kind, "ok", JSON.stringify(r).slice(0, 300));
  return r as Extract<ReadOutcome, { kind: "ok" }>;
}
const enrichedIds = (r: Extract<ReadOutcome, { kind: "ok" }>) => r.tenders.filter((t) => !t.documentRefsPending).map((t) => t.id);

test("a read stops detail work at the budget, newest first, logs progress, and the next read enriches the rest", async () => {
  detailBudget.tenders = 30;
  const c = ctx();
  const first = ok(await extractor.read(recipe(), c));
  assert.equal(first.tenders.length, N);
  assert.deepEqual(first.tenders.map((t) => t.id), Array.from({ length: N }, (_, i) => `S-${i}`), "list order kept");
  assert.equal(hits.size, 30);
  // The 30 newest (S-10 … S-39) got their pages; the 10 oldest wait with list values only.
  assert.deepEqual(enrichedIds(first).sort(), Array.from({ length: 30 }, (_, i) => `S-${i + 10}`).sort());
  for (const t of first.tenders.slice(0, 10)) {
    assert.equal(t.documentRefsPending, true);
    assert.deepEqual(t.documentRefs, []);
    assert.equal(t.buyerName, null);
    assert.ok(t.title);
  }
  const done = first.tenders.find((t) => t.id === "S-39")!;
  assert.equal(done.buyerName, "Stadt 39");
  assert.equal(done.documentRefs.length, 1);
  assert.deepEqual(c.logs.filter((l) => l.startsWith("Read the pages")), [
    "Read the pages of 25 of 40 tenders so far.",
    "Read the pages of 30 of 40 tenders (30 in this read); the other 10 follow in the next reads.",
  ]);

  const c2 = ctx();
  const second = ok(await extractor.read(recipe(), c2));
  assert.equal(enrichedIds(second).length, N, "everything enriched after the second read");
  assert.ok([...hits.values()].every((n) => n === 1), "cached tenders cost no request");
  assert.ok(c2.logs.includes("Read the pages of all 40 tenders (10 in this read)."), c2.logs.join("\n"));
  assert.ok(!c2.logs.some((l) => /so far/.test(l)));

  // A third read is all cache: no detail request and no detail log.
  const c3 = ctx();
  ok(await extractor.read(recipe(), c3));
  assert.equal([...hits.values()].reduce((a, b) => a + b, 0), N);
  assert.ok(!c3.logs.some((l) => l.startsWith("Read the pages")));
});

test("fieldFill counts only enriched tenders, so a staged read does not look like a fill collapse", async () => {
  const full = ok(await extractor.read(recipe(), ctx()));
  assert.deepEqual(full.diagnostics.fieldFill.buyerName, { filled: N, total: N });
  const baseline = { lastGoodCount: N, lastGoodFieldFill: full.diagnostics.fieldFill, lastGoodSkeletonHash: full.diagnostics.listSkeletonHash ?? null, golden: [] };

  clearDetailCache();
  detailBudget.tenders = 5;
  const staged = ok(await extractor.read(recipe(), ctx()));
  assert.equal(staged.tenders.length, N);
  assert.equal(enrichedIds(staged).length, 5);
  assert.deepEqual(staged.diagnostics.fieldFill.buyerName, { filled: 5, total: 5 });
  assert.deepEqual(staged.diagnostics.fieldFill.title, { filled: 5, total: 5 });
  const verdict = evaluateRead(staged, baseline);
  assert.equal(verdict.kind, "healthy", JSON.stringify(verdict));
});

test("the time budget stops new detail work but always lets one tender through", async () => {
  detailBudget.ms = 1;
  const r = ok(await extractor.read(recipe(), ctx()));
  const n = enrichedIds(r).length;
  assert.ok(n >= 1 && n < N, `enriched ${n}`);
  assert.ok(enrichedIds(r).includes("S-39"), "the newest tender goes first");
});

test("a DELETE during detail work still cancels the read", async () => {
  const controller = new AbortController();
  onDetail = () => {
    if ([...hits.values()].reduce((a, b) => a + b, 0) >= 3) controller.abort();
  };
  const r = await extractor.read(recipe(), ctx(controller));
  assert.equal(r.kind, "error");
  assert.match((r as { reason: string }).reason, /cancelled/);
  assert.ok(hits.size <= 4, `detail requests after abort: ${hits.size}`);
});

test("a dry-run keeps list order, its own item limit and no staged logs", async () => {
  detailBudget.tenders = 1;
  const c = ctx();
  const r = ok(await readSample(recipe(), c, { maxPages: 1, maxItems: 3 }));
  assert.deepEqual(r.tenders.map((t) => t.id), ["S-0", "S-1", "S-2"]);
  assert.ok(r.tenders.every((t) => !t.documentRefsPending && t.buyerName));
  assert.ok(!c.logs.some((l) => l.startsWith("Read the pages")));
});
