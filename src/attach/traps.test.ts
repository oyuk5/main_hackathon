/**
 * The brief's traps and the rules Patterno judges: local-time deadlines across DST, summary pages,
 * legacy encodings, captchas that don't block, zero model calls on regular reads, and cancellation.
 * Known bugs are kept as `todo` tests so the suite stays green.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extractor, clearDetailCache } from "./extractor.js";
import { cartographer } from "./index.js";
import { registerKnownRecipe } from "./known.js";
import { parseDateTime, mapProcedureType } from "./normalize.js";
import type { PortalContext, ReadOutcome } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";
import { Tender } from "../shared/contract.js";
import { nowWithOffset } from "../shared/time.js";

// ------------------------------------------------------------ fake portal

type Reply = { status?: number; type?: string; body: string | Buffer; delayMs?: number };
const routes = new Map<string, (url: URL) => Reply>();
const served: string[] = [];
let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    served.push(url.pathname);
    const route = routes.get(url.pathname);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const r = route(url);
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(r.status ?? 200, { "content-type": r.type ?? "text/html; charset=utf-8" });
      res.end(r.body);
    };
    if (r.delayMs) setTimeout(send, r.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  routes.clear();
  served.length = 0;
  clearDetailCache();
});

interface Spy {
  llm: number;
  browser: number;
  fetches: string[];
  logs: string[];
}

function makeCtx(opts: { url?: string; signal?: AbortSignal; onFetch?: (url: string, n: number) => void; dropSignal?: boolean } = {}): PortalContext & { spy: Spy } {
  const spy: Spy = { llm: 0, browser: 0, fetches: [], logs: [] };
  return {
    portalId: "traps",
    url: opts.url ?? base + "/",
    http: {
      fetch(url, init) {
        spy.fetches.push(url);
        opts.onFetch?.(url, spy.fetches.length);
        // dropSignal: a polite layer that swaps in its own signal must not keep the read alive after abort.
        if (opts.dropSignal) {
          const { signal: _s, ...rest } = init ?? {};
          return fetch(url, rest);
        }
        return fetch(url, init);
      },
    },
    browser: {
      withPage() {
        spy.browser += 1;
        throw new Error("browser must not be used");
      },
    },
    llm: {
      json() {
        spy.llm += 1;
        throw new Error("LLM must not be called");
      },
    },
    log: (m) => void spy.logs.push(m),
    signal: opts.signal ?? new AbortController().signal,
    spy,
  };
}

function recipe(partial: Partial<Recipe> & Pick<Recipe, "list" | "listFields">): Recipe {
  return { schemaVersion: 1, family: null, tier: "html", timeZone: "Europe/Berlin", countryCode: "DE", detail: null, documents: null, withdrawnText: [], ...partial };
}

function ok(r: ReadOutcome): Extract<ReadOutcome, { kind: "ok" }> {
  assert.equal(r.kind, "ok", JSON.stringify(r));
  return r as Extract<ReadOutcome, { kind: "ok" }>;
}

function assertContract(t: Extract<ReadOutcome, { kind: "ok" }>["tenders"][number]): void {
  const { documentRefs: _d, withdrawn, ...rest } = t;
  const r = Tender.safeParse({ ...rest, status: withdrawn ? "withdrawn" : "open", documents: [], lastChangedAt: nowWithOffset() });
  assert.ok(r.success, r.success ? "" : JSON.stringify(r.error.issues));
}

const page = (body: string, head = "") => `<!doctype html><html><head>${head}<title>Portal</title></head><body>${body}</body></html>`;

// ------------------------------------------------------------ 2a. local time across DST

const ZONES: { zone: string; winter: string; summer: string }[] = [
  { zone: "Europe/Berlin", winter: "+01:00", summer: "+02:00" },
  { zone: "Europe/Paris", winter: "+01:00", summer: "+02:00" },
  { zone: "Europe/Madrid", winter: "+01:00", summer: "+02:00" },
  { zone: "Europe/Warsaw", winter: "+01:00", summer: "+02:00" },
  { zone: "Europe/Amsterdam", winter: "+01:00", summer: "+02:00" },
  { zone: "Europe/Lisbon", winter: "+00:00", summer: "+01:00" },
];

// 2026: summer time starts Sun 29 March, ends Sun 25 October (01:00 UTC everywhere in the EU).
const DST_ROWS: { shown: string; wall: string; season: "winter" | "summer" }[] = [
  { shown: "15.01.2026 10:00", wall: "2026-01-15T10:00:00", season: "winter" },
  { shown: "28.03.2026 12:00", wall: "2026-03-28T12:00:00", season: "winter" },
  { shown: "29.03.2026 12:00", wall: "2026-03-29T12:00:00", season: "summer" },
  { shown: "01.07.2026 09:30", wall: "2026-07-01T09:30:00", season: "summer" },
  { shown: "24.10.2026 23:59", wall: "2026-10-24T23:59:00", season: "summer" },
  { shown: "25.10.2026 12:00", wall: "2026-10-25T12:00:00", season: "winter" },
  { shown: "18.12.2026 12:00 Uhr", wall: "2026-12-18T12:00:00", season: "winter" },
];

test("deadlines shown in local time keep their wall time and get the offset of their own date, in six zones", async () => {
  const html = page(
    `<table>${DST_ROWS.map((r, i) => `<tr class="r"><td class="id">D${i}</td><td><a href="/d/${i}">T</a></td><td class="dl">${r.shown}</td></tr>`).join("")}</table>`,
  );
  routes.set("/dst", () => ({ body: html }));
  const json = JSON.stringify(DST_ROWS.map((r, i) => ({ id: `J${i}`, deadline: r.wall })));
  routes.set("/dst.json", () => ({ type: "application/json", body: json }));

  for (const { zone, winter, summer } of ZONES) {
    const htmlRes = ok(
      await extractor.read(
        recipe({
          timeZone: zone,
          list: { request: { url: "/dst", method: "GET" }, pagination: { type: "none" }, item: "tr.r", emptyText: [] },
          listFields: { id: { css: "td.id" }, url: { css: "a", attr: "href" }, submissionDeadline: { css: "td.dl" } },
        }),
        makeCtx(),
      ),
    );
    const jsonRes = ok(
      await extractor.read(
        recipe({
          tier: "jsonApi",
          timeZone: zone,
          list: { request: { url: "/dst.json", method: "GET" }, pagination: { type: "none" }, item: "$[*]", emptyText: [] },
          listFields: { id: { jsonPath: "$.id" }, url: { const: "/j/{id}" }, submissionDeadline: { jsonPath: "$.deadline" } },
        }),
        makeCtx(),
      ),
    );
    DST_ROWS.forEach((r, i) => {
      const want = r.wall + (r.season === "winter" ? winter : summer);
      assert.equal(htmlRes.tenders[i]!.submissionDeadline, want, `${zone} html ${r.shown}`);
      assert.equal(jsonRes.tenders[i]!.submissionDeadline, want, `${zone} json ${r.wall}`);
      assertContract(htmlRes.tenders[i]!);
    });
  }
});

test("deadline in the repeated autumn hour is null unless the source has an explicit offset", () => {
  assert.equal(parseDateTime("25.10.2026 02:30", "Europe/Berlin"), null);
  assert.equal(parseDateTime("25.10.2026 01:30", "Europe/Lisbon"), null);
  assert.equal(parseDateTime("2026-10-25T02:30:00+02:00", "Europe/Berlin"), "2026-10-25T02:30:00+02:00");
  assert.equal(parseDateTime("2026-10-25T02:30:00+01:00", "Europe/Berlin"), "2026-10-25T02:30:00+01:00");
});

test("deadline in the skipped spring hour is null, not shifted", () => {
  assert.equal(parseDateTime("29.03.2026 02:30", "Europe/Berlin"), null);
});

// ------------------------------------------------------------ known normalizer bugs (wrong values)

test("a second date after the deadline is not read as its time", () => {
  assert.equal(parseDateTime("31.12.2026, Eröffnung 05.01.2027", "Europe/Berlin"), null);
  assert.equal(parseDateTime("Frist: 31.12.2026 / Bindefrist: 15.02.2027", "Europe/Berlin"), null);
  assert.equal(parseDateTime("31.12.2026 - 12.01.2027 10:00", "Europe/Berlin"), null);
});

test("a procedure text naming two procedures is left out", () => {
  assert.equal(mapProcedureType("Offenes Verfahren oder Verhandlungsverfahren"), undefined);
});

// ------------------------------------------------------------ 2b. summary pages

test("list links to a summary page: the tender url is the real tender page found via detail, also on a cached re-read", async () => {
  routes.set("/notices", () => ({
    body: page(`<ul>${[1, 2].map((n) => `<li class="n"><a class="more" href="/summary/${n}">Notice ${n}</a><span class="az">VG-${n}</span></li>`).join("")}</ul>`),
  }));
  for (const n of [1, 2]) {
    routes.set(`/summary/${n}`, () => ({
      body: page(`<h1>Kurzfassung</h1><p>Vergabestelle: Stadt Köln</p><a class="go" href="/vergabe/tender?id=${n}&amp;lang=de">Zur Ausschreibung</a>`),
    }));
  }
  routes.set("/vergabe/tender", (url) => ({ body: page(`<a class="file" href="/files/${url.searchParams.get("id")}.pdf">Unterlagen</a>`) }));
  const r = recipe({
    list: { request: { url: "/notices", method: "GET" }, pagination: { type: "none" }, item: "li.n", emptyText: [] },
    listFields: { id: { css: "span.az" }, url: { css: "a.more", attr: "href" }, title: { css: "a.more" } },
    detail: { urlFrom: "url", fields: { url: { css: "a.go", attr: "href" }, buyerName: { label: "Vergabestelle" } } },
    documents: { hops: [], files: { css: "a.file", attr: "href", all: true }, via: "http" },
  });
  const first = ok(await extractor.read(r, makeCtx()));
  assert.deepEqual(first.tenders.map((t) => t.url), [`${base}/vergabe/tender?id=1&lang=de`, `${base}/vergabe/tender?id=2&lang=de`]);
  assert.equal(first.tenders[0]!.buyerName, "Stadt Köln");
  assert.equal(first.tenders[0]!.documentRefs[0]?.url, `${base}/files/1.pdf`);
  for (const t of first.tenders) assert.ok(!t.url.includes("/summary/"), "never the summary page");
  const second = ok(await extractor.read(r, makeCtx()));
  assert.deepEqual(second.tenders, first.tenders, "the cached detail keeps the tender page");

  // When the summary page loses its link, a partial list would close healthy, known tenders.
  clearDetailCache();
  routes.set("/summary/2", () => ({ body: page("<h1>Kurzfassung</h1>") }));
  const third = await extractor.read(r, makeCtx());
  assert.equal(third.kind, "error");
  if (third.kind === "error") assert.match(third.reason, /summary is not a substitute/);
});

// ------------------------------------------------------------ 2c. legacy encodings

const latin1Page = (decl: string) =>
  Buffer.from(
    `<!doctype html><html><head>${decl}<title>Ausschreibungen</title></head><body><table><tr class="r"><td class="id">L-1</td><td class="b">Stadt München – Baureferat</td><td><a href="/l/1">Straßenbau Größe ä ö ü ß é</a></td></tr></table></body></html>`,
    "latin1",
  );

function latin1Recipe(path: string, tier: Recipe["tier"] = "html"): Recipe {
  return recipe({
    tier,
    list: { request: { url: path, method: "GET" }, pagination: { type: "none" }, item: "tr.r", emptyText: [] },
    listFields: { id: { css: "td.id" }, url: { css: "a", attr: "href" }, title: { css: "a" }, buyerName: { css: "td.b" } },
  });
}

test("latin-1 / windows-1252 pages decode correctly from the header, a meta tag or http-equiv", async () => {
  // "–" (en dash) is not in latin1: Buffer writes its low byte 0x13. Build the windows-1252 byte 0x96 explicitly.
  const cp1252 = (decl: string) => {
    const b = latin1Page(decl);
    const i = b.indexOf(0x13);
    if (i >= 0) b[i] = 0x96;
    return b;
  };
  routes.set("/enc/header", () => ({ type: "text/html; charset=ISO-8859-1", body: cp1252("") }));
  routes.set("/enc/meta", () => ({ type: "text/html", body: cp1252('<meta charset="windows-1252">') }));
  routes.set("/enc/equiv", () => ({ type: "text/html", body: cp1252('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">') }));
  for (const p of ["/enc/header", "/enc/meta", "/enc/equiv"]) {
    const res = ok(await extractor.read(latin1Recipe(p), makeCtx()));
    assert.equal(res.tenders[0]!.buyerName, "Stadt München – Baureferat", p);
    assert.equal(res.tenders[0]!.title, "Straßenbau Größe ä ö ü ß é", p);
  }
});

test("latin-1 detail page under a utf-8 list decodes the buyer correctly", async () => {
  routes.set("/mix", () => ({ body: page('<div class="r"><span class="id">M-1</span><a href="/mix/1">Titel</a></div>') }));
  routes.set("/mix/1", () => ({ type: "text/html; charset=windows-1252", body: Buffer.from(page("<p>Auftraggeber: Gemeinde Füssen</p>"), "latin1") }));
  const res = ok(
    await extractor.read(
      recipe({
        list: { request: { url: "/mix", method: "GET" }, pagination: { type: "none" }, item: "div.r", emptyText: [] },
        listFields: { id: { css: ".id" }, url: { css: "a", attr: "href" } },
        detail: { urlFrom: "url", fields: { buyerName: { label: "Auftraggeber" } } },
      }),
      makeCtx(),
    ),
  );
  assert.equal(res.tenders[0]!.buyerName, "Gemeinde Füssen");
});

test("latin-1 RSS feed with an XML encoding declaration decodes correctly", async () => {
  const xml = Buffer.from(
    `<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><item><guid>F-1</guid><title>Brücke über die Isar</title><link>${base}/f/1</link><author>Landratsamt Fürstenfeldbruck</author></item></channel></rss>`,
    "latin1",
  );
  routes.set("/feed", () => ({ type: "application/rss+xml", body: xml }));
  const res = ok(
    await extractor.read(
      recipe({
        tier: "feed",
        list: { request: { url: "/feed", method: "GET" }, pagination: { type: "none" }, item: "item", emptyText: [] },
        listFields: { id: { css: "guid" }, url: { css: "link" }, title: { css: "title" }, buyerName: { css: "author" } },
      }),
      makeCtx(),
    ),
  );
  assert.equal(res.tenders[0]!.title, "Brücke über die Isar");
  assert.equal(res.tenders[0]!.buyerName, "Landratsamt Fürstenfeldbruck");
});

test("latin-1 page with no charset declared never yields mojibake (correct text or null)", async () => {
  routes.set("/enc/none", () => ({ type: "text/html", body: latin1Page("") }));
  const res = ok(await extractor.read(latin1Recipe("/enc/none"), makeCtx()));
  for (const v of [res.tenders[0]!.buyerName, res.tenders[0]!.title]) {
    assert.ok(v === null || !v.includes("�"), `mojibake: ${v}`);
  }
});

// ------------------------------------------------------------ 2d. captcha shown, items present

test("a captcha widget on a list page that still lists tenders is not a block; document links still come through", async () => {
  routes.set("/cap", () => ({
    body: page(
      `<table>${[1, 2, 3].map((n) => `<tr class="r"><td class="id">C-${n}</td><td><a href="/cap/${n}">Tender ${n}</a></td></tr>`).join("")}</table>` +
        '<form action="/download"><div class="g-recaptcha" data-sitekey="abc"></div><button>Alle Unterlagen</button></form>',
      '<script src="https://www.google.com/recaptcha/api.js"></script>',
    ),
  }));
  for (const n of [1, 2, 3]) {
    routes.set(`/cap/${n}`, () => ({
      body: page(`<div class="h-captcha" data-sitekey="x"></div><a class="file" href="/files/${n}/lv.pdf">lv.pdf</a><a class="file" href="/files/${n}/plan.zip">plan.zip</a>`),
    }));
  }
  const res = ok(
    await extractor.read(
      recipe({
        list: { request: { url: "/cap", method: "GET" }, pagination: { type: "none" }, item: "tr.r", emptyText: [] },
        listFields: { id: { css: "td.id" }, url: { css: "a", attr: "href" }, title: { css: "a" } },
        documents: { hops: [], files: { css: "a.file" }, via: "http" },
      }),
      makeCtx(),
    ),
  );
  assert.equal(res.tenders.length, 3);
  assert.deepEqual(res.tenders[0]!.documentRefs, [
    { url: `${base}/files/1/lv.pdf`, via: "http", fileNameHint: "lv.pdf" },
    { url: `${base}/files/1/plan.zip`, via: "http", fileNameHint: "plan.zip" },
  ]);
});

// ------------------------------------------------------------ 3. regular reads never call the model

test("regular reads make zero model calls and never open the browser (html, jsonApi, feed, details, documents)", async () => {
  routes.set("/z/list", () => ({ body: page('<div class="r"><b>Z-1</b><a href="/z/t/1">Eins</a></div>') }));
  routes.set("/z/t/1", () => ({ body: page('<p>Vergabestelle: Amt</p><a class="doc" href="/z/f/a.pdf">a.pdf</a>') }));
  routes.set("/z/api", () => ({ type: "application/json", body: JSON.stringify({ items: [{ id: 1, t: "x" }] }) }));
  routes.set("/z/api/1", () => ({ type: "application/json", body: JSON.stringify({ ref: "R1" }) }));
  routes.set("/z/feed", () => ({ type: "application/rss+xml", body: `<rss><channel><item><guid>g1</guid><link>${base}/z/t/1</link></item></channel></rss>` }));
  routes.set("/z/blocked", () => ({ status: 403, body: "no" }));
  routes.set("/z/empty", () => ({ body: page("<p>Keine Treffer</p>") }));
  const ctx = makeCtx();
  const reads = [
    recipe({
      list: { request: { url: "/z/list", method: "GET" }, pagination: { type: "pageParam", start: 1, maxPages: 3 }, item: "div.r", emptyText: [] },
      listFields: { id: { css: "b" }, url: { css: "a", attr: "href" } },
      detail: { urlFrom: "url", fields: { buyerName: { label: "Vergabestelle" } } },
      documents: { hops: [], files: { css: "a.doc" }, via: "http" },
    }),
    recipe({
      tier: "jsonApi",
      list: { request: { url: "/z/api", method: "GET" }, pagination: { type: "none" }, item: "$.items[*]", emptyText: [] },
      listFields: { id: { jsonPath: "$.id" }, url: { const: "/z/t/{id}" } },
      detail: { urlFrom: "/z/api/{id}", fields: { referenceNumber: { jsonPath: "$.ref" } } },
    }),
    recipe({
      tier: "feed",
      list: { request: { url: "/z/feed", method: "GET" }, pagination: { type: "none" }, item: "item", emptyText: [] },
      listFields: { id: { css: "guid" }, url: { css: "link" } },
    }),
    recipe({ list: { request: { url: "/z/blocked", method: "GET" }, pagination: { type: "none" }, item: "x", emptyText: [] }, listFields: { id: { css: "b" } } }),
    recipe({ list: { request: { url: "/z/empty", method: "GET" }, pagination: { type: "none" }, item: "x", emptyText: ["Keine Treffer"] }, listFields: { id: { css: "b" } } }),
    recipe({ list: { request: { url: "/z/missing", method: "GET" }, pagination: { type: "none" }, item: "x", emptyText: [] }, listFields: { id: { css: "b" } } }),
  ];
  const kinds: string[] = [];
  for (const r of reads) {
    kinds.push((await extractor.read(r, ctx)).kind);
    kinds.push((await extractor.read(r, ctx)).kind); // second read takes the cached-detail path
  }
  assert.deepEqual(kinds, ["ok", "ok", "ok", "ok", "ok", "ok", "blocked", "blocked", "ok", "ok", "error", "error"]);
  assert.equal(ctx.spy.llm, 0, "no model call on regular reads");
  assert.equal(ctx.spy.browser, 0, "no browser for http tiers");
});

test("cartographer, known portal: attach and the following regular reads make zero model calls", async () => {
  routes.set("/known/api", () => ({ type: "application/json", body: JSON.stringify([{ id: "K1", t: "Eins" }, { id: "K2", t: "Zwei" }]) }));
  registerKnownRecipe("Trap lab", { host: "127.0.0.1", pathPrefix: "/known" }, {
    schemaVersion: 1,
    tier: "jsonApi",
    timeZone: "Europe/Berlin",
    list: { request: { url: `${base}/known/api` }, pagination: { type: "none" }, item: "$[*]" },
    listFields: { id: { jsonPath: "$.id" }, url: { const: `${base}/known/t/{id}` }, title: { jsonPath: "$.t" } },
  });
  const ctx = makeCtx({ url: `${base}/known/start` });
  const out = await cartographer.attach(ctx);
  assert.equal(out.kind, "ok", JSON.stringify(out));
  if (out.kind !== "ok") return;
  for (let i = 0; i < 3; i++) ok(await extractor.read(out.recipe, ctx));
  assert.equal(ctx.spy.llm, 0);
  assert.equal(ctx.spy.browser, 0);
});

test("cartographer, unknown portal: model use is bounded, and reading with whatever it returns calls the model zero times", async () => {
  // localhost is not in the known registry (only 127.0.0.1/known is).
  const ctx = makeCtx({ url: base.replace("127.0.0.1", "localhost") + "/unknown" });
  const out = await cartographer.attach(ctx);
  // 1 first call + at most 3 correction rounds.
  assert.ok(ctx.spy.llm <= 4, `attach made ${ctx.spy.llm} model calls`);

  if (out.kind === "ok") {
    const before = ctx.spy.llm;
    ok(await extractor.read(out.recipe, ctx));
    assert.equal(ctx.spy.llm, before, "a regular read after attach makes no model call");
  }
});

// ------------------------------------------------------------ 6. abort during detail fetches

function detailPortal(n: number, delayMs: number): Recipe {
  routes.set("/ab", () => ({
    body: page(`<ul>${Array.from({ length: n }, (_, i) => `<li class="r"><i>A-${i}</i><a href="/ab/${i}">T${i}</a></li>`).join("")}</ul>`),
  }));
  for (let i = 0; i < n; i++) routes.set(`/ab/${i}`, () => ({ body: page(`<p>Vergabestelle: Amt ${i}</p>`), delayMs }));
  return recipe({
    list: { request: { url: "/ab", method: "GET" }, pagination: { type: "none" }, item: "li.r", emptyText: [] },
    listFields: { id: { css: "i" }, url: { css: "a", attr: "href" } },
    detail: { urlFrom: "url", fields: { buyerName: { label: "Vergabestelle" } } },
  });
}

test("abort before a detail fetch: no further request is made", async () => {
  const r = detailPortal(6, 0);
  const ac = new AbortController();
  // fetch #1 is the list, #2..#7 details. Abort while fetch #3 (2nd detail) starts.
  const ctx = makeCtx({ signal: ac.signal, onFetch: (_u, n) => n === 3 && ac.abort() });
  const res = await extractor.read(r, ctx);
  assert.equal(res.kind, "error");
  assert.match((res as { reason: string }).reason, /cancelled/);
  assert.equal(ctx.spy.fetches.length, 3, "the request in flight is the last one");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!served.includes("/ab/2"), "the portal saw no request after the abort");
});

for (const dropSignal of [false, true]) {
  test(`abort while a slow detail page is in flight returns promptly and stops (http layer ${dropSignal ? "ignores" : "honours"} the signal)`, async () => {
    const r = detailPortal(6, 400);
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal, dropSignal, onFetch: (_u, n) => n === 3 && setTimeout(() => ac.abort(), 50) });
    const t0 = Date.now();
    const res = await extractor.read(r, ctx);
    const took = Date.now() - t0;
    assert.equal(res.kind, "error");
    assert.match((res as { reason: string }).reason, /cancelled/);
    assert.equal(ctx.spy.fetches.length, 3);
    // 1st detail takes 400 ms, abort comes 50 ms into the 2nd: well under the 2nd's 400 ms.
    assert.ok(took < 400 + 300, `read took ${took} ms after abort`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(served.filter((p) => p.startsWith("/ab/")).length, 2, "no detail request after the abort");
  });
}
