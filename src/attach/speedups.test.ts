/**
 * Speed rules of the Cartographer: the browser only for JavaScript shells, the fast model for corrections,
 * small dry-runs, and a request budget for one whole attach. Local fake portal, scripted model, browser stub.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { attachWithModel, look, servedListSize, SERVED_LIST_MIN, type CartographerStep } from "./cartographer.js";
import { clearDetailCache, readSample } from "./extractor.js";
import type { ModelTier, PortalContext } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";

const routes = new Map<string, () => { status?: number; type?: string; body: string }>();
/** Requests per path, and every request in order. */
const hits = new Map<string, number>();
const log: string[] = [];
let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", base).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    log.push(req.url ?? "/");
    const r = routes.get(path)?.();
    res.writeHead(r ? (r.status ?? 200) : 404, { "content-type": r?.type ?? "text/html; charset=utf-8" });
    res.end(r ? r.body : "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // "localhost" keeps these portals out of the known-recipe registry.
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  routes.clear();
  hits.clear();
  log.length = 0;
  clearDetailCache();
});

const page = (body: string) => `<!doctype html><html><head><title>Vergabeportal</title></head><body>${body}</body></html>`;
const rows = (n: number, from = 0) =>
  Array.from(
    { length: n },
    (_, k) =>
      `<tr class="hit"><td class="nr">V-${100 + from + k}</td><td><a href="/s/t/${100 + from + k}">Sanierung ${from + k}</a></td><td class="buyer">Stadt Testheim</td><td class="pub">0${((from + k) % 9) + 1}.11.2026</td><td class="frist">15.12.2026 10:00</td></tr>`,
  ).join("");

/** A plain html portal: one list page with n rows, a tender page per row with one file and a label. */
function portal(n = 6) {
  for (let i = 0; i < n; i++)
    routes.set(`/s/t/${100 + i}`, () => ({ body: page(`<h1>Sanierung ${i}</h1><dl><dt>Vergabenummer</dt><dd>VG-${i}</dd></dl><a class="file" href="/s/f/${100 + i}.pdf">Unterlagen.pdf</a>`) }));
  routes.set("/s/list", () => ({ body: page(`<main><table class="results"><tbody>${rows(n)}</tbody></table></main>`) }));
}

const goodRecipe = (): Recipe =>
  Recipe.parse({
    schemaVersion: 1,
    tier: "html",
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    list: { request: { url: `${base}/s/list` }, pagination: { type: "none" }, item: "tr.hit" },
    listFields: {
      id: { css: "td.nr" },
      url: { css: "a", attr: "href" },
      title: { css: "a" },
      buyerName: { css: "td.buyer" },
      publicationDate: { css: "td.pub" },
      submissionDeadline: { css: "td.frist" },
    },
    documents: { hops: [], files: { css: "a.file", attr: "href", all: true }, via: "http" },
  });

const brokenRecipe = (): Recipe => ({ ...goodRecipe(), list: { ...goodRecipe().list, item: "tr.nope" } });

type Ctx = PortalContext & { prompts: string[]; tiers: ModelTier[]; logs: string[]; pages: number };

/** Scripted model that records tier and prompt; a browser stub that counts withPage calls. */
function scripted(url: string, steps: Array<CartographerStep | Error> = [], browserHtml?: string): Ctx {
  let i = 0;
  const c: Ctx = {
    portalId: "sp",
    url,
    http: { fetch: (u, init) => fetch(u, init) },
    browser: {
      async withPage(fn) {
        c.pages += 1;
        const fake = {
          on() {},
          async goto() {},
          async waitForLoadState() {},
          async content() {
            return browserHtml ?? page(`<div id="app">${"<p>rendered row</p>".repeat(30)}</div>`);
          },
        };
        return fn(fake as never);
      },
    },
    llm: {
      async json(opts) {
        c.prompts.push(opts.user);
        c.tiers.push(opts.model);
        const s = steps[i++];
        if (s === undefined) throw new Error("the script ran out of steps");
        if (s instanceof Error) throw s;
        return opts.schema.parse(s) as never;
      },
    },
    log: (m) => void c.logs.push(m),
    signal: new AbortController().signal,
    prompts: [],
    tiers: [],
    logs: [],
    pages: 0,
  };
  return c;
}

const step = (action: CartographerStep["action"], extra: Partial<CartographerStep> = {}): CartographerStep => ({ action, navigateTo: null, reason: "test", recipe: null, ...extra });

// ------------------------------------------------------------ 1. the browser only when needed

test("look skips the browser when the served page already lists enough linked items, and says so", async () => {
  portal(SERVED_LIST_MIN);
  const c = scripted(`${base}/s/list`);
  const l = await look(c, `${base}/s/list`);
  assert.equal(c.pages, 0, "withPage is never called");
  assert.equal(l.rendered, null);
  assert.deepEqual(l.json, []);
  assert.ok(
    c.logs.some((m) => new RegExp(`already lists ${SERVED_LIST_MIN} linked items; reading it without the browser`).test(m)),
    c.logs.join("\n"),
  );
  assert.equal(hits.get("/s/list"), 1, "one plain request");
});

test("look uses the browser for a JavaScript shell and for a list just below the threshold", async () => {
  routes.set("/s/app", () => ({ body: page('<div id="app"></div><script src="/s/bundle.js"></script>') }));
  const shell = scripted(`${base}/s/app`);
  const l = await look(shell, `${base}/s/app`);
  assert.equal(shell.pages, 1);
  assert.match(l.rendered ?? "", /rendered row/);
  assert.ok(!shell.logs.some((m) => /without the browser/.test(m)));

  portal(SERVED_LIST_MIN - 1);
  const short = scripted(`${base}/s/list`);
  await look(short, `${base}/s/list`);
  assert.equal(short.pages, 1, `${SERVED_LIST_MIN - 1} items are not enough to skip the browser`);
});

test("look never opens the browser on 401/403", async () => {
  routes.set("/s/closed", () => ({ status: 403, body: "Forbidden" }));
  const c = scripted(`${base}/s/closed`);
  const l = await look(c, `${base}/s/closed`);
  assert.equal(l.status, 403);
  assert.equal(c.pages, 0);
});

test("servedListSize counts linked items with text, and ignores menus and bare runs", () => {
  const items = (n: number, cls = "t") => Array.from({ length: n }, (_, i) => `<li class="${cls}"><a href="/t/${i}">Ausschreibung Straßenbau Los ${i}</a></li>`).join("");
  assert.equal(servedListSize(page(`<ul>${items(7)}</ul>`)), 7);
  // Menus in nav/header/footer are layout, not a list of tenders.
  assert.equal(servedListSize(page(`<nav><ul>${items(12)}</ul></nav><header><ul>${items(9)}</ul></header><footer><ul>${items(8)}</ul></footer><p>Bitte JavaScript aktivieren.</p>`)), 0);
  // Items without links, or with too little text, do not count.
  const noLinks = Array.from({ length: 10 }, (_, i) => `<li class="t">Ausschreibung Straßenbau Los ${i}</li>`).join("");
  assert.equal(servedListSize(page(`<ul>${noLinks}</ul>`)), 0);
  const shortText = Array.from({ length: 10 }, (_, i) => `<li class="t"><a href="/p/${i}">${i}</a></li>`).join("");
  assert.equal(servedListSize(page(`<ul>${shortText}</ul>`)), 0, "a pager is not a list of tenders");
  // A run is broken by an element with a different signature; the longest run wins.
  assert.equal(servedListSize(page(`<ul>${items(3)}<li class="ad">Werbung mit Link <a href="/x">hier</a></li>${items(4)}</ul>`)), 4);
  // The nav list must not add to the count of the real one.
  assert.equal(servedListSize(page(`<nav><ul>${items(20)}</ul></nav><main><ul>${items(5)}</ul></main>`)), 5);
});

// ------------------------------------------------------------ 2. which model writes which draft

test("model tiers: smart first, fast for the correction, smart again after a failed fast draft", async () => {
  portal(6);
  const c = scripted(`${base}/s/list`, [step("recipe", { recipe: brokenRecipe() }), step("recipe", { recipe: brokenRecipe() }), step("recipe", { recipe: brokenRecipe() }), step("recipe", { recipe: goodRecipe() })]);
  const out = await attachWithModel(c);
  assert.equal(out.kind, "ok", JSON.stringify(out).slice(0, 300));
  assert.deepEqual(c.tiers, ["smart", "fast", "smart", "fast"]);
  assert.ok(c.logs.some((m) => /draft 2 of 4, fast model/.test(m)), "the run log names the tier");
});

test("model tiers: a navigation resets to smart, so the first draft on the new page is smart", async () => {
  portal(6);
  routes.set("/s/home", () => ({ body: page('<a href="/s/list">Aktuelle Ausschreibungen</a>') }));
  // Draft on the landing page fails (smart) -> correction would be fast; the model navigates instead,
  // and the first draft on the real list is smart again.
  const c = scripted(`${base}/s/home`, [step("recipe", { recipe: brokenRecipe() }), step("navigate", { navigateTo: "/s/list" }), step("recipe", { recipe: brokenRecipe() }), step("recipe", { recipe: goodRecipe() })]);
  const out = await attachWithModel(c);
  assert.equal(out.kind, "ok", JSON.stringify(out).slice(0, 300));
  assert.equal(c.tiers[0], "smart");
  assert.equal(c.tiers[2], "smart", "first draft after a navigation");
  assert.equal(c.tiers[3], "fast", "its correction");
});

test("model tiers: a navigation as the first step keeps smart for the first draft", async () => {
  portal(6);
  routes.set("/s/home", () => ({ body: page('<a href="/s/list">Aktuelle Ausschreibungen</a>') }));
  const c = scripted(`${base}/s/home`, [step("navigate", { navigateTo: "/s/list" }), step("recipe", { recipe: goodRecipe() })]);
  assert.equal((await attachWithModel(c)).kind, "ok");
  assert.deepEqual(c.tiers, ["smart", "smart"]);
});

test("model tiers: a malformed answer does not switch the tier", async () => {
  portal(6);
  const c = scripted(`${base}/s/list`, [new SyntaxError("Unexpected token"), step("recipe", { recipe: goodRecipe() })]);
  assert.equal((await attachWithModel(c)).kind, "ok");
  assert.deepEqual(c.tiers, ["smart", "smart"]);
});

// ------------------------------------------------------------ 3. dry-runs stay small

test("readSample reads 1 list page and at most 3 tenders by default, even with pagination and a detail page", async () => {
  // Three list pages of 6 rows each; tender pages give a detail field and the files (one request each).
  for (let p = 1; p <= 3; p++) routes.set(`/s/list${p}`, () => ({ body: page(`<table><tbody>${rows(6, (p - 1) * 6)}</tbody></table>`) }));
  for (let i = 0; i < 18; i++) routes.set(`/s/t/${100 + i}`, () => ({ body: page(`<dl><dt>Vergabenummer</dt><dd>VG-${i}</dd></dl><a class="file" href="/s/f/${i}.pdf">x.pdf</a>`) }));
  const r = Recipe.parse({
    ...goodRecipe(),
    list: { request: { url: `${base}/s/list{page}` }, pagination: { type: "pageParam", start: 1, maxPages: 3 }, item: "tr.hit" },
    detail: { urlFrom: "url", fields: { referenceNumber: { label: "Vergabenummer" } } },
  });
  const out = await readSample(r, scripted(`${base}/s/list1`));
  assert.equal(out.kind, "ok", JSON.stringify(out).slice(0, 300));
  if (out.kind !== "ok") return;
  assert.equal(out.tenders.length, 3);
  assert.equal(out.tenders[0]!.referenceNumber, "VG-0");
  assert.deepEqual(out.tenders[0]!.documentRefs.map((d) => d.url), [`${base}/s/f/0.pdf`]);
  const listHits = [...hits].filter(([p]) => p.startsWith("/s/list")).reduce((a, [, n]) => a + n, 0);
  const tenderHits = [...hits].filter(([p]) => p.startsWith("/s/t/"));
  assert.equal(listHits, 1, `list pages: ${log.join(", ")}`);
  assert.equal(tenderHits.length, 3, "three tenders");
  assert.ok(tenderHits.every(([, n]) => n === 1), "detail and documents share one request per tender");
  assert.equal(out.diagnostics.requests, 4);
});

// ------------------------------------------------------------ 5. one whole attach has a request budget

test("one whole attach on an html portal stays within its request budget", async () => {
  const n = 8;
  portal(n);
  const c = scripted(`${base}/s/list`, [step("recipe", { recipe: goodRecipe() }), step("recipe", { recipe: goodRecipe() })]);
  const out = await attachWithModel(c);
  assert.equal(out.kind, "ok", JSON.stringify(out).slice(0, 300));
  if (out.kind !== "ok") return;
  assert.equal(out.read.tenders.length, n);
  assert.equal(c.pages, 0, "a served list needs no browser");
  // Budget: look (1 list) + per draft [dry-run (1 list + 3 tenders) + items for feedback/evidence (1 list)]
  // + one tender page for the model, once + the full read (1 list + the n - 3 tenders the dry-run did not cache).
  // Measured: 13 for one draft with n = 8, exactly this bound.
  // This portal needs 1 or 2 drafts (the first is held for optional-field hints only if the pages show some).
  const drafts = c.prompts.length;
  const perDraft = 1 + 3 + 1;
  const bound = 1 + drafts * perDraft + 1 + 1 + (n - 3);
  const total = log.length;
  assert.ok(total <= bound, `${total} requests for ${drafts} draft(s), budget ${bound}: ${log.join(", ")}`);
  assert.equal(hits.get("/s/f/100.pdf"), undefined, "documents are listed, never downloaded, while attaching");
  // Every tender page at most twice (dry-run or tender view, and the full read when not cached).
  for (let i = 0; i < n; i++) assert.ok((hits.get(`/s/t/${100 + i}`) ?? 0) <= 2, `tender ${i}: ${hits.get(`/s/t/${100 + i}`)}`);
});

test("a clean first draft on a page with no evidence gaps costs one model call", async () => {
  portal(6);
  const full = Recipe.parse({ ...goodRecipe(), detail: { urlFrom: "url", fields: { referenceNumber: { label: "Vergabenummer" } } } });
  const c = scripted(`${base}/s/list`, [step("recipe", { recipe: full })]);
  const out = await attachWithModel(c);
  assert.equal(out.kind, "ok", JSON.stringify(out).slice(0, 300));
  assert.equal(c.prompts.length, 1);
  // look 1 + sample (1 + 3) + items 1 + tender view 1 + full read (1 + 3 uncached)
  assert.ok(log.length <= 11, `${log.length} requests: ${log.join(", ")}`);
});
