/** The model-based Cartographer, with a scripted model and local portals. No real model, no external network. */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { attachWithModel, compressHtml, compressJson, judgeSample, largestObjectArray, look, MAX_RECIPE_ROUNDS, type CartographerStep } from "./cartographer.js";
import { cartographer } from "./index.js";
import { clearDetailCache, extractor } from "./extractor.js";
import type { ExtractedTender, PortalContext, ReadOutcome } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";

type Reply = { status?: number; type?: string; body: string };
const routes = new Map<string, () => Reply>();
let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    const r = routes.get(new URL(req.url ?? "/", base).pathname);
    res.writeHead(r ? (r().status ?? 200) : 404, { "content-type": r?.().type ?? "text/html; charset=utf-8" });
    res.end(r ? r().body : "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // "localhost" keeps these portals out of the known-recipe registry used by other tests.
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  routes.clear();
  clearDetailCache();
});

const page = (body: string) => `<!doctype html><html><head><title>Vergabeportal</title><script>var tracking = 1;</script></head><body>${body}</body></html>`;
const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => `<tr class="hit"><td class="nr">V-${100 + i}</td><td><a href="/m/t/${100 + i}">Sanierung ${i}</a></td><td class="buyer">Stadt Testheim</td><td class="pub">0${(i % 9) + 1}.11.2026</td><td class="frist">15.12.2026 10:00</td></tr>`).join("");

function portal(n = 6) {
  routes.set("/m/home", () => ({ body: page('<nav><a href="/m/list">Aktuelle Ausschreibungen</a><a href="/m/about">Über uns</a></nav><p>Willkommen</p>') }));
  routes.set("/m/list", () => ({ body: page(`<main><table class="results"><tbody>${rows(n)}</tbody></table></main>`) }));
}

const goodRecipe = (): Recipe =>
  Recipe.parse({
    schemaVersion: 1,
    tier: "html",
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    list: { request: { url: `${base}/m/list` }, pagination: { type: "none" }, item: "tr.hit" },
    listFields: {
      id: { css: "td.nr" },
      url: { css: "a", attr: "href" },
      title: { css: "a" },
      buyerName: { css: "td.buyer" },
      publicationDate: { css: "td.pub" },
      submissionDeadline: { css: "td.frist" },
    },
  });

/** A context whose model answers from a script and records every prompt. */
function scripted(url: string, steps: Array<CartographerStep | Error>): PortalContext & { prompts: string[]; logs: string[] } {
  const prompts: string[] = [];
  const logs: string[] = [];
  let i = 0;
  return {
    portalId: "pm",
    url,
    http: { fetch: (u, init) => fetch(u, init) },
    browser: {
      withPage() {
        throw new Error("no browser in this test");
      },
    },
    llm: {
      async json(opts) {
        assert.equal(opts.purpose, "attach");
        prompts.push(opts.user);
        const s = steps[i++];
        if (s === undefined) throw new Error("the script ran out of steps");
        if (s instanceof Error) throw s;
        return opts.schema.parse(s) as never;
      },
    },
    log: (m) => void logs.push(m),
    signal: new AbortController().signal,
    prompts,
    logs,
  };
}

const step = (action: CartographerStep["action"], extra: Partial<CartographerStep> = {}): CartographerStep => ({ action, navigateTo: null, reason: "test", recipe: null, ...extra });

test("navigates from a landing page, fixes a draft from exact feedback, then reads with no model call", async () => {
  portal(12);
  const broken = goodRecipe();
  broken.list.item = "tr.nope";
  const ctx = scripted(`${base}/m/home`, [step("navigate", { navigateTo: "/m/list" }), step("recipe", { recipe: broken }), step("recipe", { recipe: goodRecipe() })]);

  const out = await attachWithModel(ctx);
  assert.equal(out.kind, "ok", JSON.stringify(out));
  if (out.kind !== "ok") return;
  assert.equal(ctx.prompts.length, 3);
  assert.match(ctx.prompts[1]!, /Aktuelle Ausschreibungen -> .*\/m\/list|V-100/);
  assert.match(ctx.prompts[2]!, /list\.item "tr\.nope" matched nothing/, "the exact dry-run problem goes back");
  assert.equal(out.read.tenders.length, 12);
  assert.ok(out.golden.length >= 3 && out.golden.length <= 5);
  assert.equal(out.read.tenders[0]!.submissionDeadline, "2026-12-15T10:00:00+01:00");
  assert.match(out.note, /2 draft/);

  // From now on: no model.
  const calls = ctx.prompts.length;
  const again = await extractor.read(out.recipe, ctx);
  assert.equal(again.kind, "ok");
  assert.equal(ctx.prompts.length, calls);
});

test("the model sees a compressed page: no scripts, repeated rows collapsed to 2 with a count", async () => {
  portal(30);
  const ctx = scripted(`${base}/m/list`, [step("recipe", { recipe: goodRecipe() })]);
  await attachWithModel(ctx);
  const p = ctx.prompts[0]!;
  assert.ok(!p.includes("tracking"), "scripts are removed");
  assert.match(p, /28 more tr like these/);
  assert.ok(!p.includes("V-110"), "rows beyond the first two are not sent");
  assert.match(p, /Domain suggests|does not tell the country/);
});

test("a required field empty on every tender must be fixed in every draft (the watch checks reject it)", async () => {
  portal(6);
  const noBuyer = goodRecipe();
  delete noBuyer.listFields.buyerName;
  const ctx = scripted(`${base}/m/list`, [step("recipe", { recipe: noBuyer }), step("recipe", { recipe: noBuyer }), step("recipe", { recipe: goodRecipe() })]);
  const out = await attachWithModel(ctx);
  assert.equal(out.kind, "ok");
  assert.equal(ctx.prompts.length, 3, "the second draft without buyerName is not accepted either");
  assert.match(ctx.prompts[1]!, /No rule gives buyerName/);
  assert.match(ctx.prompts[2]!, /No rule gives buyerName/);
});

test("403 on the first page is blocked without any model call", async () => {
  routes.set("/m/secret", () => ({ status: 403, body: "Forbidden" }));
  const ctx = scripted(`${base}/m/secret`, []);
  const out = await attachWithModel(ctx);
  assert.deepEqual(out, { kind: "blocked", reason: "The portal answers 403 Forbidden: access needs a login or is refused." });
  assert.equal(ctx.prompts.length, 0);
});

test("a login page where the model gives up is reported as blocked, naming the login", async () => {
  routes.set("/m/login", () => ({ body: page('<form action="/m/login" method="post"><input name="user"><input type="password" name="pw"><button>Anmelden</button></form>') }));
  const ctx = scripted(`${base}/m/login`, [step("give_up", { reason: "Tenders are only listed after signing in." })]);
  const out = await attachWithModel(ctx);
  assert.equal(out.kind, "blocked");
  assert.match((out as { reason: string }).reason, /^The page shows a login form; tenders are only listed after signing in\.$/);
});

test(`stops after ${MAX_RECIPE_ROUNDS} drafts with the last problem in plain words`, async () => {
  portal(6);
  const broken = goodRecipe();
  broken.list.item = "div.never";
  const ctx = scripted(`${base}/m/list`, Array.from({ length: 10 }, () => step("recipe", { recipe: broken })));
  const out = await attachWithModel(ctx);
  assert.equal(ctx.prompts.length, MAX_RECIPE_ROUNDS, "1 draft + 3 corrections");
  assert.equal(out.kind, "failed");
  assert.match((out as { reason: string }).reason, /^Could not learn this portal in 4 drafts: list\.item "div\.never" matched nothing/);
});

test("a malformed answer gets another round; a provider error does not", async () => {
  portal(6);
  const bad = new SyntaxError("Unexpected token } in JSON");
  const ctx = scripted(`${base}/m/list`, [bad, step("recipe", { recipe: goodRecipe() })]);
  assert.equal((await attachWithModel(ctx)).kind, "ok");
  assert.match(ctx.prompts[1]!, /not a valid step/);

  const down = scripted(`${base}/m/list`, [new Error("503 Service Unavailable"), step("recipe", { recipe: goodRecipe() })]);
  const out = await attachWithModel(down);
  assert.equal(out.kind, "failed");
  assert.equal(down.prompts.length, 1);
  assert.match((out as { reason: string }).reason, /^The model call failed: 503/);
});

test("a browser-tier recipe is refused with a reason and counts as a draft", async () => {
  portal(6);
  const browserRecipe = { ...goodRecipe(), tier: "browser" as const };
  const ctx = scripted(`${base}/m/list`, [step("recipe", { recipe: browserRecipe }), step("recipe", { recipe: goodRecipe() })]);
  assert.equal((await attachWithModel(ctx)).kind, "ok");
  assert.match(ctx.prompts[1]!, /tier "browser" is not supported/);
});

test("cartographer.attach goes to the model for an unknown portal", async () => {
  portal(6);
  const ctx = scripted(`${base}/m/list`, [step("recipe", { recipe: goodRecipe() })]);
  const out = await cartographer.attach(ctx);
  assert.equal(out.kind, "ok");
  assert.equal(ctx.prompts.length, 1);
});

// ------------------------------------------------------------ pure parts

function t(i: number, fields: Partial<ExtractedTender> = {}): ExtractedTender {
  return {
    id: `T-${i}`,
    url: `https://p.test/t/${i}`,
    title: `Title ${i}`,
    buyerName: "Buyer",
    publicationDate: "2026-11-10",
    submissionDeadline: "2026-12-10T10:00:00+01:00",
    documentRefs: [],
    ...fields,
  };
}
const okRead = (tenders: ExtractedTender[]): ReadOutcome => ({
  kind: "ok",
  tenders,
  diagnostics: {
    requests: 1,
    listPages: 1,
    itemsSeen: tenders.length,
    durationMs: 1,
    fieldFill: Object.fromEntries(
      ["id", "url", "title", "buyerName", "publicationDate", "submissionDeadline"].map((f) => [f, { filled: tenders.filter((x) => (x as unknown as Record<string, unknown>)[f] != null).length, total: tenders.length }]),
    ),
  },
});

test("judgeSample catches row numbers, one url for all, links back to the list, and inverted dates", () => {
  const r = goodRecipe();
  const rowNumbers = judgeSample(r, okRead([1, 2, 3].map((i) => t(i, { id: String(i) }))), "https://p.test/list");
  assert.ok(rowNumbers.errors.some((e) => e.includes("row numbers")));

  const sameUrl = judgeSample(r, okRead([1, 2].map((i) => t(i, { url: "https://p.test/list?x=1" }))), "https://p.test/list");
  assert.ok(sameUrl.errors.some((e) => e.includes("same url")));
  assert.ok(sameUrl.errors.some((e) => e.includes("points back to the list")));

  const inverted = judgeSample(r, okRead([t(1, { publicationDate: "2026-12-20" })]), "https://p.test/list");
  assert.ok(inverted.errors.some((e) => e.includes("deadline before their publication date")));

  const clean = judgeSample(r, okRead([1, 2, 3].map((i) => t(i))), "https://p.test/list");
  assert.deepEqual(clean, { errors: [], warnings: [] });
});

test("judgeSample: an empty list with the portal's 'no results' text is not an error", () => {
  const read: ReadOutcome = { kind: "ok", tenders: [], diagnostics: { requests: 1, listPages: 1, itemsSeen: 0, fieldFill: {}, durationMs: 1, emptyStateText: "Keine Ergebnisse" } };
  assert.deepEqual(judgeSample(goodRecipe(), read, "https://p.test/").errors, []);
});

test("compressHtml keeps selector attributes and drops noise; compressJson cuts arrays to 2", () => {
  const html = page(`<div id="x" class="a b" style="color:red" onclick="evil()"><a href="/t/1" data-id="1">One</a></div><!-- secret comment -->`);
  const c = compressHtml(html);
  assert.match(c, /id="x"/);
  assert.match(c, /class="a b"/);
  assert.match(c, /href="\/t\/1"/);
  assert.match(c, /data-id="1"/);
  assert.ok(!/style=|onclick|secret comment|tracking/.test(c));

  const j = compressJson({ content: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }], total: 4 });
  assert.match(j, /…2 more items/);
  assert.equal(largestObjectArray({ page: { items: [{}, {}, {}, {}, {}] } }), 5);
});

test("look keeps JSON the page fetched, most list-like first", async () => {
  portal(3);
  const listJson = { items: Array.from({ length: 8 }, (_, i) => ({ id: i, title: `T${i}` })) };
  const fakePage = {
    handlers: [] as Array<(r: unknown) => void>,
    on(_ev: string, h: (r: unknown) => void) {
      this.handlers.push(h);
    },
    async goto() {
      const resp = (url: string, data: unknown) => ({
        url: () => url,
        headers: () => ({ "content-type": "application/json" }),
        text: async () => JSON.stringify(data),
        request: () => ({ resourceType: () => "xhr", method: () => "GET", postData: () => null }),
      });
      for (const h of this.handlers) {
        h(resp(`${base}/api/config`, { theme: "dark" }));
        h(resp(`${base}/api/search?page=0`, listJson));
      }
      await new Promise((r) => setTimeout(r, 20));
    },
    async waitForLoadState() {},
    async content() {
      return page(`<div id='app'>rendered ${"<p>row</p>".repeat(30)}</div>`);
    },
  };
  const ctx = scripted(`${base}/m/list`, []);
  ctx.browser = { withPage: (fn) => fn(fakePage as never) };
  const l = await look(ctx, `${base}/m/list`);
  assert.equal(l.json.length, 1, "only list-like JSON is kept");
  assert.equal(l.json[0]!.url, `${base}/api/search?page=0`);
  assert.match(l.rendered ?? "", /rendered/);
});

test("feedback shows the model the first item exactly as its rules see it", async () => {
  portal(6);
  const noTitle = goodRecipe();
  noTitle.listFields.title = { css: "h3.title" };
  const ctx = scripted(`${base}/m/list`, [step("recipe", { recipe: noTitle }), step("recipe", { recipe: goodRecipe() })]);
  assert.equal((await attachWithModel(ctx)).kind, "ok");
  assert.match(ctx.prompts[1]!, /The first item list\.item matched, exactly as your field rules see it/);
  assert.match(ctx.prompts[1]!, /<td class="nr">V-100<\/td>/);
});

test("a login box in the header does not make a readable portal 'blocked'", async () => {
  routes.set("/m/list", () => ({
    body: page(`<header><form><input type="password" name="pw"></form></header><table><tbody>${rows(6)}</tbody></table>`),
  }));
  const noTitle = goodRecipe();
  noTitle.listFields.title = { css: "h3.title" };
  const ctx = scripted(`${base}/m/list`, Array.from({ length: MAX_RECIPE_ROUNDS }, () => step("recipe", { recipe: noTitle })));
  const out = await attachWithModel(ctx);
  assert.equal(out.kind, "failed", "the list was read, so the login box is not the problem");
  assert.match((out as { reason: string }).reason, /title found on only 0 of/);
});

test("robots.txt on the given address: look at the home page and tell the model to stay off it", async () => {
  portal(6);
  routes.set("/", () => ({ body: page('<a href="/m/list">Ausschreibungen</a>') }));
  const ctx = scripted(`${base}/m/forbidden`, [step("recipe", { recipe: goodRecipe() })]);
  const realFetch = ctx.http.fetch;
  ctx.http = {
    fetch: (u, init) => (new URL(u).pathname.startsWith("/m/forbidden") ? Promise.reject(new Error("robots.txt disallows /m/forbidden")) : realFetch(u, init)),
  };
  const out = await attachWithModel(ctx);
  assert.equal(out.kind, "ok");
  assert.match(ctx.prompts[0]!, /robots\.txt forbids the address the operator gave/);
  assert.match(ctx.prompts[0]!, /Ausschreibungen -> /);
});

test("look keeps the rendered page when loading times out", async () => {
  portal(3);
  const slowPage = {
    on() {},
    async goto() {
      throw new Error("Timeout 45000ms exceeded");
    },
    async waitForLoadState() {},
    async content() {
      return page(`<div id='app'>${"<p>row</p>".repeat(40)}</div>`);
    },
  };
  const ctx = scripted(`${base}/m/list`, []);
  ctx.browser = { withPage: (fn) => fn(slowPage as never) };
  const l = await look(ctx, `${base}/m/list`);
  assert.match(l.rendered ?? "", /id='app'|id="app"/);
});

test("a long page puts the repeated list first, with where it lives", () => {
  const nav = `<nav>${Array.from({ length: 400 }, (_, i) => `<span class="m${i}">Menüpunkt ${i} mit etwas Text</span>`).join("")}</nav>`;
  const html = page(`${nav}<main id="content"><ul class="tenders">${Array.from({ length: 40 }, (_, i) => `<li class="t"><a href="/t/${i}">Ausschreibung Nummer ${i} Straßenbau</a></li>`).join("")}</ul></main>`);
  const c = compressHtml(html, 4000);
  assert.ok(c.length <= 4100);
  assert.match(c, /longest repeated list on the page \(40 similar items\) is inside: .*main#content > ul\.tenders/);
  assert.ok(c.indexOf("Ausschreibung Nummer 0") < c.indexOf("Menüpunkt 0"), "the list comes before the long navigation");
});

test("give up on a page with a login box is 'failed' unless the model names the login", async () => {
  routes.set("/m/hdr", () => ({ body: page('<header><input type="password"></header><p>Nothing listed here</p>') }));
  const notBlock = scripted(`${base}/m/hdr`, [step("give_up", { reason: "The list is only shown after a JavaScript search." })]);
  assert.equal((await attachWithModel(notBlock)).kind, "failed");
  const block = scripted(`${base}/m/hdr`, [step("give_up", { reason: "Tenders are only shown after you log in." })]);
  assert.equal((await attachWithModel(block)).kind, "blocked");
});
