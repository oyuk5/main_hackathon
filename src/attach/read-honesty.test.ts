/**
 * Person A's requests for honest reads: a read must not look complete, clean or empty when it is not.
 * Local fake portal only; no model, no external network.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { clearDetailCache, extractor, readSample } from "./extractor.js";
import { judgeSample } from "./cartographer.js";
import type { ExtractedTender, PortalContext, ReadOutcome } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";

type Reply = { status?: number; body: string };
const routes = new Map<string, (u: URL) => Reply>();
let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", base);
    const r = routes.get(u.pathname)?.(u);
    res.writeHead(r ? (r.status ?? 200) : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(r ? r.body : "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  routes.clear();
  clearDetailCache();
});

function ctx(): PortalContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    portalId: "ph",
    url: `${base}/h/list`,
    http: { fetch: (u, init) => fetch(u, init) },
    browser: { withPage: () => Promise.reject(new Error("no browser")) },
    llm: { json: () => Promise.reject(new Error("no model in reads")) },
    log: (m) => void logs.push(m),
    signal: new AbortController().signal,
    logs,
  };
}

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const row = (id: string, title: string) => `<tr class="hit"><td class="nr">${id}</td><td><a href="/h/t/${id}">${title}</a></td><td class="frist">15.12.2026 10:00</td></tr>`;

function recipe(extra: Partial<Recipe> = {}): Recipe {
  return Recipe.parse({
    schemaVersion: 1,
    tier: "html",
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    list: { request: { url: `${base}/h/list?p={page}` }, pagination: { type: "pageParam", start: 1, maxPages: 5 }, item: "tr.hit", emptyText: ["Keine Ergebnisse"] },
    listFields: { id: { css: "td.nr" }, url: { css: "a", attr: "href" }, title: { css: "a" }, submissionDeadline: { css: "td.frist" } },
    ...extra,
  });
}

const listPages = (pages: string[][], later: Reply | null = null) =>
  routes.set("/h/list", (u) => {
    const p = Number(u.searchParams.get("p") ?? "1");
    if (p <= pages.length) return { body: page(`<table><tbody>${pages[p - 1]!.join("")}</tbody></table>`) };
    return later ?? { body: page("<table><tbody></tbody></table>") };
  });

// ------------------------------------------------------------ a failed later list page

test("a later list page that fails with 503 makes the read unreachable, not a shorter list", async () => {
  listPages([[row("A1", "Eins")]], { status: 503, body: "busy" });
  const out = await extractor.read(recipe(), ctx());
  assert.equal(out.kind, "unreachable", JSON.stringify(out));
  assert.match((out as { reason: string }).reason, /List page 2 answers 503 Service Unavailable, so this read is incomplete\./);
});

test("a later list page that answers 403 is an error (repair), not a shorter list", async () => {
  listPages([[row("A1", "Eins")]], { status: 403, body: "no" });
  const out = await extractor.read(recipe(), ctx());
  assert.equal(out.kind, "error");
});

test("a later list page that answers 404 is the end of the list", async () => {
  listPages([[row("A1", "Eins")], [row("A2", "Zwei")]], { status: 404, body: "not found" });
  const c = ctx();
  const out = await extractor.read(recipe(), c);
  assert.equal(out.kind, "ok", JSON.stringify(out));
  assert.deepEqual((out as Extract<ReadOutcome, { kind: "ok" }>).tenders.map((t) => t.id), ["A1", "A2"]);
  assert.ok(c.logs.some((l) => /end of the list/.test(l)));
});

// ------------------------------------------------------------ "no results" only outside page chrome

test("'no results' in the header or search box is not the list's empty state", async () => {
  routes.set("/h/list", () => ({ body: page('<header><div class="search">Keine Ergebnisse für Ihre letzte Suche</div></header><main><p>Liste wird geladen</p></main>') }));
  const out = await extractor.read(recipe(), ctx());
  assert.equal(out.kind, "ok");
  assert.equal((out as Extract<ReadOutcome, { kind: "ok" }>).diagnostics.emptyStateText, undefined);

  routes.set("/h/list", () => ({ body: page('<nav>Menü</nav><main><p>Keine Ergebnisse</p></main><footer>Impressum</footer>') }));
  const real = await extractor.read(recipe(), ctx());
  assert.equal((real as Extract<ReadOutcome, { kind: "ok" }>).diagnostics.emptyStateText, "Keine Ergebnisse");
});

// ------------------------------------------------------------ award notices

test("explicit award notices are left out before any detail request; award criteria are not", async () => {
  listPages([
    [
      row("A1", "Neubau Kita – Bekanntmachung vergebener Aufträge"),
      row("A2", "Straßenbau, Zuschlagskriterien siehe Unterlagen"),
      `<tr class="hit"><td class="nr">A3</td><td><a href="/h/t/A3">Reinigung</a></td><td class="frist">15.12.2026 10:00</td><td class="typ">Contract award notice</td></tr>`,
      row("A4", "Lieferung Fahrzeuge"),
    ],
  ]);
  let detailHits = 0;
  for (const id of ["A1", "A2", "A3", "A4"]) routes.set(`/h/t/${id}`, () => ((detailHits += 1), { body: page(`<p>${id}</p>`) }));
  const c = ctx();
  const out = await extractor.read(recipe({ detail: { urlFrom: "url", fields: {} } }), c);
  assert.equal(out.kind, "ok");
  assert.deepEqual((out as Extract<ReadOutcome, { kind: "ok" }>).tenders.map((t) => t.id), ["A2", "A4"]);
  assert.equal(detailHits, 2, "award notices cost no request");
  assert.ok(c.logs.some((l) => /Left out 2 award notices/.test(l)));
});

// ------------------------------------------------------------ documents rule that misses visible files

function tendersWithFiles(n: number) {
  listPages([Array.from({ length: n }, (_, i) => row(`D${i}`, `Ausschreibung ${i}`))]);
  for (let i = 0; i < n; i++)
    routes.set(`/h/t/D${i}`, () => ({
      body: page(`<header><a href="/hilfe.pdf">Hilfe</a></header><main><h1>Ausschreibung ${i}</h1><table class="docs"><tr><td><a class="dl" href="/h/files/D${i}/Leistungsverzeichnis.pdf">LV</a></td></tr></table></main><footer><a href="/agb.pdf">AGB</a></footer>`),
    }));
}

test("tender pages show files but the documents rule matches none: the read fails so it gets repaired", async () => {
  tendersWithFiles(4);
  const wrong = recipe({ documents: { hops: [], files: { css: "a.nope", attr: "href", all: true }, via: "http" } });
  const out = await extractor.read(wrong, ctx());
  assert.equal(out.kind, "error", JSON.stringify(out).slice(0, 300));
  assert.match((out as { reason: string }).reason, /Tender pages show file links, but the documents rule found none on 4 of 4 tenders/);

  clearDetailCache();
  const right = recipe({ documents: { hops: [], files: { css: "table.docs a.dl", attr: "href", all: true }, via: "http" } });
  const ok = await extractor.read(right, ctx());
  assert.equal(ok.kind, "ok");
  assert.equal((ok as Extract<ReadOutcome, { kind: "ok" }>).tenders[0]!.documentRefs.length, 1);
});

test("only site-wide files (help, terms) on tender pages are not a missed documents rule", async () => {
  listPages([Array.from({ length: 4 }, (_, i) => row(`S${i}`, `Ausschreibung ${i}`))]);
  for (let i = 0; i < 4; i++) routes.set(`/h/t/S${i}`, () => ({ body: page(`<main><h1>S${i}</h1><a href="/hilfe/anleitung.pdf">Anleitung</a></main>`) }));
  const out = await extractor.read(recipe({ documents: { hops: [], files: { css: "a.nope", attr: "href", all: true }, via: "http" } }), ctx());
  assert.equal(out.kind, "ok", "a tender page with only the site's help PDF has no own files");
});

test("dry-runs leave the documents check to the Cartographer (no error in readSample)", async () => {
  tendersWithFiles(4);
  const wrong = recipe({ documents: { hops: [], files: { css: "a.nope", attr: "href", all: true }, via: "http" } });
  const out = await readSample(wrong, ctx(), { maxPages: 1, maxItems: 4 });
  assert.equal(out.kind, "ok");
});

// ------------------------------------------------------------ deadline rule reading the publication date

test("judgeSample rejects a deadline rule that reads the publication date", () => {
  const t = (i: number, deadline: string): ExtractedTender => ({
    id: `T${i}`,
    url: `https://p.test/t/${i}`,
    title: `T${i}`,
    buyerName: "B",
    publicationDate: "2026-11-10",
    submissionDeadline: deadline,
    documentRefs: [{ url: `https://p.test/f/${i}.pdf`, via: "http" }],
  });
  const read = (ts: ExtractedTender[]): ReadOutcome => ({
    kind: "ok",
    tenders: ts,
    diagnostics: { requests: 1, listPages: 1, itemsSeen: ts.length, durationMs: 1, fieldFill: Object.fromEntries(["id", "url", "title", "buyerName", "publicationDate", "submissionDeadline"].map((f) => [f, { filled: ts.length, total: ts.length }])) },
  });
  const r = recipe({ listFields: { ...recipe().listFields, buyerName: { css: "x" }, publicationDate: { css: "y" } }, documents: { hops: [], files: { css: "a" }, via: "http" } });
  const same = judgeSample(r, read([1, 2, 3].map((i) => t(i, "2026-11-10T00:00:00+01:00"))), "https://p.test/list");
  assert.ok(same.errors.some((e) => /reads the publication date/.test(e)), JSON.stringify(same));
  const oneSameDay = judgeSample(r, read([t(1, "2026-11-10T12:00:00+01:00"), t(2, "2026-12-01T12:00:00+01:00"), t(3, "2026-12-05T12:00:00+01:00")]), "https://p.test/list");
  assert.ok(!oneSameDay.errors.some((e) => /reads the publication date/.test(e)), "one same-day deadline is fine");
});
