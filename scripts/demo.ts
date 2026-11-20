/**
 * Demo data for the dashboard, served without the worker. Owned by A.
 *
 *   DATA_DIR=data/demo npx tsx scripts/demo.ts        # seeds once, then serves on :8080
 *
 * Use it to build and film the dashboard before the full pipeline runs end to end. Nothing here
 * reaches a real portal unless you press "Read now", which starts a real read. Real portals appear only with what we actually observed (TenderNed served
 * through its API, BOAMP and TED blocked by robots.txt); invented scenarios use lab addresses.
 * The worker is not started, so no state here changes on its own.
 */
import fs from "node:fs";
import path from "node:path";

process.env.DATA_DIR ??= "data/demo";
const fresh = !fs.existsSync(path.join(process.env.DATA_DIR, "watchtower.db"));
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { store } = await import("../src/platform/store.js");
const { buildServer } = await import("../src/platform/server.js");
const { config } = await import("../src/platform/config.js");
const { formatWithOffset } = await import("../src/shared/time.js");
const { Recipe } = await import("../src/shared/recipe.js");

const NOW = Date.now();
const MIN = 60_000;
const at = (minutesAgo: number) => formatWithOffset(new Date(NOW - minutesAgo * MIN));
let runNo = 0;
const runId = () => `r_demo${String(++runNo).padStart(5, "0")}`;

type RunSpec = { ago: number; kind: "read" | "repair"; result: "ok" | "failed" | null; summary: string; seconds?: number; events?: [string, string][]; cost?: { purpose: string; inTok: number; outTok: number } };

function addPortal(o: {
  id: string; url: string; state: "integrating" | "serving" | "healing" | "failed"; reason: string; createdAgo: number; lastSuccessAgo: number | null;
  recipes?: { ago: number; origin: "attach" | "repair" | "family"; note: string; recipe: unknown }[];
  runs: RunSpec[]; tenders?: { count: number; titles: string[]; buyers: string[]; host: string };
}) {
  store.insertPortal({ id: o.id, url: o.url, state: o.state, reason: o.reason, createdAt: at(o.createdAgo) });
  store.setState(o.id, o.state, o.reason, o.lastSuccessAgo === null ? undefined : at(o.lastSuccessAgo));
  store.setNextDue(o.id, NOW + 365 * 24 * 60 * MIN);
  for (const r of o.recipes ?? []) store.saveRecipe(o.id, Recipe.parse(r.recipe), r.origin, r.note, at(r.ago));
  for (const r of [...o.runs].sort((a, b) => b.ago - a.ago)) {
    const id = runId();
    store.insertRun({ id, portalId: o.id, kind: r.kind, startedAt: at(r.ago) });
    for (const [level, message] of r.events ?? []) store.addEvent(o.id, id, at(r.ago - 0.2), level, message);
    if (r.cost) {
      const smart = r.cost.purpose !== "triage";
      const usd = smart ? (r.cost.inTok * 2 + r.cost.outTok * 10) / 1e6 : (r.cost.inTok * 0.1 + r.cost.outTok * 0.5) / 1e6;
      store.addLlmCall({ portalId: o.id, runId: id, purpose: r.cost.purpose, model: smart ? "gpt-6.2-sol" : "gpt-6-luna", inputTokens: r.cost.inTok, outputTokens: r.cost.outTok, costUsd: usd, at: at(r.ago) });
    }
    if (r.result) store.finishRun(id, r.result, formatWithOffset(new Date(NOW - r.ago * MIN + (r.seconds ?? 40) * 1000)), r.summary);
  }
  const t = o.tenders;
  for (let i = 0; t && i < t.count; i++) {
    const changedAgo = (i * 37) % (60 * 24 * 9);
    const tender = {
      id: `${o.id}-${1000 + i}`, url: `https://${t.host}/tender/${1000 + i}`,
      title: t.titles[i % t.titles.length]!, buyerName: t.buyers[i % t.buyers.length]!,
      publicationDate: formatWithOffset(new Date(NOW - (changedAgo + 600) * MIN)).slice(0, 10),
      submissionDeadline: formatWithOffset(new Date(NOW + ((i * 53) % (60 * 24 * 40) + 60 * 24 * 3) * MIN)).replace(/T\d\d:\d\d/, "T12:00"),
      status: "open" as const, documents: [], lastChangedAt: at(changedAgo),
    };
    store.upsertTender(o.id, tender, `h${i}`, "x", at(changedAgo));
  }
}

/** A regular read every 30 minutes over the last day. */
function everyHalfHour(fromAgo: number, toAgo: number, summary: (ago: number) => string, seconds = 40): RunSpec[] {
  const out: RunSpec[] = [];
  for (let ago = fromAgo; ago >= toAgo; ago -= 30) out.push({ ago, kind: "read", result: "ok", summary: summary(ago), seconds });
  return out;
}
const hhmm = (ago: number) => at(ago).slice(11, 16);

function seed() {
  const tenderned = JSON.parse(fs.readFileSync("scripts/recipes/tenderned.draft.json", "utf8"));
  addPortal({
    id: "p_demo_tenderned", url: "https://www.tenderned.nl/", state: "serving", createdAgo: 60 * 30, lastSuccessAgo: 4,
    reason: `Serving 2,927 open tenders (3 new, 1 changed). Last read ${hhmm(4)}, all checks passed.`,
    recipes: [{ ago: 60 * 30, origin: "attach", note: "Public JSON API at /papi/tenderned-rs-tns/v2/publicaties, 50 per page; documents from the publication's document list.", recipe: tenderned }],
    runs: [
      { ago: 60 * 30, kind: "read", result: "ok", seconds: 260, summary: "Attached through the public API. Serving 2,927 open tenders.", cost: { purpose: "attach", inTok: 3020, outTok: 800 },
        events: [["info", "Found a JSON API behind the search page; using it instead of the HTML."], ["info", "Golden tenders kept: 5."]] },
      ...everyHalfHour(60 * 24 - 4, 4, (ago) => `Serving 2,927 open tenders (${ago % 90 === 4 ? 2 : 0} new, ${ago % 120 === 4 ? 1 : 0} changed). Last read ${hhmm(ago)}, all checks passed.`, 38),
    ],
    tenders: {
      count: 2927, host: "www.tenderned.nl",
      titles: ["Onderhoud openbare verlichting 2027–2030", "Levering van elektrische bussen", "Schoonmaakdiensten gemeentehuis", "Raamovereenkomst ICT-werkplekken", "Herinrichting Stationsplein", "Groenonderhoud wijk Oost"],
      buyers: ["Gemeente Utrecht", "Provincie Gelderland", "Rijkswaterstaat", "Gemeente Groningen", "Waterschap Rivierenland"],
    },
  });

  const htmlV1 = {
    schemaVersion: 1, family: null, tier: "html", timeZone: "Europe/Berlin", countryCode: "DE",
    list: { request: { url: "http://localhost:4100/stadtwerke/ausschreibungen" }, pagination: { type: "nextLink", selector: { css: "a.next", attr: "href" }, maxPages: 20 }, item: "table.tenders tbody tr" },
    listFields: { id: { css: "td.nr" }, url: { css: "td.title a", attr: "href", parse: "url" }, title: { css: "td.title" }, buyerName: { css: "td.vergabestelle" }, submissionDeadline: { css: "td.frist", parse: "datetime", format: "dd.MM.yyyy HH:mm" } },
  };
  const htmlV2 = JSON.parse(JSON.stringify(htmlV1));
  htmlV2.listFields.title = { css: "td.subject a" };
  htmlV2.listFields.url = { css: "td.subject a", attr: "href", parse: "url" };
  addPortal({
    id: "p_demo_stadtwerke", url: "http://localhost:4100/stadtwerke/", state: "serving", createdAgo: 60 * 20, lastSuccessAgo: 9,
    reason: `Serving 18 open tenders (0 new, 0 changed). Last read ${hhmm(9)}, all checks passed.`,
    recipes: [
      { ago: 60 * 20, origin: "attach", note: "Server-rendered table, 10 rows per page, next-page link.", recipe: htmlV1 },
      { ago: 60 * 7 - 3, origin: "repair", note: "The title column was renamed from title to subject; title and address now read from td.subject a.", recipe: htmlV2 },
    ],
    runs: [
      { ago: 60 * 20, kind: "read", result: "ok", seconds: 75, summary: "Attached the server-rendered table. Serving 18 open tenders.", cost: { purpose: "attach", inTok: 5400, outTok: 1100 } },
      ...everyHalfHour(60 * 19 - 9, 60 * 7 + 21, (ago) => `Serving 18 open tenders (0 new, 0 changed). Last read ${hhmm(ago)}, all checks passed.`, 22),
      { ago: 60 * 7, kind: "read", result: "failed", seconds: 20, summary: "No tender has a title (0 of 18).",
        events: [["warn", "Read looks wrong: no tender has a title (0 of 18). Starting a repair."], ["info", "Page structure changed since the last good read."]] },
      { ago: 60 * 7 - 1, kind: "repair", result: "ok", seconds: 95, summary: "The title column was renamed from title to subject; title and address now read from td.subject a. Serving 18 open tenders (0 new, 0 changed).",
        cost: { purpose: "repair", inTok: 6100, outTok: 420 },
        events: [["info", "Showing the model the old and new table header."], ["info", "Patch passed every check, golden tenders included (5 of 5)."]] },
      ...everyHalfHour(60 * 7 - 39, 9, (ago) => `Serving 18 open tenders (0 new, 0 changed). Last read ${hhmm(ago)}, all checks passed.`, 22),
    ],
    tenders: { count: 18, host: "localhost:4100", titles: ["Erneuerung Trinkwasserleitung Nordring", "Wartung Blockheizkraftwerk", "Lieferung Glasfaserkabel Los 2", "Winterdienst Betriebshof"], buyers: ["Stadtwerke Lindenau GmbH"] },
  });

  const jsonV1 = {
    schemaVersion: 1, family: null, tier: "jsonApi", timeZone: "Europe/Vienna", countryCode: "AT",
    list: { request: { url: "http://localhost:4100/ostwald/api/v1/tenders?page={page}" }, pagination: { type: "pageParam", start: 1, maxPages: 20 }, item: "$.items[*]" },
    listFields: { id: { jsonPath: "$.id" }, title: { jsonPath: "$.name" }, buyerName: { jsonPath: "$.authority" }, submissionDeadline: { jsonPath: "$.deadline", parse: "datetime" } },
  };
  addPortal({
    id: "p_demo_ostwald", url: "http://localhost:4100/ostwald/", state: "healing", createdAgo: 60 * 18, lastSuccessAgo: 38,
    reason: "Repairing: the tender list answers 404 at its old address. Serving the last 41 correct tenders meanwhile.",
    recipes: [{ ago: 60 * 18, origin: "attach", note: "JavaScript app over a JSON API at /api/v1/tenders.", recipe: jsonV1 }],
    runs: [
      { ago: 60 * 18, kind: "read", result: "ok", seconds: 120, summary: "Attached the JSON API behind the app. Serving 41 open tenders.", cost: { purpose: "attach", inTok: 7800, outTok: 950 } },
      ...everyHalfHour(60 * 17 - 8, 38, (ago) => `Serving 41 open tenders (0 new, ${ago % 240 === 38 ? 1 : 0} changed). Last read ${hhmm(ago)}, all checks passed.`, 30),
      { ago: 8, kind: "read", result: "failed", seconds: 6, summary: "The tender list answers 404 at its old address.",
        events: [["warn", "Read looks wrong: the tender list answers 404 at its old address. Starting a repair."]] },
      { ago: 7, kind: "repair", result: null, summary: "", cost: { purpose: "repair", inTok: 4200, outTok: 0 },
        events: [["info", "Looking for the list on the app's start page."], ["info", "Found requests to /api/v2/tenders; trying them."]] },
    ],
    tenders: { count: 41, host: "localhost:4100", titles: ["Sanierung Volksschule Ostwald", "Rahmenvertrag Büromaterial", "Neubau Feuerwehrhaus"], buyers: ["Bezirkshauptmannschaft Ostwald"] },
  });

  addPortal({
    id: "p_demo_boamp", url: "https://www.boamp.fr/", state: "failed", createdAgo: 60 * 26, lastSuccessAgo: null,
    reason: "Blocked: robots.txt disallows /api/, where this portal lists its tenders, so Watchtower does not read it.",
    runs: [
      { ago: 60 * 26, kind: "read", result: "failed", seconds: 12, summary: "Blocked: robots.txt disallows /api/.", events: [["warn", "robots.txt disallows /api/explore/v2.1/catalog/datasets/boamp/records for every bot."]] },
      ...[60 * 23, 60 * 17, 60 * 11, 60 * 5].map((ago): RunSpec => ({ ago, kind: "read", result: "failed", seconds: 2, summary: "Blocked: robots.txt still disallows /api/." })),
    ],
  });

  addPortal({
    id: "p_demo_kassel", url: "http://localhost:4100/kassel-vergabe/", state: "failed", createdAgo: 60 * 15, lastSuccessAgo: 60 * 3 + 12,
    reason: "Documents need a login: the download button leads to a sign-in page. Keeping the last 12 correct tenders.",
    recipes: [{ ago: 60 * 15, origin: "attach", note: "Paginated cards; documents behind a two-step download.", recipe: { ...htmlV1, list: { ...htmlV1.list, request: { url: "http://localhost:4100/kassel-vergabe/" } } } }],
    runs: [
      { ago: 60 * 15, kind: "read", result: "ok", seconds: 140, summary: "Attached the card list. Serving 12 open tenders.", cost: { purpose: "attach", inTok: 6900, outTok: 1200 } },
      ...everyHalfHour(60 * 14 - 12, 60 * 3 + 42, () => "Serving 12 open tenders (0 new, 0 changed), all checks passed.", 35),
      { ago: 60 * 3 + 12, kind: "read", result: "failed", seconds: 25, summary: "Documents need a login: the download button leads to a sign-in page.",
        events: [["warn", "Tender KS-2026-114: Documents need a login: the portal shows a login page instead of the file."]] },
      { ago: 60 * 3 + 11, kind: "repair", result: "failed", seconds: 50, summary: "Could not repair: every download path asks for a login. A person is needed.", cost: { purpose: "repair", inTok: 5200, outTok: 300 } },
      { ago: 60 * 2 + 42, kind: "read", result: "failed", seconds: 20, summary: "Documents need a login." },
      { ago: 72, kind: "read", result: "failed", seconds: 20, summary: "Documents need a login." },
      { ago: 42, kind: "read", result: "failed", seconds: 20, summary: "Documents need a login." },
    ],
    tenders: { count: 12, host: "localhost:4100", titles: ["Reinigung Rathaus Kassel", "Stadtbahn Gleisbau Los 4"], buyers: ["Stadt Kassel"] },
  });

  addPortal({
    id: "p_demo_harbour", url: "http://localhost:4100/harbour-board/", state: "serving", createdAgo: 60 * 9, lastSuccessAgo: 16,
    reason: `Serving 7 open tenders (1 new, 0 changed). Last read ${hhmm(16)}, all checks passed.`,
    recipes: [{ ago: 60 * 9, origin: "attach", note: "Atom feed of notices; no country stated, so it stays off the map.", recipe: { ...htmlV1, countryCode: null, tier: "feed", list: { ...htmlV1.list, request: { url: "http://localhost:4100/harbour-board/feed.xml" } } } }],
    runs: [
      { ago: 60 * 9, kind: "read", result: "ok", seconds: 30, summary: "Attached the notice feed. Serving 6 open tenders.", cost: { purpose: "attach", inTok: 2600, outTok: 600 } },
      ...everyHalfHour(60 * 9 - 16, 16, (ago) => `Serving 7 open tenders (0 new, 0 changed). Last read ${hhmm(ago)}, all checks passed.`, 12),
    ],
    tenders: { count: 7, host: "localhost:4100", titles: ["Dredging of the inner basin", "Quay crane maintenance"], buyers: ["Harbour Board"] },
  });

  // More portals across Europe, so the dashboard shows how it reads at a realistic size. These are
  // invented scenarios, so they use lab addresses (the rule above); the country comes from the recipe.
  // Germany gets enough of them that the map groups them into one numbered marker.
  const more: { key: string; url: string; country: string | null; state: "serving" | "healing" | "failed" | "integrating"; tenders: number; reason?: string; buyer: string; title: string }[] = [
    { key: "bundesvergabe", url: "http://localhost:4100/bundesvergabe/", country: "DE", state: "failed", tenders: 0, buyer: "", title: "", reason: "The tender list is drawn by JavaScript and no data address could be found, so Watchtower cannot read it yet." },
    { key: "rheinland_vergabe", url: "http://localhost:4100/rheinland-vergabe/", country: "DE", state: "serving", tenders: 214, buyer: "Stadt Köln", title: "Sanierung Schulzentrum Süd" },
    { key: "heidekreis_vergabe", url: "http://localhost:4100/heidekreis-vergabe/", country: "DE", state: "serving", tenders: 96, buyer: "Land Niedersachsen", title: "Rahmenvertrag Reinigungsleistungen" },
    { key: "ruhr_ausschreibungen", url: "http://localhost:4100/ruhr-ausschreibungen/", country: "DE", state: "healing", tenders: 133, buyer: "Stadtwerke Bochum", title: "Erneuerung Fernwärmeleitung",
      reason: "Repairing: the deadline column moved and now reads as the publication date. Serving the last 133 correct tenders meanwhile." },
    { key: "spree_vergabe", url: "http://localhost:4100/spree-vergabe/", country: "DE", state: "serving", tenders: 58, buyer: "Senatsverwaltung Berlin", title: "Lieferung von E-Lastenrädern" },
    { key: "wroclaw_przetargi", url: "http://localhost:4100/wroclaw-przetargi/", country: "PL", state: "serving", tenders: 412, buyer: "Gmina Wrocław", title: "Przebudowa ulicy Kościuszki" },
    { key: "mazowsze_zamowienia", url: "http://localhost:4100/mazowsze-zamowienia/", country: "PL", state: "integrating", tenders: 0, buyer: "", title: "" },
    { key: "meseta_contratos", url: "http://localhost:4100/meseta-contratos/", country: "ES", state: "failed", tenders: 0, buyer: "", title: "", reason: "Blocked: the search needs a session started by a person in a browser, so Watchtower does not read it." },
    { key: "bologna_gare", url: "http://localhost:4100/bologna-gare/", country: "IT", state: "serving", tenders: 187, buyer: "Comune di Bologna", title: "Fornitura arredi scolastici" },
    { key: "gent_aanbestedingen", url: "http://localhost:4100/gent-aanbestedingen/", country: "BE", state: "serving", tenders: 301, buyer: "Stad Gent", title: "Onderhoud groenzones" },
    { key: "graz_auftraege", url: "http://localhost:4100/graz-auftraege/", country: "AT", state: "serving", tenders: 77, buyer: "Stadt Graz", title: "Winterdienst 2027" },
    { key: "zurich_beschaffung", url: "http://localhost:4100/zurich-beschaffung/", country: "CH", state: "serving", tenders: 142, buyer: "Kanton Zürich", title: "Neubau Werkhof" },
    { key: "aarhus_udbud", url: "http://localhost:4100/aarhus-udbud/", country: "DK", state: "serving", tenders: 64, buyer: "Aarhus Kommune", title: "Levering af skolemælk" },
    { key: "goteborg_upphandling", url: "http://localhost:4100/goteborg-upphandling/", country: "SE", state: "serving", tenders: 49, buyer: "Göteborgs Stad", title: "Snöröjning centrum" },
    { key: "liffey_tenders", url: "http://localhost:4100/liffey-tenders/", country: "IE", state: "serving", tenders: 88, buyer: "Dublin City Council", title: "Street lighting maintenance" },
    { key: "lisboa_contratos", url: "http://localhost:4100/lisboa-contratos/", country: "PT", state: "integrating", tenders: 0, buyer: "", title: "" },
    { key: "brno_zakazky", url: "http://localhost:4100/brno-zakazky/", country: "CZ", state: "serving", tenders: 120, buyer: "Statutární město Brno", title: "Rekonstrukce tramvajové trati" },
    { key: "nordic_tender_hub", url: "http://localhost:4100/nordic-tender-hub/", country: null, state: "failed", tenders: 0, buyer: "", title: "", reason: "Blocked: the portal answers 403 Forbidden to automated reads." },
  ];
  more.forEach((m, n) => {
    const last = 3 + ((n * 7) % 25);
    const reason = m.reason ?? (m.state === "integrating" ? "Attaching: learning how to read this portal." : `Serving ${m.tenders} open tenders (${n % 3} new, 0 changed). Last read ${hhmm(last)}, all checks passed.`);
    const recipe = { ...htmlV1, countryCode: m.country, list: { ...htmlV1.list, request: { url: m.url } } };
    addPortal({
      id: `p_demo_${m.key}`, url: m.url, state: m.state, reason, createdAgo: m.state === "integrating" ? 1 + n : 60 * (10 + n), lastSuccessAgo: m.tenders ? last : null,
      recipes: m.state === "integrating" ? [] : [{ ago: 60 * (10 + n), origin: "attach", note: "Server-rendered list with a next-page link.", recipe }],
      runs: m.state === "integrating" ? [] : m.tenders === 0
        ? [{ ago: 60 * (10 + n), kind: "read", result: "failed", seconds: 9, summary: reason }]
        : [
            { ago: 60 * (10 + n), kind: "read", result: "ok", seconds: 90, summary: `Attached the list. Serving ${m.tenders} open tenders.`, cost: { purpose: "attach", inTok: 5000 + n * 120, outTok: 900 } },
            ...(m.state === "healing"
              ? [
                  { ago: 12, kind: "read" as const, result: "failed" as const, seconds: 14, summary: "Deadline equals the publication date on 133 of 133 tenders." },
                  { ago: 11, kind: "repair" as const, result: null, summary: "", cost: { purpose: "repair", inTok: 3900, outTok: 0 } },
                ]
              : []),
          ],
      tenders: m.tenders ? { count: m.tenders, host: "localhost:4100", titles: [m.title], buyers: [m.buyer] } : undefined,
    });
  });

  addPortal({
    id: "p_demo_evergabe", url: "https://www.evergabe-online.de/", state: "integrating", createdAgo: 2, lastSuccessAgo: null,
    reason: "Attaching: learning how to read this portal.", runs: [],
  });
}

if (fresh) {
  seed();
  console.log(`Seeded demo data in ${process.env.DATA_DIR}.`);
}
const app = await buildServer();
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`Demo dashboard on http://localhost:${config.port} (worker off; delete ${process.env.DATA_DIR} to reseed).`);
