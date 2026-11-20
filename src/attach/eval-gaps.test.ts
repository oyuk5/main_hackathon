/**
 * Gaps D's eval found (Fri 22:28): documents listed inside JSON list items, cancelled tenders read as
 * open, optional fields the pages show but recipes leave out. Local fake portal; scripted model.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { clearDetailCache, extractor } from "./extractor.js";
import { attachWithModel, missingOptionalFields, missingWithdrawnRule, type CartographerStep } from "./cartographer.js";
import type { PortalContext, ReadOutcome } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";

const routes = new Map<string, () => { type?: string; body: string }>();
const hits = new Map<string, number>();
let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", base).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const r = routes.get(path)?.();
    res.writeHead(r ? 200 : 404, { "content-type": r?.type ?? "text/html; charset=utf-8" });
    res.end(r ? r.body : "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // "localhost" keeps these out of the known-recipe registry other tests use.
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  routes.clear();
  hits.clear();
  clearDetailCache();
});

const json = (v: unknown) => () => ({ type: "application/json", body: JSON.stringify(v) });
const page = (b: string) => () => ({ body: `<!doctype html><html><body>${b}</body></html>` });

/** A ville-like JSON list: each item carries its own files and a cancelled flag. */
function villeLike() {
  const items = [0, 1, 2].map((i) => ({
    id: `c-${i}`,
    intitule: `Marché ${i}`,
    acheteur: { nom: "Ville de Test" },
    datePublication: "2026-11-19",
    dateLimiteRemise: "2026-12-02 12:00",
    procedure: "Appel d'offres ouvert",
    nature: "Travaux",
    codesCpv: ["45321000-3"],
    objet: `Objet du marché ${i}`,
    annulee: i === 2,
    pieces: [{ nom: `RC_${i}.pdf`, lien: `/v/api/c-${i}/pieces/RC_${i}.pdf` }],
  }));
  routes.set("/v/api/list", json({ resultats: items }));
  for (let i = 0; i < 3; i++) routes.set(`/v/consultation/c-${i}`, page('<main id="app"><noscript>Activez JavaScript.</noscript></main>'));
}

const villeRecipe = (extra: Partial<Recipe> = {}): Recipe =>
  Recipe.parse({
    schemaVersion: 1,
    tier: "jsonApi",
    timeZone: "Europe/Paris",
    countryCode: "FR",
    list: { request: { url: `${base}/v/api/list` }, pagination: { type: "none" }, item: "$.resultats[*]" },
    listFields: {
      id: { jsonPath: "$.id" },
      url: { const: `${base}/v/consultation/{id}`, parse: "url" },
      title: { jsonPath: "$.intitule" },
      buyerName: { jsonPath: "$.acheteur.nom" },
      publicationDate: { jsonPath: "$.datePublication" },
      submissionDeadline: { jsonPath: "$.dateLimiteRemise" },
    },
    documents: { hops: [], files: { jsonPath: "$.pieces[*].lien", all: true }, via: "http" },
    ...extra,
  });

function ctx(steps: CartographerStep[] = []): PortalContext & { prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  return {
    portalId: "pg",
    url: `${base}/v/api/list`,
    http: { fetch: (u, init) => fetch(u, init) },
    browser: { withPage: () => Promise.reject(new Error("no browser here")) },
    llm: {
      async json(opts) {
        prompts.push(opts.user);
        const s = steps[i++];
        if (!s) throw new Error("script ran out");
        return opts.schema.parse(s) as never;
      },
    },
    log: () => {},
    signal: new AbortController().signal,
    prompts,
  };
}

const ok = (r: ReadOutcome) => {
  assert.equal(r.kind, "ok", JSON.stringify(r).slice(0, 300));
  return r as Extract<ReadOutcome, { kind: "ok" }>;
};

// ------------------------------------------------------------ documents inside JSON list items

test("files listed in a JSON list item are read from the item, with no request to the tender page", async () => {
  villeLike();
  const res = ok(await extractor.read(villeRecipe(), ctx()));
  assert.equal(res.tenders.length, 3);
  assert.deepEqual(res.tenders[0]!.documentRefs.map((r) => r.url), [`${base}/v/api/c-0/pieces/RC_0.pdf`]);
  assert.equal(res.tenders[0]!.documentRefsPending, undefined);
  assert.equal(hits.get("/v/consultation/c-0"), undefined, "the JavaScript-only tender page is never fetched");
});

// ------------------------------------------------------------ cancelled tenders

test("missingWithdrawnRule: asks for a rule when the portal marks cancellations, not when the recipe has one", () => {
  const texts = ['{"id":"c-2","annulee":true}'];
  assert.match(missingWithdrawnRule(villeRecipe(), texts)!, /marks cancelled tenders/);
  assert.equal(missingWithdrawnRule(villeRecipe({ listFields: { ...villeRecipe().listFields, withdrawn: { jsonPath: "$.annulee" } } }), texts), null);
  assert.equal(missingWithdrawnRule(villeRecipe({ withdrawnText: ["Aufgehoben"] }), ["<td>Aufgehoben</td>"]), null);
  assert.match(missingWithdrawnRule(villeRecipe(), ["<td>Status</td><td>Aufgehoben</td>"])!, /"Aufgehoben"/);
  assert.equal(missingWithdrawnRule(villeRecipe(), ["<td>Offen</td>"]), null, "no cancellation words: no requirement");
  assert.match(
    missingWithdrawnRule(villeRecipe({ withdrawnText: ["Ausschreibung aufgehoben"] }), ["<td>Aufgehoben</td><p>Dieses Verfahren wurde aufgehoben.</p>"])!,
    /appears nowhere on the pages/,
    "words the portal never shows do not count",
  );
});

test("a draft without a withdrawn rule is sent back when the list marks cancellations; the corrected one reads 'withdrawn'", async () => {
  villeLike();
  const withRule = villeRecipe({ listFields: { ...villeRecipe().listFields, withdrawn: { jsonPath: "$.annulee" } } });
  const all = { ...withRule, listFields: { ...withRule.listFields, procedureType: { jsonPath: "$.procedure" }, contractNature: { jsonPath: "$.nature" }, cpvCodes: { jsonPath: "$.codesCpv", all: true }, description: { jsonPath: "$.objet" } } };
  const step = (recipe: Recipe): CartographerStep => ({ action: "recipe", navigateTo: null, reason: "t", recipe });
  const noWithdrawn = { ...all, listFields: Object.fromEntries(Object.entries(all.listFields).filter(([k]) => k !== "withdrawn")) };
  const c = ctx([step(noWithdrawn), step(all)]);
  const out = await attachWithModel(c);
  assert.equal(out.kind, "ok", JSON.stringify(out).slice(0, 300));
  assert.equal(c.prompts.length, 2);
  assert.match(c.prompts[1]!, /marks cancelled tenders/);
  if (out.kind === "ok") assert.equal(out.read.tenders.find((t) => t.id === "c-2")!.withdrawn, true);
});

// ------------------------------------------------------------ optional fields

test("missingOptionalFields names what the pages show and the recipe leaves out", () => {
  const texts = ['<dl><dt>Verfahrensart</dt><dd>Offenes Verfahren</dd><dt>CPV-Code</dt><dd>45000000-7</dd><dt>Ort der Ausführung</dt><dd>12345 Lindenau</dd></dl>'];
  const hint = missingOptionalFields(villeRecipe(), texts)!;
  assert.match(hint, /CPV codes/);
  assert.match(hint, /the procedure type/);
  assert.match(hint, /the place of performance/);
  assert.match(hint, /no rule for cpvCodes, procedureType, postalCode\/city/);
  const mapped = villeRecipe({ detail: { urlFrom: "url", fields: { cpvCodes: { label: "CPV-Code", all: true }, procedureType: { label: "Verfahrensart" }, city: { label: "Ort der Ausführung" } } } });
  assert.equal(missingOptionalFields(mapped, texts), null);
  assert.equal(missingOptionalFields(villeRecipe(), ["<p>Nur ein Titel</p>"]), null);
});

test("drafts that leave out optional fields the items show get the hint twice, then are accepted", async () => {
  villeLike();
  const base1 = villeRecipe({ listFields: { ...villeRecipe().listFields, withdrawn: { jsonPath: "$.annulee" } } });
  const step = (recipe: Recipe): CartographerStep => ({ action: "recipe", navigateTo: null, reason: "t", recipe });
  const c = ctx([step(base1), step(base1), step(base1)]);
  const out = await attachWithModel(c);
  assert.equal(out.kind, "ok");
  assert.equal(c.prompts.length, 3, "two extra drafts at most");
  assert.match(c.prompts[1]!, /seems to show .*CPV codes/);
  assert.match(c.prompts[2]!, /seems to show .*CPV codes/);
});

test("an optional rule that finds no value on any sampled tender must be fixed or removed", async () => {
  villeLike();
  const withdrawn = { ...villeRecipe().listFields, withdrawn: { jsonPath: "$.annulee" } };
  const all = { ...withdrawn, procedureType: { jsonPath: "$.procedure" }, contractNature: { jsonPath: "$.nature" }, cpvCodes: { jsonPath: "$.codesCpv", all: true }, description: { jsonPath: "$.objet" } };
  const broken = villeRecipe({ listFields: { ...all, cpvCodes: { jsonPath: "$.cpv", all: true } } });
  const fixed = villeRecipe({ listFields: all });
  const step = (recipe: Recipe): CartographerStep => ({ action: "recipe", navigateTo: null, reason: "t", recipe });
  const c = ctx([step(broken), step(broken), step(fixed)]);
  const out = await attachWithModel(c);
  assert.equal(out.kind, "ok");
  assert.equal(c.prompts.length, 3, "the broken cpvCodes rule is not accepted in any draft");
  assert.match(c.prompts[2]!, /The cpvCodes rule found no value on any of 3 tenders/);
});
