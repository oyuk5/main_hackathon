/** CPV feedback: where the codes are, a rule checked on the page, and never codes from other tenders. Local portals, scripted model. */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { attachWithModel, cpvHint, locateCpv, readCpvRule, type CartographerStep } from "./cartographer.js";
import { clearDetailCache } from "./extractor.js";
import type { PortalContext } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";

const routes = new Map<string, string>();
let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    const body = routes.get(new URL(req.url ?? "/", base).pathname);
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
    res.end(body ?? "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  routes.clear();
  clearDetailCache();
});

const page = (body: string) => `<!doctype html><html><head><title>Portal</title></head><body>${body}</body></html>`;

/** Tender pages in three layouts and languages; the footer lists codes of other tenders. */
const LAYOUTS = {
  pl: (i: number) =>
    `<main><h1>Remont drogi ${i}</h1><table class="szczegoly"><tr><th>Numer</th><td>ZP.271.${i}.2026</td></tr><tr><th>Kod CPV</th><td>45233140-2, 45233142-6</td></tr></table><a class="file" href="/f/${i}.pdf">SWZ.pdf</a></main>`,
  de: (i: number) =>
    `<main><h1>Sanierung ${i}</h1><dl class="daten"><dt>Vergabenummer</dt><dd>V-${i}</dd><dt>CPV-Codes:</dt><dd><ul><li>45000000-7</li><li>45210000-2</li></ul></dd></dl><a class="file" href="/f/${i}.pdf">Unterlagen.pdf</a></main>`,
  fr: (i: number) =>
    `<main><h1>Travaux ${i}</h1><div class="bloc"><p class="cpv">Code CPV : 45233140-2</p></div><a class="file" href="/f/${i}.pdf">DCE.pdf</a></main>`,
} as const;
const FOOTER = `<footer><h4>Autres marchés</h4><ul><li>Nettoyage 90910000-9</li><li>Fournitures 30192000-1</li></ul></footer>`;

function ctxWith(steps: CartographerStep[] = []): PortalContext & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    portalId: "cpv",
    url: `${base}/list`,
    http: { fetch: (u, init) => fetch(u, init) },
    browser: {
      withPage() {
        throw new Error("no browser in this test");
      },
    },
    llm: {
      async json(opts) {
        prompts.push(opts.user);
        const s = steps[i++];
        if (!s) throw new Error("the script ran out of steps");
        return opts.schema.parse(s) as never;
      },
    },
    log: () => {},
    signal: new AbortController().signal,
    prompts,
  };
}

test("locates CPV codes in a table row, a definition list and inline text, with the label as shown", () => {
  const pl = locateCpv(page(LAYOUTS.pl(1)))!;
  assert.equal(pl.label, "Kod CPV");
  assert.deepEqual(pl.codes, ["45233140", "45233142"]);
  assert.match(pl.markup, /<th>Kod CPV<\/th>\s*<td>45233140-2, 45233142-6<\/td>/);
  assert.equal(pl.oneBlock, true);

  const de = locateCpv(page(LAYOUTS.de(1)))!;
  assert.equal(de.label, "CPV-Codes");
  assert.deepEqual(de.codes, ["45000000", "45210000"]);
  assert.match(de.markup, /<dt>CPV-Codes:<\/dt>/);

  const fr = locateCpv(page(LAYOUTS.fr(1)))!;
  assert.equal(fr.label, "Code CPV");
  assert.equal(fr.css, "p.cpv");
  assert.deepEqual(fr.codes, ["45233140"]);
});

test("codes only in a footer or a related-tenders box are not the tender's", () => {
  assert.equal(locateCpv(page(`<main><h1>X</h1></main>${FOOTER}`)), null);
  assert.equal(locateCpv(page(`<main><h1>X</h1><div class="related-tenders"><p>45000000-7</p></div></main>`)), null);
  const both = locateCpv(page(LAYOUTS.de(1) + FOOTER))!;
  assert.deepEqual(both.codes, ["45000000", "45210000"]);
  assert.equal(both.oneBlock, false, "the footer's codes are elsewhere, so a page-wide regex is not safe");
});

test("the hint shows the markup and only rules the Extractor really resolves on that page", async () => {
  const ctx = ctxWith();
  for (const [lang, make] of Object.entries(LAYOUTS)) {
    const p = { url: `${base}/t/${lang}`, body: page(make(1) + FOOTER) };
    const hint = (await cpvHint(p, "detail.fields", ctx, { label: "Kody CPV", all: true, parse: "cpv" }))!;
    assert.match(hint, /do not remove it/, lang);
    const rule = JSON.parse(hint.match(/"cpvCodes": (\{.*?\}) in/)![1]!);
    const got = await readCpvRule(rule, p, ctx);
    assert.ok(got.length > 0, `${lang}: the suggested rule reads codes`);
    assert.ok(!got.includes("90910000") && !got.includes("30192000"), `${lang}: never the footer's codes`);
    assert.doesNotMatch(hint, /\\\\d\{8\}/, `${lang}: no page-wide regex while the footer has codes too`);
  }
  // Without other codes on the page, the regex fallback is offered too, and it reads every code of the block.
  const p = { url: `${base}/t/x`, body: page(LAYOUTS.pl(1)) };
  const hint = (await cpvHint(p, "detail.fields", ctx, null))!;
  assert.match(hint, /^For cpvCodes/);
  assert.match(hint, /Also works: .*regex/);
  assert.deepEqual(await readCpvRule({ regex: "((?:\\d{8}(?:\\s?-\\s?\\d)?[\\s,;/]*)+)", all: true, parse: "cpv" }, p, ctx), ["45233140", "45233142"]);
});

function portal(layout: (i: number) => string) {
  const rows = Array.from({ length: 4 }, (_, i) => `<tr class="hit"><td class="nr">T-${i}</td><td><a href="/t/${i}">Auftrag ${i}</a></td><td class="buyer">Stadt X</td><td class="pub">02.11.2026</td><td class="frist">15.12.2026 10:00</td></tr>`).join("");
  routes.set("/list", page(`<table><tbody>${rows}</tbody></table>`));
  for (let i = 0; i < 4; i++) routes.set(`/t/${i}`, page(layout(i) + FOOTER));
}

const recipe = (cpv: Record<string, unknown>): Recipe =>
  Recipe.parse({
    schemaVersion: 1,
    tier: "html",
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    list: { request: { url: `${base}/list` }, pagination: { type: "none" }, item: "tr.hit" },
    listFields: {
      id: { css: "td.nr" },
      url: { css: "a", attr: "href" },
      title: { css: "a" },
      buyerName: { css: "td.buyer" },
      publicationDate: { css: "td.pub" },
      submissionDeadline: { css: "td.frist" },
    },
    detail: { urlFrom: "url", fields: { cpvCodes: cpv } },
    documents: { hops: [], files: { css: "a.file", attr: "href", all: true }, via: "http" },
  });

const step = (r: Recipe): CartographerStep => ({ action: "recipe", navigateTo: null, reason: "test", recipe: r });

for (const [lang, layout] of Object.entries(LAYOUTS)) {
  test(`a cpvCodes rule that finds nothing gets the located markup and a checked rule; using it fills cpvCodes (${lang})`, async () => {
    portal(layout);
    // The model copies the rule it is shown in the feedback.
    const probe = await cpvHint({ url: `${base}/t/0`, body: page(layout(0) + FOOTER) }, "detail.fields", ctxWith(), { css: ".nope" });
    const suggested = JSON.parse(probe!.match(/"cpvCodes": (\{.*?\}) in/)![1]!);
    const ctx = ctxWith([step(recipe({ label: "Kody CPV", all: true, parse: "cpv" })), step(recipe(suggested))]);
    const out = await attachWithModel(ctx);
    assert.equal(out.kind, "ok", JSON.stringify(out));
    if (out.kind !== "ok") return;
    const feedback = ctx.prompts[1]!;
    assert.match(feedback, /found no value on any sampled tender, but the portal does show CPV codes\. Fix it; do not remove it/);
    assert.doesNotMatch(feedback, /or remove the rule/);
    assert.match(feedback, /CPV/);
    assert.match(feedback, /Checked on that page, this rule reads exactly those codes/);
    const want = lang === "de" ? ["45000000", "45210000"] : lang === "pl" ? ["45233140", "45233142"] : ["45233140"];
    for (const t of out.read.tenders) assert.deepEqual(t.cpvCodes, want);
  });
}

test("no cpvCodes rule: the first draft is told where the codes are", async () => {
  portal(LAYOUTS.pl);
  const r = recipe({});
  r.detail = null;
  const ctx = ctxWith([step(r), step(recipe({ label: "Kod CPV", all: true, parse: "cpv" }))]);
  const out = await attachWithModel(ctx);
  assert.equal(out.kind, "ok", JSON.stringify(out));
  assert.match(ctx.prompts[1]!, /For cpvCodes \(no rule yet\):\nThe tender.s own page .* shows CPV codes/);
  assert.match(ctx.prompts[1]!, /"cpvCodes": \{"label":"Kod CPV","all":true,"parse":"cpv"\} in detail\.fields/);
});

test("a page whose only codes are in the footer gets no CPV hint", async () => {
  portal(() => `<main><h1>Auftrag</h1><a class="file" href="/f/1.pdf">U.pdf</a></main>`);
  const r = recipe({});
  r.detail = null;
  const ctx = ctxWith([step(r)]);
  const out = await attachWithModel(ctx);
  // The draft passes or fails on other grounds; no prompt claims the codes are the tender's.
  for (const p of ctx.prompts.slice(1)) assert.doesNotMatch(p, /shows CPV codes/);
  assert.notEqual(out.kind, "blocked");
});
