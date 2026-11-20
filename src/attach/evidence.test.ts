/**
 * Evidence checks: what the portal's pages show decides which rules a draft must have. Pure checks in
 * several languages, judgeSample on optional rules, and documents read from JSON list items.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { judgeSample, missingOptionalFields, missingWithdrawnRule } from "./cartographer.js";
import { clearDetailCache, readSample } from "./extractor.js";
import type { ExtractedTender, PortalContext, ReadOutcome } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";

const recipe = (extra: Partial<Recipe> = {}): Recipe =>
  Recipe.parse({
    schemaVersion: 1,
    tier: "html",
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    list: { request: { url: "https://p.test/list" }, pagination: { type: "none" }, item: "tr" },
    listFields: { id: { css: "td.id" }, url: { css: "a", attr: "href" }, title: { css: "a" } },
    ...extra,
  });
const withFields = (fields: Record<string, unknown>, where: "list" | "detail" = "list"): Recipe =>
  where === "list"
    ? recipe({ listFields: { ...recipe().listFields, ...(fields as Recipe["listFields"]) } })
    : recipe({ detail: { urlFrom: "url", fields: fields as Recipe["listFields"] } });

// ------------------------------------------------------------ missingWithdrawnRule

test("missingWithdrawnRule recognises cancellation words in several languages", () => {
  const words: Array<[string, string]> = [
    ["de", "<td>Status</td><td>Zurückgezogen</td>"],
    ["fr", "<span class='etat'>Consultation annulée</span>"],
    ["nl", "<td>Ingetrokken</td>"],
    ["nl", "<p>Deze aanbesteding is geannuleerd.</p>"],
    ["nl", "<p>Vroegtijdig beëindigd</p>"],
    ["en", "<td>Cancelled</td>"],
    ["en (US)", "<td>Canceled</td>"],
    ["en", "<td>Withdrawn</td>"],
    ["pl", "<td>Postępowanie unieważnione</td>"],
    ["es", "<td>Anulado</td>"],
    ["it", "<td>Annullata</td>"],
    ["es", "<td>Revocada</td>"],
  ];
  for (const [lang, html] of words) assert.match(missingWithdrawnRule(recipe(), [html]) ?? "", /marks cancelled tenders/, `${lang}: ${html}`);
});

test("missingWithdrawnRule recognises cancellation keys in JSON", () => {
  assert.ok(missingWithdrawnRule(recipe(), ['{"id":1,"cancelled":false}']));
  assert.ok(missingWithdrawnRule(recipe(), ['{"id":1,"annulee":true}']));
  assert.ok(missingWithdrawnRule(recipe(), ['{"id":1,"annule":true}']));
});

test("missingWithdrawnRule asks nothing when the pages show no cancellation", () => {
  for (const html of ["<td>Offen</td>", "<td>Ouvert</td>", "<td>Lopend</td>", "<p>Cancellation policy for bidders</p>"])
    assert.equal(missingWithdrawnRule(recipe(), [html]), null, html);
});

test("missingWithdrawnRule: a withdrawn field in list or detail rules settles it", () => {
  const texts = ["<td>Aufgehoben</td>"];
  assert.equal(missingWithdrawnRule(withFields({ withdrawn: { css: "td.status", regex: "(Aufgehoben)" } }), texts), null);
  assert.equal(missingWithdrawnRule(withFields({ withdrawn: { label: "Status" } }, "detail"), texts), null);
});

test("missingWithdrawnRule: withdrawnText counts only with words the pages really show (any case, any page)", () => {
  const pages = ["<table><td>Offen</td></table>", "<p>Das Verfahren wurde AUFGEHOBEN.</p>"];
  assert.equal(missingWithdrawnRule(recipe({ withdrawnText: ["aufgehoben"] }), pages), null, "case and page do not matter");
  assert.equal(missingWithdrawnRule(recipe({ withdrawnText: ["storniert", "AUFGEHOBEN"] }), pages), null, "one word that is shown is enough");
  const wrong = missingWithdrawnRule(recipe({ withdrawnText: ["Cancelled"] }), pages);
  assert.match(wrong ?? "", /withdrawnText \["Cancelled"\] appears nowhere on the pages/);
  assert.match(wrong ?? "", /"AUFGEHOBEN"/, "names the word the portal does show");
  // Blank words are no words at all.
  assert.match(missingWithdrawnRule(recipe({ withdrawnText: ["  "] }), pages) ?? "", /has no withdrawn rule/);
});

// ------------------------------------------------------------ missingOptionalFields

test("missingOptionalFields recognises labels in several languages", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["fr", "<dt>Type de procédure</dt><dd>Procédure adaptée</dd>", /the procedure type/],
    ["fr", "<dt>Nature du marché</dt><dd>Travaux</dd>", /the contract type/],
    ["fr", "<dt>Lieu d'exécution</dt><dd>75001 Paris</dd>", /the place of performance/],
    ["fr", "<dt>Objet du marché</dt><dd>Réfection</dd>", /a description/],
    ["es", "<dt>Procedimiento</dt><dd>Abierto</dd>", /the procedure type/],
    ["es", "<dt>Tipo de contrato</dt><dd>Obras</dd>", /the contract type/],
    ["es", "<dt>Lugar de ejecución</dt><dd>Madrid</dd>", /the place of performance/],
    ["pl", "<dt>Tryb udzielenia zamówienia</dt><dd>Podstawowy</dd>", /the procedure type/],
    ["pl", "<dt>Rodzaj zamówienia</dt><dd>Roboty budowlane</dd>", /the contract type/],
    ["pl", "<dt>Miejsce realizacji</dt><dd>Kraków</dd>", /the place of performance/],
    ["pl", "<dt>Opis przedmiotu zamówienia</dt><dd>…</dd>", /a description/],
    ["it", "<dt>Procedura di scelta</dt><dd>Aperta</dd>", /the procedure type/],
    ["it", "<dt>Tipo di appalto</dt><dd>Lavori</dd>", /the contract type/],
    ["it", "<dt>Luogo di esecuzione</dt><dd>Roma</dd>", /the place of performance/],
    ["nl", "<dt>Aanbestedingsprocedure</dt><dd>Openbaar</dd>", /the procedure type/],
    ["nl", "<dt>Type opdracht</dt><dd>Werken</dd>", /the contract type/],
    ["nl", "<dt>Plaats van uitvoering</dt><dd>Utrecht</dd>", /the place of performance/],
    ["nl", "<dt>Omschrijving</dt><dd>…</dd>", /a description/],
    ["de", "<dt>Leistungsart</dt><dd>Bauleistung</dd>", /the contract type/],
    ["de", "<dt>Erfüllungsort</dt><dd>Berlin</dd>", /the place of performance/],
    ["any", "<td>45233142-6</td>", /CPV codes/],
  ];
  for (const [lang, html, want] of cases) assert.match(missingOptionalFields(recipe(), [html]) ?? "", want, `${lang}: ${html}`);
});

test("missingOptionalFields: no hint when the label is absent or the rule exists (list, detail or nested place)", () => {
  assert.equal(missingOptionalFields(recipe(), ["<h1>Neubau Kita</h1><p>Frist 15.12.2026</p>"]), null);
  const fr = ["<dt>Type de procédure</dt><dd>Ouverte</dd><dt>Lieu d'exécution</dt><dd>Lyon</dd>"];
  const both = missingOptionalFields(recipe(), fr) ?? "";
  assert.match(both, /no rule for procedureType, postalCode\/city/);
  assert.equal(missingOptionalFields(withFields({ procedureType: { label: "Type de procédure" }, city: { label: "Lieu d'exécution" } }, "detail"), fr), null);
  assert.equal(missingOptionalFields(withFields({ procedureType: { label: "Type de procédure" }, "placeOfPerformance.postalCode": { label: "Lieu d'exécution" } }), fr), null);
  const one = missingOptionalFields(withFields({ procedureType: { label: "Type de procédure" } }), fr) ?? "";
  assert.ok(!/procedure type/.test(one), "a mapped field is not asked for again");
  assert.match(one, /the place of performance/);
});

// ------------------------------------------------------------ judgeSample on optional rules

function tender(i: number): ExtractedTender {
  return {
    id: `T-${i}`,
    url: `https://p.test/t/${i}`,
    title: `Title ${i}`,
    buyerName: "Buyer",
    publicationDate: "2026-11-10",
    submissionDeadline: "2026-12-10T10:00:00+01:00",
    documentRefs: [{ url: `https://p.test/f/${i}.pdf`, via: "http" }],
  };
}
const read = (fill: Record<string, { filled: number; total: number }>): ReadOutcome => ({
  kind: "ok",
  tenders: [1, 2, 3].map(tender),
  diagnostics: {
    requests: 4,
    listPages: 1,
    itemsSeen: 3,
    durationMs: 1,
    fieldFill: { ...Object.fromEntries(["id", "url", "title", "buyerName", "publicationDate", "submissionDeadline"].map((f) => [f, { filled: 3, total: 3 }])), ...fill },
  },
});
const full = (fields: Record<string, unknown>, where: "list" | "detail" = "list") => {
  const base = withFields({ buyerName: { css: "td.b" }, publicationDate: { css: "td.p" }, submissionDeadline: { css: "td.d" } });
  const r = where === "list" ? { ...base, listFields: { ...base.listFields, ...(fields as Recipe["listFields"]) } } : { ...base, detail: { urlFrom: "url", fields: fields as Recipe["listFields"] } };
  return { ...r, documents: { hops: [], files: { css: "a.f", all: true }, via: "http" as const } } as Recipe;
};

test("judgeSample: an optional rule that finds nothing on any sampled tender is an error, in list or detail rules", () => {
  const list = judgeSample(full({ cpvCodes: { css: "td.cpv", all: true } }), read({ cpvCodes: { filled: 0, total: 3 } }), "https://p.test/list");
  assert.match(list.errors.join(" "), /The cpvCodes rule found no value on any of 3 tenders/);
  const detail = judgeSample(full({ procedureType: { label: "Verfahrensart" } }, "detail"), read({ procedureType: { filled: 0, total: 3 } }), "https://p.test/list");
  assert.match(detail.errors.join(" "), /The procedureType rule found no value on any of 3 tenders.*procedure or contract type word/);
});

test("judgeSample: an optional rule that finds a value once, or has no sample, or is 'withdrawn', is fine", () => {
  const once = judgeSample(full({ cpvCodes: { css: "td.cpv", all: true } }), read({ cpvCodes: { filled: 1, total: 3 } }), "https://p.test/list");
  assert.deepEqual(once.errors, []);
  const noSample = judgeSample(full({ description: { css: "p" } }), read({ description: { filled: 0, total: 0 } }), "https://p.test/list");
  assert.deepEqual(noSample.errors, []);
  // Most tenders are not cancelled: a withdrawn rule that is false everywhere is normal.
  const withdrawn = judgeSample(full({ withdrawn: { css: "td.cancel" } }), read({ withdrawn: { filled: 0, total: 3 } }), "https://p.test/list");
  assert.deepEqual(withdrawn.errors, []);
});

// ------------------------------------------------------------ documents in JSON list items (fake portal)

const hits = new Map<string, number>();
let server: http.Server;
let base = "";
let listBody = "";

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url ?? "/", base).pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/j/api/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(listBody);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<html><body><div id="app"></div></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  hits.clear();
  clearDetailCache();
});

const ctx = (): PortalContext => ({
  portalId: "ev",
  url: `${base}/j/api/list`,
  http: { fetch: (u, init) => fetch(u, init) },
  browser: { withPage: () => Promise.reject(new Error("no browser here")) },
  llm: { json: () => Promise.reject(new Error("a read never calls the model")) },
  log: () => {},
  signal: new AbortController().signal,
});

const jsonRecipe = (files: string): Recipe =>
  Recipe.parse({
    schemaVersion: 1,
    tier: "jsonApi",
    timeZone: "Europe/Warsaw",
    countryCode: "PL",
    list: { request: { url: `${base}/j/api/list` }, pagination: { type: "none" }, item: "$.data.items[*]" },
    listFields: {
      id: { jsonPath: "$.nr" },
      url: { const: `${base}/j/t/{id}`, parse: "url" },
      title: { jsonPath: "$.nazwa" },
    },
    documents: { hops: [], files: { jsonPath: files, all: true }, via: "http" },
  });

const listWithFiles = (empty: number[] = []) =>
  JSON.stringify({
    data: {
      items: Array.from({ length: 5 }, (_, i) => ({
        nr: `ZP-${i}`,
        nazwa: `Zamówienie ${i}`,
        zalaczniki: empty.includes(i) ? [] : [{ plik: `/j/files/${i}/swz.pdf` }, { plik: `https://cdn.p.test/${i}/zal.zip` }],
      })),
    },
  });

test("documents from JSON list items: readSample reads them from the items with no tender-page request", async () => {
  listBody = listWithFiles();
  const out = await readSample(jsonRecipe("$.zalaczniki[*].plik"), ctx());
  assert.equal(out.kind, "ok", JSON.stringify(out).slice(0, 300));
  if (out.kind !== "ok") return;
  assert.equal(out.tenders.length, 3);
  assert.deepEqual(out.tenders[0]!.documentRefs.map((d) => d.url), [`${base}/j/files/0/swz.pdf`, "https://cdn.p.test/0/zal.zip"]);
  assert.equal(out.tenders[0]!.documentRefsPending, undefined);
  assert.deepEqual([...hits.keys()], ["/j/api/list"], "only the list was requested");
  assert.equal(out.diagnostics.requests, 1);
});

test(
  "documents from JSON list items: an item whose file list is empty needs no tender-page request either",
  async () => {
    listBody = listWithFiles([1]);
    const out = await readSample(jsonRecipe("$.zalaczniki[*].plik"), ctx());
    assert.equal(out.kind, "ok");
    if (out.kind !== "ok") return;
    assert.deepEqual(out.tenders[1]!.documentRefs, []);
    assert.deepEqual([...hits.keys()], ["/j/api/list"], "only the list was requested");
  },
);
