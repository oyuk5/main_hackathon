/**
 * Browser tier: a JavaScript-only fake portal (the served HTML has no rows), read through the real
 * polite browser (1 request/second, robots.txt). Slow by nature: every page waits for the gate.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extractor, clearDetailCache, sampleItems } from "./extractor.js";
import { closeSharedBrowser, politeBrowser, politeHttp } from "../platform/polite.js";
import type { PortalContext } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";

const TENDERS = [
  { id: "A1", title: "Brücke Nord", buyer: "Stadt Köln", pub: "09.12.2026", deadline: "15.12.2026 10:00" },
  { id: "A2", title: "Schule Süd", buyer: "Stadt Bonn", pub: "10.12.2026", deadline: "16.12.2026 14:30" },
  { id: "B1", title: "Straße West", buyer: "Kreis Aachen", pub: "11.12.2026", deadline: "17.12.2026 09:00" },
];
const PAGE_SIZE = 2;

/** The list shell: rows come from /api/list, "Weiter" re-renders the next page in place. */
const LIST_SHELL = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<main><ul id="list"></ul><button id="next">Weiter</button></main>
<script>
let page = 1;
async function show() {
  const data = await (await fetch("/api/list?page=" + page)).json();
  document.getElementById("list").innerHTML = data.items.map((t) =>
    '<li class="t"><a href="/tender/' + t.id + '">' + t.title + '</a><span class="buyer">' + t.buyer +
    '</span><span class="pub">' + t.pub + '</span><span class="dl">' + t.deadline + '</span></li>').join("");
  document.getElementById("next").disabled = !data.more;
}
document.getElementById("next").addEventListener("click", () => { page += 1; show(); });
show();
</script></body></html>`;

/** Detail page: the reference number is written by JavaScript; one plain file link, one JS-only button. */
const detail = (id: string) => `<!doctype html><html><body><h1>${id}</h1><p>Aktenzeichen: <span id="ref">wird geladen</span></p>
<a class="doc" href="/files/${id}.pdf">${id}.pdf</a> <button class="doc" onclick="location.href='/files/${id}-extra.zip'">Unterlagen</button>
<script>setTimeout(() => { document.getElementById("ref").textContent = "VG-${id}"; }, 50);</script></body></html>`;

/** Login wall rendered by JavaScript: no rows, a password field. */
const LOGIN_SHELL = `<!doctype html><html><body><div id="app"></div><script>
document.getElementById("app").innerHTML = '<form><input name="user"><input type="password" name="pw"><button>Anmelden</button></form>';
</script></body></html>`;

let server: http.Server;
let base = "";
const hits: string[] = [];
let llmCalls = 0;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(url.pathname + url.search);
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    if (url.pathname === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /private\n");
    if (url.pathname === "/list") return html(LIST_SHELL);
    if (url.pathname === "/login") return html(LOGIN_SHELL);
    if (url.pathname === "/api/list") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const items = TENDERS.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ items, more: page * PAGE_SIZE < TENDERS.length }));
    }
    const m = /^\/tender\/(\w+)$/.exec(url.pathname);
    if (m) return html(detail(m[1]!));
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await closeSharedBrowser();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  assert.equal(llmCalls, 0, "browser reads must never call the model");
});

beforeEach(() => {
  clearDetailCache();
  hits.length = 0;
});

let portalSeq = 0;
function makeCtx(controller = new AbortController()) {
  const logs: string[] = [];
  const ctx: PortalContext = {
    portalId: `browser-test-${++portalSeq}`,
    url: `${base}/list`,
    http: politeHttp(controller.signal),
    browser: politeBrowser(controller.signal),
    llm: {
      json: async () => {
        llmCalls += 1;
        throw new Error("no model calls in a read");
      },
    },
    log: (m) => void logs.push(m),
    signal: controller.signal,
  };
  return { ctx, logs, controller };
}

function recipe(over: Partial<Record<string, unknown>> = {}): Recipe {
  return Recipe.parse({
    schemaVersion: 1,
    tier: "browser",
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    list: {
      request: { url: `${base}/list` },
      pagination: { type: "clickNext", selector: "#next", maxPages: 5 },
      item: "li.t",
    },
    listFields: {
      id: { css: "a", attr: "href", regex: "/tender/(\\w+)" },
      url: { css: "a", attr: "href" },
      title: { css: "a" },
      buyerName: { css: ".buyer" },
      publicationDate: { css: ".pub" },
      submissionDeadline: { css: ".dl" },
    },
    detail: { urlFrom: "url", fields: { referenceNumber: { label: "Aktenzeichen" } } },
    documents: { files: { css: ".doc" } },
    ...over,
  });
}

describe("browser tier", { timeout: 120_000 }, () => {
  it("reads a JavaScript-rendered list across clickNext pages, with detail pages and documents", async () => {
    const { ctx } = makeCtx();
    const out = await extractor.read(recipe(), ctx);
    assert.equal(out.kind, "ok", JSON.stringify(out));
    if (out.kind !== "ok") return;

    assert.deepEqual(out.tenders.map((t) => t.id), ["A1", "A2", "B1"]);
    const a1 = out.tenders[0]!;
    assert.equal(a1.url, `${base}/tender/A1`);
    assert.equal(a1.title, "Brücke Nord");
    assert.equal(a1.buyerName, "Stadt Köln");
    assert.equal(a1.publicationDate, "2026-12-09");
    assert.equal(a1.submissionDeadline, "2026-12-15T10:00:00+01:00");
    assert.equal(a1.referenceNumber, "VG-A1", "the detail page is rendered before it is read");
    assert.ok(!a1.documentRefsPending);
    assert.deepEqual(a1.documentRefs, [
      { url: `${base}/files/A1.pdf`, via: "http", fileNameHint: "A1.pdf" },
      { url: `${base}/tender/A1`, via: "browser", clickPath: [".doc >> nth=1"] },
    ]);

    assert.equal(out.diagnostics.listPages, 2);
    assert.equal(out.diagnostics.itemsSeen, 3);
    assert.ok(out.diagnostics.listSkeletonHash);
    assert.deepEqual(out.diagnostics.fieldFill.referenceNumber, { filled: 3, total: 3 });
    assert.deepEqual(out.diagnostics.fieldFill.submissionDeadline, { filled: 3, total: 3 });
    assert.ok(out.diagnostics.requests >= 6, `requests counted: ${out.diagnostics.requests}`);
    // Page 2 came from clicking, not from a second list URL.
    assert.equal(hits.filter((h) => h === "/list").length, 1);
    assert.ok(hits.includes("/api/list?page=2"));
  });

  it("a JavaScript login form with no rows is blocked", async () => {
    const { ctx } = makeCtx();
    const out = await extractor.read(recipe({ list: { request: { url: `${base}/login` }, pagination: { type: "none" }, item: "li.t" } }), ctx);
    assert.equal(out.kind, "blocked");
    if (out.kind === "blocked") assert.match(out.reason, /login/);
  });

  it("robots.txt disallowing the list page is blocked", async () => {
    const { ctx } = makeCtx();
    const out = await extractor.read(recipe({ list: { request: { url: `${base}/private/list` }, pagination: { type: "none" }, item: "li.t" } }), ctx);
    assert.equal(out.kind, "blocked", JSON.stringify(out));
  });

  it("an abort stops the read and no more pages are requested", async () => {
    const { ctx, controller } = makeCtx();
    const reading = extractor.read(recipe(), ctx);
    // Abort once the first page asked for its rows.
    const t0 = Date.now();
    while (!hits.includes("/api/list?page=1") && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const out = await reading;
    assert.equal(out.kind, "error");
    if (out.kind === "error") assert.match(out.reason, /cancelled/);
    const seen = hits.length;
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(hits.length, seen, "no request after the abort");
    assert.ok(!hits.some((h) => h.startsWith("/tender/")));
  });

  it("sampleItems renders the page for the Cartographer", async () => {
    const { ctx } = makeCtx();
    const s = await sampleItems(recipe(), ctx, 2);
    assert.equal(s.status, 200);
    assert.equal(s.items.length, 2);
    assert.match(s.items[0]!, /Brücke Nord/);
  });
});
