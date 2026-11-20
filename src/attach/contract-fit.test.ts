/**
 * Contract fit: whatever the Extractor reads, once turned into an API tender, must pass the frozen
 * `Tender` schema of src/shared/contract.ts. Messy input becomes null / left out, never a wrong value.
 * Also: fieldFill bookkeeping, stability across reads, and the TenderNed recipe on its saved fixtures.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { extractor, clearDetailCache } from "./extractor.js";
import { attachKnown, pickGolden } from "./index.js";
import type { ExtractedTender, PortalContext, ReadOutcome } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";
import { Tender, DateTimeWithOffset, IsoDate } from "../shared/contract.js";
import { formatWithOffset, nowWithOffset } from "../shared/time.js";

// ------------------------------------------------------------ fake portal

type Reply = { status?: number; type?: string; body: string | Buffer };
const routes = new Map<string, (url: URL) => Reply>();
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

function makeCtx(): PortalContext {
  return {
    portalId: "contract",
    url: base + "/",
    http: { fetch: (u, init) => fetch(u, init) },
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
    log: () => {},
    signal: new AbortController().signal,
  };
}

function recipe(partial: Partial<Recipe> & Pick<Recipe, "list" | "listFields">): Recipe {
  return { schemaVersion: 1, family: null, tier: "html", timeZone: "Europe/Berlin", countryCode: "DE", detail: null, documents: null, withdrawnText: [], ...partial };
}

function ok(r: ReadOutcome): Extract<ReadOutcome, { kind: "ok" }> {
  assert.equal(r.kind, "ok", JSON.stringify(r));
  return r as Extract<ReadOutcome, { kind: "ok" }>;
}

// ------------------------------------------------------------ contract helpers

const REQUIRED = ["id", "url", "title", "buyerName", "publicationDate", "submissionDeadline"] as const;

/** What the platform would serve for this tender (documents not downloaded yet). */
function toApiTender(t: ExtractedTender): unknown {
  const { documentRefs: _refs, withdrawn, ...rest } = t;
  return { ...rest, status: withdrawn ? "withdrawn" : "open", documents: [], lastChangedAt: nowWithOffset() };
}

function assertContractValid(t: ExtractedTender): void {
  const parsed = Tender.safeParse(toApiTender(t));
  assert.ok(parsed.success, `tender ${t.id} breaks the contract: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}\n${JSON.stringify(t)}`);
  for (const f of REQUIRED) assert.ok(f in t, `required field ${f} must always be present as a key (null when not shown)`);
  for (const [k, v] of Object.entries(t)) assert.notEqual(v, undefined, `key ${k} is present but undefined: leave it out instead`);
  assert.match(new URL(t.url).protocol, /^https?:$/, "url must be http(s)");
  if (t.submissionDeadline !== null) {
    assert.ok(DateTimeWithOffset.safeParse(t.submissionDeadline).success);
    assert.ok(!t.submissionDeadline.endsWith("Z"), "never Z");
  }
  if (t.publicationDate !== null) assert.ok(IsoDate.safeParse(t.publicationDate).success);
  if (t.cpvCodes) assert.ok(t.cpvCodes.length > 0, "an empty cpvCodes list must be left out");
  if (t.withdrawn !== undefined) assert.equal(t.withdrawn, true);
  for (const r of t.documentRefs) assert.match(new URL(r.url).protocol, /^https?:$/);
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return typeof v !== "string" || v.trim() !== "";
}

/** fieldFill: every field has total = tenders returned, required fields always counted, filled matches the tenders. */
function assertFieldFill(res: Extract<ReadOutcome, { kind: "ok" }>, checkFilled: readonly (keyof ExtractedTender)[]): void {
  const ff = res.diagnostics.fieldFill;
  for (const f of REQUIRED) assert.ok(ff[f], `fieldFill.${f} must exist`);
  for (const [f, v] of Object.entries(ff)) {
    assert.equal(v.total, res.tenders.length, `fieldFill.${f}.total`);
    assert.ok(v.filled >= 0 && v.filled <= v.total, `fieldFill.${f}.filled in range`);
  }
  for (const f of checkFilled) {
    assert.equal(ff[f]?.filled, res.tenders.filter((t) => hasValue(t[f])).length, `fieldFill.${String(f)}.filled equals tenders with ${String(f)}`);
  }
}

// ------------------------------------------------------------ deterministic "random"

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

/** Ways a portal wraps the same text: padding, newlines, tabs, nbsp entities, nbsp instead of a space. */
const DECORATE: ((s: string) => string)[] = [
  (s) => s,
  (s) => `   ${s}  `,
  (s) => `\n\t\t${s}\n  `,
  (s) => `&nbsp;${s}&#160;`,
  (s) => s.replace(" ", "&nbsp;"),
  (s) => ` ${s.replace(" ", " ")} `,
];

type Case<T> = [input: string, expected: T];

const TITLES: Case<string | null>[] = [
  ["Neubau   Grundschule", "Neubau Grundschule"],
  ["Réfection de la chaussée – lot 2", "Réfection de la chaussée – lot 2"],
  ["Rozbudowa drogi gminnej, etap II", "Rozbudowa drogi gminnej, etap II"],
  ["Suministro de mobiliario", "Suministro de mobiliario"],
  ["", null],
];
const BUYERS: Case<string | null>[] = [
  ["Stadt München", "Stadt München"],
  ["Ville de Paris", "Ville de Paris"],
  ["Gmina Kraków", "Gmina Kraków"],
  ["Ayuntamiento de Madrid", "Ayuntamiento de Madrid"],
  ["", null],
];
const PUB_DATES: Case<string | null>[] = [
  ["01.03.2026", "2026-03-01"],
  ["2026-03-01", "2026-03-01"],
  ["3. März 2026", "2026-03-03"],
  ["9 déc. 2026", "2026-12-09"],
  ["12/03/2026", "2026-03-12"],
  ["31.02.2026", null],
  ["2026-13-01", null],
  ["n/a", null],
  ["", null],
];
const DEADLINES: Case<string | null>[] = [
  ["12.03.2026 10:00 Uhr", "2026-03-12T10:00:00+01:00"],
  ["12.04.2026 10:00", "2026-04-12T10:00:00+02:00"],
  ["9 de diciembre de 2026 10:00", "2026-12-09T10:00:00+01:00"],
  ["9 déc. 2026 14h30", "2026-12-09T14:30:00+01:00"],
  ["2026-12-18T12:00:00Z", "2026-12-18T13:00:00+01:00"],
  ["31.12.2026", null], // date without time: never invent a time
  ["31.02.2026 10:00", null],
  ["12.03.2026 25:00", null],
  ["siehe Vergabeunterlagen", null],
  ["", null],
];
const CPVS: Case<string[] | undefined>[] = [
  ["45000000-7", ["45000000"]],
  ["4500000-7", undefined],
  ["45000000-7 and 45200000-9", ["45000000", "45200000"]],
  ["CPV: 45000000-7, 45200000-9", ["45000000", "45200000"]],
  ["71311300", ["71311300"]],
  ["12345678", undefined],
  ["", undefined],
];
const PROCEDURES: Case<string | undefined>[] = [
  ["Offenes Verfahren", "open"],
  ["Procédure ouverte", "open"],
  ["Procedimiento abierto", "open"],
  ["Przetarg nieograniczony", "open"],
  ["Nicht offenes Verfahren", "restricted"],
  ["Verhandlungsverfahren", "negotiated"],
  ["Sonstiges", undefined],
  ["", undefined],
];
const NATURES: Case<string | undefined>[] = [
  ["Bauleistung", "works"],
  ["Services", "services"],
  ["Fournitures", "supplies"],
  ["Bau- und Dienstleistungen", undefined],
  ["Diverses", undefined],
  ["", undefined],
];
const POSTCODES: Case<string | undefined>[] = [
  ["10115", "10115"],
  ["abc", undefined],
  ["", undefined],
];
/** href -> keeps the tender? */
const HREFS: Case<boolean>[] = [
  ["/t/{n}", true],
  ["  /t/{n}  ", true],
  [`{base}/t/{n}`, true],
  ["javascript:void(0)", false],
  ["mailto:vergabe@example.test", false],
  ["#", false],
];

// ------------------------------------------------------------ 1. contract fit, html

test("contract fit (html, property-style): 120 messy rows never yield an invalid or wrong value", async () => {
  const rnd = prng(20261120);
  type Row = { id: string; keep: boolean; href: string; title: Case<string | null>; buyer: Case<string | null>; pub: Case<string | null>; dl: Case<string | null>; cpv: Case<string[] | undefined>; proc: Case<string | undefined>; nat: Case<string | undefined>; plz: Case<string | undefined> };
  const rows: Row[] = [];
  for (let n = 0; n < 120; n++) {
    const [href, keep] = pick(rnd, HREFS);
    rows.push({
      id: `R-${n}`,
      keep,
      href: href.replace("{n}", String(n)).replace("{base}", base),
      title: pick(rnd, TITLES),
      buyer: pick(rnd, BUYERS),
      pub: pick(rnd, PUB_DATES),
      dl: pick(rnd, DEADLINES),
      cpv: pick(rnd, CPVS),
      proc: pick(rnd, PROCEDURES),
      nat: pick(rnd, NATURES),
      plz: pick(rnd, POSTCODES),
    });
  }
  const d = (s: string) => pick(rnd, DECORATE)(s);
  const html =
    "<!doctype html><html><body><table><tbody>" +
    rows
      .map(
        (r) =>
          `<tr class="row"><td class="ref">${d(r.id)}</td><td class="t"><a href="${r.href}">${d(r.title[0])}</a></td>` +
          `<td class="buyer">${d(r.buyer[0])}</td><td class="pub">${d(r.pub[0])}</td><td class="dl">${d(r.dl[0])}</td>` +
          `<td class="cpv">${d(r.cpv[0])}</td><td class="proc">${d(r.proc[0])}</td><td class="nat">${d(r.nat[0])}</td><td class="plz">${d(r.plz[0])}</td></tr>`,
      )
      .join("\n") +
    "</tbody></table></body></html>";
  routes.set("/messy", () => ({ body: html }));

  const res = ok(
    await extractor.read(
      recipe({
        list: { request: { url: "/messy", method: "GET" }, pagination: { type: "none" }, item: "tr.row", emptyText: [] },
        listFields: {
          id: { css: "td.ref" },
          url: { css: "td.t a", attr: "href" },
          title: { css: "td.t a" },
          buyerName: { css: "td.buyer" },
          publicationDate: { css: "td.pub" },
          submissionDeadline: { css: "td.dl" },
          cpvCodes: { css: "td.cpv" },
          procedureType: { css: "td.proc" },
          contractNature: { css: "td.nat" },
          postalCode: { css: "td.plz" },
        },
      }),
      makeCtx(),
    ),
  );

  const kept = rows.filter((r) => r.keep);
  assert.deepEqual(res.tenders.map((t) => t.id), kept.map((r) => r.id), "rows without a web address are left out, the rest keep their order");
  for (const t of res.tenders) assertContractValid(t);
  for (const r of kept) {
    const t = res.tenders.find((x) => x.id === r.id)!;
    const ctx = `row ${r.id}: ${JSON.stringify(t)}`;
    assert.equal(t.url, new URL(r.href.trim(), base).href, ctx);
    assert.equal(t.title, r.title[1], ctx);
    assert.equal(t.buyerName, r.buyer[1], ctx);
    assert.equal(t.publicationDate, r.pub[1], `${ctx} pub ${r.pub[0]}`);
    assert.equal(t.submissionDeadline, r.dl[1], `${ctx} deadline ${r.dl[0]}`);
    assert.deepEqual(t.cpvCodes, r.cpv[1], `${ctx} cpv ${r.cpv[0]}`);
    assert.equal(t.procedureType, r.proc[1], ctx);
    assert.equal(t.contractNature, r.nat[1], ctx);
    assert.deepEqual(t.placeOfPerformance, r.plz[1] ? { postalCode: r.plz[1], city: null, countryCode: "DE" } : undefined, ctx);
    for (const k of ["cpvCodes", "procedureType", "contractNature", "placeOfPerformance", "referenceNumber", "description"] as const) {
      if (t[k] === undefined) assert.ok(!(k in t), `${ctx}: optional ${k} must be left out, not undefined`);
    }
  }
  // 5. fieldFill
  assertFieldFill(res, ["id", "url", "title", "buyerName", "publicationDate", "submissionDeadline", "cpvCodes", "procedureType", "contractNature"]);
  assert.equal(res.diagnostics.itemsSeen, rows.length);
});

// ------------------------------------------------------------ 1. contract fit, json

test("contract fit (json): numbers, nulls, objects, booleans and partial dates become null or are left out", async () => {
  const zone = "Europe/Amsterdam";
  const epoch = Date.UTC(2026, 11, 18, 11, 0, 0); // 12:00 in Amsterdam
  const items: Record<string, unknown>[] = [
    { id: "J1", title: "  Onderhoud wegen ", buyer: "Gemeente Utrecht", pub: "2026-03-01", dl: "2026-12-18T12:00:00", cpv: ["45000000-7", "45200000-9"], proc: "Openbaar", nature: "Werken" },
    { id: 42, title: 12345, buyer: null, pub: "2026-03-01T00:00:00", dl: "2026-07-01T12:00:00", cpv: "45000000", proc: "Niet-openbaar", nature: "Diensten" },
    { id: "J3", title: null, buyer: { name: "x" }, pub: 20260301, dl: "2026-12-18", cpv: ["4500000-7"], proc: null, nature: "Leveringen" },
    { id: "J4", title: { nl: "x" }, buyer: ["a", "b"], pub: true, dl: epoch, cpv: 45000000, proc: { code: "OPE" }, nature: true },
    { id: "J5", title: "", buyer: "", pub: "", dl: "2026-12-18T12:00:00+02:00", cpv: [{ code: "45000000" }], proc: "", nature: "" },
    { id: "J6", title: "T", buyer: "B", pub: "2026-02-30", dl: "2026-02-30T10:00:00", cpv: "", proc: "Onderhandelingsprocedure", nature: "Werken en diensten" },
    { id: "J7", title: "T", buyer: "B", pub: null, dl: 0, cpv: null, proc: "NA", nature: null },
    { id: null, title: "no id: dropped" },
    { id: "   ", title: "blank id: dropped" },
  ];
  routes.set("/j", () => ({ type: "application/json", body: JSON.stringify({ data: { items } }) }));
  const res = ok(
    await extractor.read(
      recipe({
        tier: "jsonApi",
        timeZone: zone,
        countryCode: "NL",
        list: { request: { url: "/j", method: "GET" }, pagination: { type: "none" }, item: "$.data.items[*]", emptyText: [] },
        listFields: {
          id: { jsonPath: "$.id" },
          url: { const: "/tender/{id}" },
          title: { jsonPath: "$.title" },
          buyerName: { jsonPath: "$.buyer" },
          publicationDate: { jsonPath: "$.pub" },
          submissionDeadline: { jsonPath: "$.dl" },
          cpvCodes: { jsonPath: "$.cpv" },
          procedureType: { jsonPath: "$.proc" },
          contractNature: { jsonPath: "$.nature" },
        },
      }),
      makeCtx(),
    ),
  );
  for (const t of res.tenders) assertContractValid(t);
  const by = Object.fromEntries(res.tenders.map((t) => [t.id, t]));
  assert.deepEqual(res.tenders.map((t) => t.id), ["J1", "42", "J3", "J4", "J5", "J6", "J7"]);
  assert.equal(by.J1!.title, "Onderhoud wegen");
  assert.equal(by.J1!.submissionDeadline, "2026-12-18T12:00:00+01:00");
  assert.deepEqual(by.J1!.cpvCodes, ["45000000", "45200000"]);
  assert.equal(by.J1!.contractNature, "works");
  assert.equal(by["42"]!.url, `${base}/tender/42`);
  assert.equal(by["42"]!.buyerName, null);
  assert.equal(by["42"]!.publicationDate, "2026-03-01");
  assert.equal(by["42"]!.submissionDeadline, "2026-07-01T12:00:00+02:00", "summer time in Amsterdam");
  assert.equal(by["42"]!.procedureType, "restricted");
  assert.equal(by.J3!.title, null);
  assert.equal(by.J3!.buyerName, null, "an object is not a buyer name");
  assert.equal(by.J3!.publicationDate, null, "20260301 as a number is not trusted as a date");
  assert.equal(by.J3!.submissionDeadline, null, "date-only deadline: no invented time");
  assert.ok(!("cpvCodes" in by.J3!));
  assert.ok(!("procedureType" in by.J3!));
  assert.equal(by.J4!.title, null);
  assert.equal(by.J4!.buyerName, null);
  assert.equal(by.J4!.publicationDate, null);
  assert.equal(by.J4!.submissionDeadline, formatWithOffset(new Date(epoch), zone));
  assert.equal(by.J4!.submissionDeadline, "2026-12-18T12:00:00+01:00");
  assert.deepEqual(by.J4!.cpvCodes, ["45000000"]);
  assert.ok(!("procedureType" in by.J4!));
  assert.ok(!("contractNature" in by.J4!));
  assert.equal(by.J5!.submissionDeadline, "2026-12-18T11:00:00+01:00", "explicit offset is converted, not re-labelled");
  assert.ok(!("cpvCodes" in by.J5!));
  assert.equal(by.J6!.publicationDate, null);
  assert.equal(by.J6!.submissionDeadline, null);
  assert.equal(by.J6!.procedureType, "negotiated");
  assert.ok(!("contractNature" in by.J6!), "mixed nature is ambiguous");
  assert.equal(by.J7!.submissionDeadline, null, "epoch 0 is not a deadline");
  assert.ok(!("procedureType" in by.J7!));
  assertFieldFill(res, ["id", "url", "title", "buyerName", "publicationDate", "submissionDeadline", "cpvCodes", "procedureType", "contractNature"]);
});

test("contract fit: required fields stay as null keys and fieldFill counts them even when the recipe has no rule", async () => {
  routes.set("/bare", () => ({ type: "application/json", body: JSON.stringify([{ k: "a" }, { k: "b" }]) }));
  const res = ok(
    await extractor.read(
      recipe({
        tier: "jsonApi",
        list: { request: { url: "/bare", method: "GET" }, pagination: { type: "none" }, item: "$[*]", emptyText: [] },
        listFields: { id: { jsonPath: "$.k" }, url: { const: "/t/{id}" } },
      }),
      makeCtx(),
    ),
  );
  assert.equal(res.tenders.length, 2);
  for (const t of res.tenders) {
    assertContractValid(t);
    assert.deepEqual(Object.keys(t).sort(), ["buyerName", "documentRefs", "id", "publicationDate", "submissionDeadline", "title", "url"]);
  }
  assert.deepEqual(res.diagnostics.fieldFill.title, { filled: 0, total: 2 });
  assert.deepEqual(res.diagnostics.fieldFill.submissionDeadline, { filled: 0, total: 2 });
  assert.deepEqual(res.diagnostics.fieldFill.id, { filled: 2, total: 2 });
  assertFieldFill(res, ["id", "url", "title"]);
});

test("fieldFill: totals follow returned tenders, not list items (dropped and duplicate rows don't count)", async () => {
  routes.set("/ff", () => ({
    type: "application/json",
    body: JSON.stringify([{ k: "a", t: "A" }, { k: "a", t: "dup" }, { k: null, t: "no id" }, { k: "b", t: "" }, { k: "c", t: "C" }]),
  }));
  const res = ok(
    await extractor.read(
      recipe({
        tier: "jsonApi",
        list: { request: { url: "/ff", method: "GET" }, pagination: { type: "none" }, item: "$[*]", emptyText: [] },
        listFields: { id: { jsonPath: "$.k" }, url: { const: "/t/{id}" }, title: { jsonPath: "$.t" }, description: { jsonPath: "$.nothing" } },
      }),
      makeCtx(),
    ),
  );
  assert.deepEqual(res.tenders.map((t) => t.id), ["a", "b", "c"]);
  assert.equal(res.diagnostics.itemsSeen, 5);
  assert.deepEqual(res.diagnostics.fieldFill.title, { filled: 2, total: 3 });
  assert.deepEqual(res.diagnostics.fieldFill.description, { filled: 0, total: 3 });
  assertFieldFill(res, ["id", "url", "title", "description"]);
});

// ------------------------------------------------------------ 4. stability

const STABLE_ITEMS = Array.from({ length: 8 }, (_, i) => ({
  id: `S${i}`,
  title: `Tender ${i}`,
  buyer: `Buyer ${i % 3}`,
  pub: `2026-11-${String(10 + i).padStart(2, "0")}`,
  dl: `2026-12-${String(10 + i).padStart(2, "0")}T10:00:00`,
}));

function stableRecipe(): Recipe {
  return recipe({
    tier: "jsonApi",
    list: { request: { url: "/stable", method: "GET" }, pagination: { type: "none" }, item: "$.items[*]", emptyText: [] },
    listFields: {
      id: { jsonPath: "$.id" },
      url: { const: "/stable/t/{id}" },
      title: { jsonPath: "$.title" },
      buyerName: { jsonPath: "$.buyer" },
      publicationDate: { jsonPath: "$.pub" },
      submissionDeadline: { jsonPath: "$.dl" },
    },
    detail: { urlFrom: "/stable/d/{id}", fields: { referenceNumber: { jsonPath: "$.ref" }, cpvCodes: { jsonPath: "$.cpv[*]", all: true } } },
  });
}

function serveStable(order: "asc" | "desc"): void {
  const items = order === "asc" ? STABLE_ITEMS : [...STABLE_ITEMS].reverse();
  routes.set("/stable", () => ({ type: "application/json", body: JSON.stringify({ items }) }));
  for (const it of STABLE_ITEMS) {
    routes.set(`/stable/d/${it.id}`, () => ({ type: "application/json", body: JSON.stringify({ ref: `AZ-${it.id}`, cpv: ["45000000-7"] }) }));
  }
}

test("stability: same input twice gives identical tenders and skeleton hash (fresh and cached detail)", async () => {
  serveStable("asc");
  const a = ok(await extractor.read(stableRecipe(), makeCtx()));
  const cached = ok(await extractor.read(stableRecipe(), makeCtx()));
  clearDetailCache();
  const fresh = ok(await extractor.read(stableRecipe(), makeCtx()));
  assert.equal(a.tenders.length, 8);
  assert.deepEqual(cached.tenders, a.tenders);
  assert.deepEqual(fresh.tenders, a.tenders);
  assert.ok(a.diagnostics.listSkeletonHash);
  assert.equal(cached.diagnostics.listSkeletonHash, a.diagnostics.listSkeletonHash);
  assert.equal(fresh.diagnostics.listSkeletonHash, a.diagnostics.listSkeletonHash);
  assert.deepEqual(cached.diagnostics.fieldFill, a.diagnostics.fieldFill);
  assert.ok(cached.diagnostics.requests < a.diagnostics.requests, "unchanged items reuse their detail");
  for (const t of a.tenders) assertContractValid(t);
});

test("stability: ids and values do not depend on list order", async () => {
  serveStable("asc");
  const asc = ok(await extractor.read(stableRecipe(), makeCtx()));
  clearDetailCache();
  serveStable("desc");
  const desc = ok(await extractor.read(stableRecipe(), makeCtx()));
  const byId = (r: typeof asc) => Object.fromEntries(r.tenders.map((t) => [t.id, t]));
  assert.deepEqual(byId(desc), byId(asc));
  assert.equal(desc.diagnostics.listSkeletonHash, asc.diagnostics.listSkeletonHash);
  assert.deepEqual(desc.diagnostics.fieldFill, asc.diagnostics.fieldFill);

  // html: reordered rows keep the same ids, urls and skeleton
  const rowsHtml = (ids: string[]) =>
    `<html><body><ul class="list">${ids.map((i) => `<li class="it"><a href="/h/${i}">Titel ${i}</a><span class="az">${i}</span></li>`).join("")}</ul></body></html>`;
  const htmlRecipe = recipe({
    list: { request: { url: "/hl", method: "GET" }, pagination: { type: "none" }, item: "li.it", emptyText: [] },
    listFields: { id: { css: "span.az" }, url: { css: "a", attr: "href" }, title: { css: "a" } },
  });
  routes.set("/hl", () => ({ body: rowsHtml(["H1", "H2", "H3"]) }));
  const h1 = ok(await extractor.read(htmlRecipe, makeCtx()));
  routes.set("/hl", () => ({ body: rowsHtml(["H3", "H1", "H2"]) }));
  const h2 = ok(await extractor.read(htmlRecipe, makeCtx()));
  assert.deepEqual(
    Object.fromEntries(h2.tenders.map((t) => [t.id, t])),
    Object.fromEntries(h1.tenders.map((t) => [t.id, t])),
  );
  assert.equal(h2.diagnostics.listSkeletonHash, h1.diagnostics.listSkeletonHash);
});

// ------------------------------------------------------------ 7. TenderNed recipe on fixtures

const API = "/papi/tenderned-rs-tns/v2/publicaties";
const fixtureDir = new URL("./recipes/tenderned.fixtures/", import.meta.url);
const fixture = (name: string) => fs.readFileSync(new URL(name, fixtureDir), "utf8");

function tenderNedRecipe(): Recipe {
  const raw = fs.readFileSync(new URL("./recipes/tenderned.json", import.meta.url), "utf8").replaceAll("https://www.tenderned.nl", base);
  return Recipe.parse(JSON.parse(raw));
}

function serveTenderNed(detail450237 = fixture("detail-450237.json")): void {
  routes.set(API, (u) => ({
    type: "application/json",
    body: u.searchParams.get("page") === "0" ? fixture("list-page0.json") : JSON.stringify({ content: [], totalElements: 3 }),
  }));
  routes.set(`${API}/450237`, () => ({ type: "application/json", body: detail450237 }));
  routes.set(`${API}/450237/documenten`, () => ({ type: "application/json", body: fixture("documenten-450237.json") }));
}

test("TenderNed fixtures: all three items are contract-valid; 449873 withdrawn; golden 450237 values", async () => {
  serveTenderNed();
  const res = ok(await extractor.read(tenderNedRecipe(), makeCtx()));
  assert.deepEqual(res.tenders.map((t) => t.id), ["450237", "450165", "449873"]);
  for (const t of res.tenders) assertContractValid(t);
  assertFieldFill(res, ["id", "url", "title", "buyerName", "publicationDate", "submissionDeadline", "cpvCodes", "referenceNumber", "procedureType", "contractNature", "description"]);

  const api = (t: ExtractedTender) => Tender.parse(toApiTender(t));
  const g = api(res.tenders[0]!);
  assert.equal(g.url, "https://www.tenderned.nl/aankondigingen/overzicht/450237", "the human tender page, not the API");
  assert.equal(g.title, "Verkenning route S106");
  assert.equal(g.buyerName, "Gemeente Rijswijk");
  assert.equal(g.publicationDate, "2026-11-20");
  assert.equal(g.submissionDeadline, "2026-12-18T12:00:00+01:00");
  assert.equal(g.referenceNumber, "SRA2601");
  assert.equal(g.procedureType, "open");
  assert.equal(g.contractNature, "services");
  assert.deepEqual(g.cpvCodes, ["71311300", "71311210", "71410000"]);
  assert.equal(g.status, "open");
  assert.equal(g.placeOfPerformance, undefined, "TenderNed shows no city/postcode: left out");

  const zb = api(res.tenders[1]!);
  assert.equal(zb.buyerName, "Gemeente Zaltbommel");
  assert.equal(zb.submissionDeadline, "2027-01-11T10:00:00+01:00");
  assert.equal(zb.contractNature, "supplies");
  assert.equal(zb.referenceNumber, undefined, "no detail fixture: left out, not guessed");
  assert.equal(zb.status, "open");

  const w = api(res.tenders[2]!);
  assert.equal(w.status, "withdrawn");
  assert.equal(w.buyerName, "Provincie Overijssel");
  assert.equal(w.submissionDeadline, "2026-12-15T14:00:00+01:00");
});

test("TenderNed fixtures: attachKnown picks contract-valid golden records led by 450237, without the model", async () => {
  serveTenderNed();
  const ctx = makeCtx();
  const out = await attachKnown({ name: "TenderNed", match: { host: "127.0.0.1" }, recipe: tenderNedRecipe() }, ctx);
  assert.equal(out.kind, "ok", JSON.stringify(out));
  if (out.kind !== "ok") return;
  assert.ok(out.golden.length >= 3 && out.golden.length <= 5);
  assert.deepEqual(out.golden[0], {
    id: "450237",
    fields: {
      title: "Verkenning route S106",
      buyerName: "Gemeente Rijswijk",
      publicationDate: "2026-11-20",
      submissionDeadline: "2026-12-18T12:00:00+01:00",
      referenceNumber: "SRA2601",
      url: "https://www.tenderned.nl/aankondigingen/overzicht/450237",
    },
  });
  for (const g of out.golden) {
    const t: ExtractedTender = out.read.tenders.find((x) => x.id === g.id)!;
    for (const [k, v] of Object.entries(g.fields)) assert.deepEqual(v, t[k as keyof ExtractedTender], `golden ${g.id}.${k}`);
  }
  assert.deepEqual(pickGolden(out.read.tenders), out.golden);
});

// ------------------------------------------------------------ 8. referenceNumber shaped like a UUID

const UUID = "bf7ea7dd-4c1e-4b8a-9f3e-2d6c0a1b5e77";

test("referenceNumber: the TenderNed recipe drops a UUID referentieNummer (a system id, not the buyer's file number)", async () => {
  const detail = JSON.parse(fixture("detail-450237.json")) as Record<string, unknown>;
  detail.referentieNummer = UUID;
  serveTenderNed(JSON.stringify(detail));
  const res = ok(await extractor.read(tenderNedRecipe(), makeCtx()));
  const t = res.tenders.find((x) => x.id === "450237")!;
  assert.ok(!("referenceNumber" in t), "UUID-shaped reference numbers are left out");
  assertContractValid(t);
});

test("referenceNumber: a recipe-level regex guard drops UUIDs and keeps real file numbers (no code change needed)", async () => {
  const guarded = (r: Recipe): Recipe => {
    r.detail!.fields.referenceNumber = { jsonPath: "$.referentieNummer", regex: "^(?![0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$)(.+)$" };
    return r;
  };
  const detail = JSON.parse(fixture("detail-450237.json")) as Record<string, unknown>;
  detail.referentieNummer = UUID;
  serveTenderNed(JSON.stringify(detail));
  const withUuid = ok(await extractor.read(guarded(tenderNedRecipe()), makeCtx()));
  assert.ok(!("referenceNumber" in withUuid.tenders.find((x) => x.id === "450237")!));

  clearDetailCache();
  serveTenderNed();
  const normal = ok(await extractor.read(guarded(tenderNedRecipe()), makeCtx()));
  assert.equal(normal.tenders.find((x) => x.id === "450237")!.referenceNumber, "SRA2601");
});
