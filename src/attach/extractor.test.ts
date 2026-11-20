import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { extractor, clearDetailCache, localDate } from "./extractor.js";
import type { PortalContext, ReadOutcome } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";

// ------------------------------------------------------------ fake portal

type Route = (url: URL) => { status?: number; type?: string; body: string };
const routes = new Map<string, Route>();
const hits = new Map<string, number>();
let server: http.Server;
let base = "";
let llmCalls = 0;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    const route = routes.get(url.pathname);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const r = route(url);
    res.writeHead(r.status ?? 200, { "content-type": r.type ?? "text/html; charset=utf-8" });
    res.end(r.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  assert.equal(llmCalls, 0, "the Extractor must never call the LLM");
});

beforeEach(() => {
  routes.clear();
  hits.clear();
  clearDetailCache();
});

function makeCtx(opts: { signal?: AbortSignal; onFetch?: (url: string) => void } = {}): PortalContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    portalId: "p1",
    url: base + "/",
    http: {
      fetch(url, init) {
        opts.onFetch?.(url);
        return fetch(url, init);
      },
    },
    browser: {
      withPage() {
        throw new Error("browser must not be used");
      },
    },
    llm: {
      json() {
        llmCalls += 1;
        throw new Error("LLM must not be called");
      },
    },
    log: (m) => void logs.push(m),
    signal: opts.signal ?? new AbortController().signal,
    logs,
  };
}

function recipe(partial: Partial<Recipe> & Pick<Recipe, "list" | "listFields">): Recipe {
  return {
    schemaVersion: 1,
    family: null,
    tier: "html",
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    detail: null,
    documents: null,
    withdrawnText: [],
    ...partial,
  };
}

function ok(r: ReadOutcome): Extract<ReadOutcome, { kind: "ok" }> {
  assert.equal(r.kind, "ok", JSON.stringify(r));
  return r as Extract<ReadOutcome, { kind: "ok" }>;
}

const page = (body: string) => `<!doctype html><html><head><title>Portal</title></head><body>${body}</body></html>`;
const row = (ref: string, href: string | null, title: string, pub: string, extra = "") =>
  `<tr class="row"><td class="ref">${ref}</td><td>${href ? `<a href="${href}">${title}</a>` : title}</td><td class="pub">${pub}</td><td>${extra}</td></tr>`;
const table = (rows: string) => page(`<main><table class="results"><tbody>${rows}</tbody></table></main>`);

// ------------------------------------------------------------ html

test("html: table list with pageParam, detail pages, label selectors and German local times", async () => {
  routes.set("/html/list", (u) => {
    const p = u.searchParams.get("page");
    if (p === "1") return { body: table(row("A-1", "/html/t/1", "Neubau Schule", "01.03.2026") + row("A-2", "/html/t/2", "Straßenbau", "02.03.2026")) };
    if (p === "2") return { body: table(row("A-3", "/html/t/3", "Reinigung", "3. März 2026") + row("A-4", null, "Ohne Link", "04.03.2026")) };
    return { body: table("") };
  });
  for (const n of [1, 2, 3]) {
    routes.set(`/html/t/${n}`, () => ({
      body: page(`
        <h1>Ausschreibung ${n}</h1>
        <dl><dt>Vergabestelle</dt><dd>Stadt Musterhausen ${n}</dd></dl>
        <table><tr><th>Angebotsfrist</th><td>12.03.2026 10:00 Uhr</td></tr></table>
        <p><b>Aktenzeichen:</b> VG-2026-00${n}</p>
        <p>Ort: 10115 Berlin</p>
        <div class="cpv">CPV: 45000000-7, 45200000-9</div>
        <div>Verfahrensart: Offenes Verfahren</div>`),
    }));
  }
  const r = recipe({
    list: { request: { url: "/html/list?page={page}", method: "GET" }, pagination: { type: "pageParam", start: 1, maxPages: 10 }, item: "table.results tr.row", emptyText: [] },
    listFields: {
      id: { css: "td.ref" },
      url: { css: "a", attr: "href" },
      title: { css: "a" },
      publicationDate: { css: "td.pub" },
    },
    detail: {
      urlFrom: "url",
      fields: {
        buyerName: { label: "Vergabestelle" },
        submissionDeadline: { label: "Angebotsfrist", format: "dd.MM.yyyy HH:mm" },
        referenceNumber: { label: "Aktenzeichen" },
        postalCode: { label: "Ort", regex: "(\\d{5})" },
        city: { label: "Ort", regex: "\\d{5}\\s+(.+)" },
        cpvCodes: { css: ".cpv" },
        procedureType: { label: "Verfahrensart" },
      },
    },
  });
  const ctx = makeCtx();
  const res = ok(await extractor.read(r, ctx));
  assert.equal(res.tenders.length, 3);
  assert.equal(res.diagnostics.listPages, 3);
  assert.equal(res.diagnostics.itemsSeen, 4);
  const t1 = res.tenders[0]!;
  assert.deepEqual(t1, {
    id: "A-1",
    url: `${base}/html/t/1`,
    title: "Neubau Schule",
    buyerName: "Stadt Musterhausen 1",
    publicationDate: "2026-03-01",
    submissionDeadline: "2026-03-12T10:00:00+01:00",
    referenceNumber: "VG-2026-001",
    procedureType: "open",
    cpvCodes: ["45000000", "45200000"],
    placeOfPerformance: { postalCode: "10115", city: "Berlin", countryCode: "DE" },
    documentRefs: [],
  });
  assert.equal(res.tenders[2]!.publicationDate, "2026-03-03");
  assert.deepEqual(res.diagnostics.fieldFill.title, { filled: 3, total: 3 });
  assert.deepEqual(res.diagnostics.fieldFill.submissionDeadline, { filled: 3, total: 3 });
  assert.ok(res.diagnostics.fieldFill.city);
  assert.equal(res.diagnostics.requests, 3 + 3);
  assert.ok(res.diagnostics.listSkeletonHash);
  assert.ok(ctx.logs.some((l) => /no id or address/.test(l)));

  // Second read: unchanged list items reuse the cached detail values, no detail requests.
  const again = ok(await extractor.read(r, makeCtx()));
  assert.equal(again.diagnostics.requests, 3);
  assert.deepEqual(again.tenders, res.tenders);
  assert.equal(hits.get("/html/t/1"), 1);
});

test("html: stops paginating when a page repeats ids already seen", async () => {
  routes.set("/same", () => ({ body: table(row("X-1", "/x/1", "Eins", "01.03.2026")) }));
  const res = ok(
    await extractor.read(
      recipe({
        list: { request: { url: "/same?p={page}", method: "GET" }, pagination: { type: "pageParam", start: 1, maxPages: 10 }, item: "tr.row", emptyText: [] },
        listFields: { id: { css: "td.ref" }, url: { css: "a", attr: "href" } },
      }),
      makeCtx(),
    ),
  );
  assert.equal(res.tenders.length, 1);
  assert.equal(res.diagnostics.listPages, 2);
  assert.deepEqual(res.diagnostics.fieldFill.buyerName, { filled: 0, total: 1 });
});

test("html: nextLink pagination follows the resolved link", async () => {
  routes.set("/n1", () => ({ body: table(row("N-1", "/t/1", "Eins", "01.03.2026")) + '<a class="next" href="/n2">weiter</a>' }));
  routes.set("/n2", () => ({ body: table(row("N-2", "/t/2", "Zwei", "01.03.2026")) }));
  const res = ok(
    await extractor.read(
      recipe({
        list: { request: { url: "/n1", method: "GET" }, pagination: { type: "nextLink", selector: { css: "a.next", attr: "href" }, maxPages: 5 }, item: "tr.row", emptyText: [] },
        listFields: { id: { css: "td.ref" }, url: { css: "a", attr: "href" } },
      }),
      makeCtx(),
    ),
  );
  assert.deepEqual(res.tenders.map((t) => t.id), ["N-1", "N-2"]);
  assert.equal(res.diagnostics.listPages, 2);
});

// ------------------------------------------------------------ json

test("jsonApi: offsetParam, jsonPath fields, {id} detail template, numeric ids and CPV check digits", async () => {
  const all = [
    { publicatieId: 101, link: { href: "/pub/101" }, naam: "Wegonderhoud", opdrachtgever: "Gemeente A", publicatieDatum: "2026-03-01", sluitingsDatum: "2026-03-20T12:00:00", kenmerk: 4711, procedure: { omschrijving: "Openbaar" }, type: "Werken" },
    { publicatieId: 102, link: { href: "/pub/102" }, naam: "Schoonmaak", opdrachtgever: "Gemeente B", publicatieDatum: "2026-03-02", sluitingsDatum: null, kenmerk: "K-2", procedure: { omschrijving: "Niet-openbaar" }, type: "Diensten" },
    { publicatieId: 103, link: { href: "/pub/103" }, naam: "Laptops", opdrachtgever: "Gemeente C", publicatieDatum: "2026-03-03", sluitingsDatum: "2026-07-01T09:30:00", procedure: { omschrijving: "Iets anders" }, type: "Leveringen" },
  ];
  routes.set("/api/list", (u) => {
    const offset = Number(u.searchParams.get("offset"));
    const size = Number(u.searchParams.get("size"));
    return { type: "application/json", body: JSON.stringify({ content: all.slice(offset, offset + size), total: all.length }) };
  });
  for (const t of all) {
    routes.set(`/api/detail/${t.publicatieId}`, () => ({
      type: "application/json",
      body: JSON.stringify({ cpvCodes: [{ code: "45000000-7" }, { code: "71000000-8" }], beschrijving: `Beschrijving ${t.publicatieId}` }),
    }));
  }
  const r = recipe({
    tier: "jsonApi",
    timeZone: "Europe/Amsterdam",
    countryCode: "NL",
    list: { request: { url: "/api/list?offset={offset}&size={pageSize}", method: "GET" }, pagination: { type: "offsetParam", pageSize: 2, maxPages: 10 }, item: "$.content[*]", emptyText: [] },
    listFields: {
      id: { jsonPath: "$.publicatieId" },
      url: { jsonPath: "$.link.href" },
      title: { jsonPath: "$.naam" },
      buyerName: { jsonPath: "$.opdrachtgever" },
      publicationDate: { jsonPath: "$.publicatieDatum" },
      submissionDeadline: { jsonPath: "$.sluitingsDatum" },
      referenceNumber: { jsonPath: "$.kenmerk" },
      procedureType: { jsonPath: "$.procedure.omschrijving" },
      contractNature: { jsonPath: "$.type" },
    },
    detail: {
      urlFrom: "/api/detail/{id}",
      fields: { cpvCodes: { jsonPath: "$.cpvCodes[*].code", all: true }, description: { jsonPath: "$.beschrijving" } },
    },
  });
  const res = ok(await extractor.read(r, makeCtx()));
  assert.equal(res.diagnostics.listPages, 3);
  assert.equal(res.tenders.length, 3);
  const [a, b, c] = res.tenders;
  assert.equal(a!.id, "101");
  assert.equal(a!.url, `${base}/pub/101`);
  assert.equal(a!.referenceNumber, "4711");
  assert.equal(a!.submissionDeadline, "2026-03-20T12:00:00+01:00");
  assert.equal(a!.procedureType, "open");
  assert.equal(a!.contractNature, "works");
  assert.deepEqual(a!.cpvCodes, ["45000000", "71000000"]);
  assert.equal(a!.description, "Beschrijving 101");
  assert.equal(a!.placeOfPerformance, undefined);
  assert.equal(b!.submissionDeadline, null);
  assert.equal(b!.procedureType, "restricted");
  assert.equal(c!.submissionDeadline, "2026-07-01T09:30:00+02:00");
  assert.equal(c!.procedureType, undefined);
  assert.equal(c!.referenceNumber, undefined);
  assert.deepEqual(res.diagnostics.fieldFill.referenceNumber, { filled: 2, total: 3 });
  assert.deepEqual(res.diagnostics.fieldFill.cpvCodes, { filled: 3, total: 3 });
});

// ------------------------------------------------------------ documents

test("documents: const and css hops, then file links with name hints, deduped", async () => {
  routes.set("/d/list", () => ({ body: table(row("D-1", "/d/t/1", "Brücke", "01.03.2026")) }));
  routes.set("/d/docs/D-1", () => ({ body: page('<a class="unterlagen" href="/d/docs/D-1/files">Vergabeunterlagen</a>') }));
  routes.set("/d/docs/D-1/files", () => ({
    body: page(`
      <ul>
        <li><a class="file" href="a.pdf">Leistungsverzeichnis.pdf</a></li>
        <li><a class="file" href="/files/b.zip" download="Pläne.zip">Download</a></li>
        <li><a class="file" href="a.pdf">nochmal</a></li>
        <li><a class="file" href="javascript:void(0)">kaputt</a></li>
      </ul>`),
  }));
  const res = ok(
    await extractor.read(
      recipe({
        list: { request: { url: "/d/list", method: "GET" }, pagination: { type: "none" }, item: "tr.row", emptyText: [] },
        listFields: { id: { css: "td.ref" }, url: { css: "a", attr: "href" } },
        documents: { hops: [{ const: "/d/docs/{id}" }, { css: "a.unterlagen" }], files: { css: "a.file", all: true }, via: "http" },
      }),
      makeCtx(),
    ),
  );
  // No detail rule: the tender page itself is not needed because the first hop is a const template.
  assert.deepEqual(res.tenders[0]!.documentRefs, [
    { url: `${base}/d/docs/D-1/a.pdf`, via: "http", fileNameHint: "Leistungsverzeichnis.pdf" },
    { url: `${base}/files/b.zip`, via: "http", fileNameHint: "Pläne.zip" },
  ]);
  assert.equal(hits.get("/d/t/1"), undefined, "a const first hop needs no tender page");
});

test("documentRefsPending: set when the document list cannot be read, absent when it was read (even if empty)", async () => {
  routes.set("/p/list", () => ({ body: table(row("P-1", "/p/t/1", "Eins", "01.03.2026") + row("P-2", "/p/t/2", "Zwei", "01.03.2026")) }));
  routes.set("/p/docs/P-1", () => ({ status: 500, body: "boom" }));
  routes.set("/p/docs/P-2", () => ({ body: page("<p>Keine Unterlagen.</p>") }));
  const r = recipe({
    list: { request: { url: "/p/list", method: "GET" }, pagination: { type: "none" }, item: "tr.row", emptyText: [] },
    listFields: { id: { css: "td.ref" }, url: { css: "a", attr: "href" } },
    documents: { hops: [{ const: "/p/docs/{id}" }], files: { css: "a.file", all: true }, via: "http" },
  });
  const res = ok(await extractor.read(r, makeCtx()));
  const byId = new Map(res.tenders.map((t) => [t.id, t]));
  assert.equal(byId.get("P-1")!.documentRefsPending, true, "a failed document list is unknown, not empty");
  assert.deepEqual(byId.get("P-1")!.documentRefs, []);
  assert.equal(byId.get("P-2")!.documentRefsPending, undefined, "a document list that was read and is empty is a real 'none'");

  // The failure is not cached: the next read tries again and clears the flag once it works.
  routes.set("/p/docs/P-1", () => ({ body: page('<a class="file" href="/p/f/1.pdf">1.pdf</a>') }));
  const again = ok(await extractor.read(r, makeCtx()));
  const p1 = again.tenders.find((t) => t.id === "P-1")!;
  assert.equal(p1.documentRefsPending, undefined);
  assert.equal(p1.documentRefs.length, 1);
});

// ------------------------------------------------------------ feed

test("feed: RSS read with xml mode", async () => {
  routes.set("/rss", () => ({
    type: "application/rss+xml",
    body: `<?xml version="1.0"?><rss><channel>
      <item><guid>g-1</guid><title><![CDATA[Neubau Kita]]></title><link>${base}/k/1</link><pubDate>Mon, 02 Mar 2026 08:00:00 +0100</pubDate></item>
    </channel></rss>`,
  }));
  const res = ok(
    await extractor.read(
      recipe({
        tier: "feed",
        list: { request: { url: "/rss", method: "GET" }, pagination: { type: "none" }, item: "item", emptyText: [] },
        listFields: { id: { css: "guid" }, url: { css: "link" }, title: { css: "title" }, publicationDate: { css: "pubDate" } },
      }),
      makeCtx(),
    ),
  );
  assert.equal(res.tenders[0]!.id, "g-1");
  assert.equal(res.tenders[0]!.title, "Neubau Kita");
  assert.equal(res.tenders[0]!.url, `${base}/k/1`);
  assert.equal(res.tenders[0]!.publicationDate, "2026-03-02");
});

// ------------------------------------------------------------ states

const simple = (path: string, extra: Partial<Recipe> = {}) =>
  recipe({
    list: { request: { url: path, method: "GET" }, pagination: { type: "none" }, item: "tr.row", emptyText: ["keine Ausschreibungen"] },
    listFields: { id: { css: "td.ref" }, url: { css: "a", attr: "href" } },
    ...extra,
  });

test("empty state text is reported with zero tenders", async () => {
  routes.set("/empty", () => ({ body: page("<p>Derzeit sind Keine  Ausschreibungen vorhanden.</p>") }));
  const res = ok(await extractor.read(simple("/empty"), makeCtx()));
  assert.equal(res.tenders.length, 0);
  assert.equal(res.diagnostics.emptyStateText, "Keine Ausschreibungen");

  routes.set("/blank", () => ({ body: page("<p>Willkommen</p>") }));
  const blank = ok(await extractor.read(simple("/blank"), makeCtx()));
  assert.equal(blank.diagnostics.emptyStateText, undefined);
  assert.deepEqual(blank.diagnostics.fieldFill.id, { filled: 0, total: 0 });
});

test("403 is blocked, a login form is blocked, a captcha is blocked, 503 is unreachable", async () => {
  routes.set("/forbidden", () => ({ status: 403, body: "no" }));
  routes.set("/login", () => ({ body: page('<form action="/login"><input name="user"><input type="password" name="pw"></form>') }));
  routes.set("/captcha", () => ({ body: page('<form><div class="g-recaptcha" data-sitekey="x"></div></form>') }));
  routes.set("/down", () => ({ status: 503, body: "maintenance" }));
  const forbidden = await extractor.read(simple("/forbidden"), makeCtx());
  assert.equal(forbidden.kind, "blocked");
  assert.match((forbidden as { reason: string }).reason, /403/);
  const login = await extractor.read(simple("/login"), makeCtx());
  assert.equal(login.kind, "blocked");
  assert.match((login as { reason: string }).reason, /login/);
  const captcha = await extractor.read(simple("/captcha"), makeCtx());
  assert.equal(captcha.kind, "blocked");
  assert.match((captcha as { reason: string }).reason, /captcha/);
  const down = await extractor.read(simple("/down"), makeCtx());
  assert.deepEqual(down, { kind: "unreachable", reason: "The portal answers 503 Service Unavailable; trying again later.", httpStatus: 503 });
  const missing = await extractor.read(simple("/nope"), makeCtx());
  assert.equal(missing.kind, "error");
});

test("browser tier is reported as not supported", async () => {
  const res = await extractor.read(simple("/x", { tier: "browser" }), makeCtx());
  assert.deepEqual(res, { kind: "error", reason: "Browser tier not supported by the Extractor yet." });
});

test("withdrawnText marks cancelled tenders", async () => {
  routes.set("/w", () => ({ body: table(row("W-1", "/w/1", "Aktiv", "01.03.2026") + row("W-2", "/w/2", "Alt", "01.03.2026", "AUFGEHOBEN")) }));
  const res = ok(await extractor.read(simple("/w", { withdrawnText: ["Aufgehoben"] }), makeCtx()));
  assert.equal(res.tenders[0]!.withdrawn, undefined);
  assert.equal(res.tenders[1]!.withdrawn, true);
});

test("dedupes tenders by id, first wins", async () => {
  routes.set("/dup", () => ({ body: table(row("S-1", "/s/1", "Erst", "01.03.2026") + row("S-1", "/s/1b", "Zweit", "01.03.2026")) }));
  const res = ok(await extractor.read(simple("/dup", { listFields: { id: { css: "td.ref" }, url: { css: "a", attr: "href" }, title: { css: "a" } } }), makeCtx()));
  assert.deepEqual(res.tenders.map((t) => t.title), ["Erst"]);
});

test("skeleton hash ignores text but notices class changes", async () => {
  routes.set("/s1", () => ({ body: table(row("S-1", "/s/1", "Eins", "01.03.2026") + row("S-2", "/s/2", "Zwei", "01.03.2026")) }));
  routes.set("/s2", () => ({ body: table(row("Q-9", "/q/9", "Ganz anderer Titel", "09.09.2026")) }));
  routes.set("/s3", () => ({ body: table(row("S-1", "/s/1", "Eins", "01.03.2026")).replace('class="ref"', 'class="reference"') }));
  const h1 = ok(await extractor.read(simple("/s1"), makeCtx())).diagnostics.listSkeletonHash;
  const h2 = ok(await extractor.read(simple("/s2"), makeCtx())).diagnostics.listSkeletonHash;
  const h3 = ok(await extractor.read(simple("/s3"), makeCtx())).diagnostics.listSkeletonHash;
  assert.ok(h1);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test("an aborted signal stops the read", async () => {
  routes.set("/many", (u) => ({ body: table(row(`M-${u.searchParams.get("page")}`, "/m/1", "x", "01.03.2026")) }));
  const ac = new AbortController();
  let fetches = 0;
  const ctx = makeCtx({
    signal: ac.signal,
    onFetch: () => {
      fetches += 1;
      if (fetches === 2) ac.abort();
    },
  });
  const res = await extractor.read(
    recipe({
      list: { request: { url: "/many?page={page}", method: "GET" }, pagination: { type: "pageParam", start: 1, maxPages: 50 }, item: "tr.row", emptyText: [] },
      listFields: { id: { css: "td.ref" }, url: { css: "a", attr: "href" } },
    }),
    ctx,
  );
  assert.equal(res.kind, "error");
  assert.match((res as { reason: string }).reason, /cancelled/);
  assert.ok(fetches <= 2);
});

// ------------------------------------------------------------ date placeholders

test("localDate uses the zone's calendar day, not UTC", () => {
  // 23:30 UTC on 31 Dec is already 1 Jan in Amsterdam, and still 31 Dec in New York.
  const late = new Date(Date.UTC(2026, 11, 31, 23, 30));
  assert.equal(localDate("Europe/Amsterdam", 0, late), "2027-01-01");
  assert.equal(localDate("America/New_York", 0, late), "2026-12-31");
  assert.equal(localDate("Europe/Amsterdam", 7, late), "2026-12-25");
  // Across the March DST change and a month boundary.
  assert.equal(localDate("Europe/Berlin", 30, new Date(Date.UTC(2026, 2, 30, 10))), "2026-02-28");
});

test("{today} and {daysAgo:N} fill the list url, headers, body and const fields", async () => {
  let seen: { url: URL; body: string; header: string | undefined } | null = null;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen = { url: new URL(req.url ?? "/", base), body, header: req.headers["x-since"] as string | undefined };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [{ id: "T-1" }] }));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const srvBase = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const zone = "Pacific/Kiritimati"; // UTC+14: differs from the UTC date for most of the day
    const res = ok(
      await extractor.read(
        recipe({
          tier: "jsonApi",
          timeZone: zone,
          list: {
            request: { url: `${srvBase}/l?from={today}&pub={daysAgo:7}&p={page}`, method: "POST", headers: { "x-since": "{daysAgo:1}" }, body: '{"d":"{today}"}' },
            pagination: { type: "none" },
            item: "$.items[*]",
            emptyText: [],
          },
          listFields: { id: { jsonPath: "$.id" }, url: { const: "https://x.test/{id}?seen={today}" }, title: { const: "since {daysAgo:3}" } },
        }),
        makeCtx(),
      ),
    );
    const s = seen as unknown as { url: URL; body: string; header: string | undefined };
    assert.equal(s.url.searchParams.get("from"), localDate(zone));
    assert.equal(s.url.searchParams.get("pub"), localDate(zone, 7));
    assert.equal(s.header, localDate(zone, 1));
    assert.equal(s.body, `{"d":"${localDate(zone)}"}`);
    assert.equal(res.tenders[0]!.url, `https://x.test/T-1?seen=${localDate(zone)}`);
    assert.equal(res.tenders[0]!.title, `since ${localDate(zone, 3)}`);
  } finally {
    srv.close();
  }
});

// ------------------------------------------------------------ withdrawn field rule

test("withdrawn field rule: true/'true'/1/regex match withdraw, false/null/missing do not, not in fieldFill", async () => {
  const items = [
    { id: "a", w: true },
    { id: "b", w: false },
    { id: "c", w: "true" },
    { id: "d", w: 1 },
    { id: "e", w: null },
    { id: "f" },
    { id: "g", w: "nee" },
    { id: "h", w: 0 },
  ];
  routes.set("/wl", () => ({ type: "application/json", body: JSON.stringify(items) }));
  const res = ok(
    await extractor.read(
      recipe({
        tier: "jsonApi",
        list: { request: { url: "/wl", method: "GET" }, pagination: { type: "none" }, item: "$[*]", emptyText: [] },
        listFields: { id: { jsonPath: "$.id" }, url: { const: "/t/{id}" }, withdrawn: { jsonPath: "$.w" } },
      }),
      makeCtx(),
    ),
  );
  const withdrawn = Object.fromEntries(res.tenders.map((t) => [t.id, t.withdrawn]));
  assert.deepEqual(withdrawn, { a: true, b: undefined, c: true, d: true, e: undefined, f: undefined, g: undefined, h: undefined });
  for (const t of res.tenders) assert.ok(!("withdrawn" in t) || t.withdrawn === true);
  assert.equal(res.diagnostics.fieldFill.withdrawn, undefined);

  // Regex on a css cell: the match is the signal; detail rule also works; withdrawnText still works.
  routes.set("/wh", () => ({ body: table(row("R-1", "/wh/1", "Eins", "01.03.2026", "Status: Aufgehoben") + row("R-2", "/wh/2", "Zwei", "01.03.2026", "Status: offen") + row("R-3", "/wh/3", "Drei", "01.03.2026", "Status: offen")) }));
  routes.set("/wh/1", () => ({ body: page("<p>ok</p>") }));
  routes.set("/wh/2", () => ({ body: page('<p class="st">zurückgezogen</p>') }));
  routes.set("/wh/3", () => ({ body: page("<p>Vergabe eingestellt</p>") }));
  const html = ok(
    await extractor.read(
      recipe({
        list: { request: { url: "/wh", method: "GET" }, pagination: { type: "none" }, item: "tr.row", emptyText: [] },
        listFields: { id: { css: "td.ref" }, url: { css: "a", attr: "href" }, withdrawn: { css: "td:last-child", regex: "Aufgehoben" } },
        detail: { urlFrom: "url", fields: { withdrawn: { css: "p.st", regex: "zurückgezogen" } } },
        withdrawnText: ["eingestellt"],
      }),
      makeCtx(),
    ),
  );
  assert.deepEqual(html.tenders.map((t) => t.withdrawn), [true, true, true]);
  assert.equal(html.diagnostics.fieldFill.withdrawn, undefined);
});

test("withdrawn rule change invalidates cached detail results", async () => {
  routes.set("/wc", () => ({ type: "application/json", body: JSON.stringify([{ id: "x", w: true }]) }));
  routes.set("/wc/x", () => ({ type: "application/json", body: JSON.stringify({ ok: true }) }));
  const base1 = {
    tier: "jsonApi" as const,
    list: { request: { url: "/wc", method: "GET" as const }, pagination: { type: "none" as const }, item: "$[*]", emptyText: [] },
    detail: { urlFrom: "/wc/{id}", fields: {} },
  };
  const first = ok(await extractor.read(recipe({ ...base1, listFields: { id: { jsonPath: "$.id" }, url: { const: "/wc/{id}" } } }), makeCtx()));
  assert.equal(first.tenders[0]!.withdrawn, undefined);
  const second = ok(await extractor.read(recipe({ ...base1, listFields: { id: { jsonPath: "$.id" }, url: { const: "/wc/{id}" }, withdrawn: { jsonPath: "$.w" } } }), makeCtx()));
  assert.equal(second.tenders[0]!.withdrawn, true);
  assert.equal(hits.get("/wc/x"), 2, "a changed withdrawn rule must not reuse the cached detail");
});

// ------------------------------------------------------------ TenderNed recipe on fixtures

test("TenderNed recipe reads the saved fixtures offline: golden 450237 and withdrawn 449873", async () => {
  const dir = new URL("./recipes/", import.meta.url);
  const fixture = (name: string) => fs.readFileSync(new URL(`tenderned.fixtures/${name}`, dir), "utf8");
  const raw = fs.readFileSync(new URL("tenderned.json", dir), "utf8").replaceAll("https://www.tenderned.nl", base);
  const r = Recipe.parse(JSON.parse(raw));
  const api = "/papi/tenderned-rs-tns/v2/publicaties";
  let listQuery: URLSearchParams | null = null;
  routes.set(api, (u) => {
    listQuery ??= u.searchParams;
    const body = u.searchParams.get("page") === "0" ? fixture("list-page0.json") : JSON.stringify({ content: [], totalElements: 3 });
    return { type: "application/json", body };
  });
  routes.set(`${api}/450237`, () => ({ type: "application/json", body: fixture("detail-450237.json") }));
  routes.set(`${api}/450237/documenten`, () => ({ type: "application/json", body: fixture("documenten-450237.json") }));

  const res = ok(await extractor.read(r, makeCtx()));
  const q = listQuery as unknown as URLSearchParams;
  assert.equal(q.get("sluitingsDatumVanaf"), localDate("Europe/Amsterdam"));
  assert.equal(q.get("publicatieDatumVanaf"), null, "no date window: A never closes tenders older than a read saw");
  assert.equal(q.get("publicatieType"), "AAO");
  assert.equal(res.diagnostics.listPages, 2, "page 1 is empty and ends the list");
  assert.deepEqual(res.tenders.map((t) => t.id), ["450237", "450165", "449873"]);

  const golden = res.tenders.find((t) => t.id === "450237")!;
  const docs = JSON.parse(fixture("documenten-450237.json")) as { documenten: { links: { download: { href: string } } }[] };
  assert.deepEqual(golden, {
    id: "450237",
    url: "https://www.tenderned.nl/aankondigingen/overzicht/450237",
    title: "Verkenning route S106",
    buyerName: "Gemeente Rijswijk",
    publicationDate: "2026-11-20",
    submissionDeadline: "2026-12-18T12:00:00+01:00",
    referenceNumber: "SRA2601",
    description: golden.description,
    procedureType: "open",
    contractNature: "services",
    cpvCodes: ["71311300", "71311210", "71410000"],
    documentRefs: docs.documenten.map((d) => ({ url: base + d.links.download.href, via: "http" })),
  });
  assert.equal(golden.documentRefs.length, 3);
  assert.match(golden.description!, /^De gemeente Rijswijk, gemeente Den Haag en MRDH/);
  assert.equal(golden.withdrawn, undefined);

  const ended = res.tenders.find((t) => t.id === "449873")!;
  assert.equal(ended.withdrawn, true);
  assert.equal(ended.title, "Dagelijks onderhoud Vaarwegen (2027-2033)");
  assert.equal(ended.buyerName, "Provincie Overijssel");
  assert.equal(res.tenders.find((t) => t.id === "450165")!.withdrawn, undefined);
  assert.equal(res.diagnostics.fieldFill.withdrawn, undefined);
  assert.deepEqual(res.diagnostics.fieldFill.title, { filled: 3, total: 3 });
});
