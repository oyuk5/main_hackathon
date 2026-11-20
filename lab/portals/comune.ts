/**
 * Demo portal 5: Comune di Valdoria (IT). A JavaScript app: the HTML is an empty shell, the tender
 * list comes from a JSON API that only answers POST with a JSON body ({"dimensione":5,"cursore":...})
 * and pages with an opaque `next` cursor. Every tender has a JSON detail (/comune/api/bandi/{id}) and
 * an HTML detail page (/comune/bandi/{id}, rendered by the app). Documents are two hops away:
 * detail → "allegati" list (/comune/api/bandi/{id}/allegati) → file (/comune/download/{id}/{name}).
 * Traps: POST-only search (GET answers 405), cursor pagination, deadlines as Rome local time without
 * offset ("2026-12-09T12:00:00"), CPV with check digits, one revoked tender (stato "revocata"),
 * some documents only inside a ZIP.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { addDays, cookieBanner, esc, fakeFile, fakePdf, notFound, page, sendFile, sendHtml, sendJson, today, zipBytes, type LabPortal, type LabTender } from "./common.js";

const ZONE = "Europe/Rome";
const PAGE_SIZE = 5;
const MAX_SIZE = 20;
const BUYER = "Comune di Valdoria";

const ROWS: Array<[string, LabTender["contractNature"], LabTender["procedureType"], string[], string, string, string]> = [
  ["Riqualificazione energetica della scuola primaria Giovanni Pascoli", "works", "open", ["45321000-3", "45331000-6"], "52040", "Valdoria", "Isolamento a cappotto, sostituzione degli infissi e della centrale termica della scuola primaria."],
  ["Fornitura di pasti per la refezione scolastica", "supplies", "open", ["15894210-6"], "52040", "Valdoria", "Fornitura e consegna di pasti veicolati per circa 650 alunni delle scuole comunali."],
  ["Manutenzione del verde pubblico 2027-2028", "services", "open", ["77310000-6"], "52040", "Valdoria", "Sfalcio, potatura e diserbo di parchi, giardini e aiuole comunali per due anni."],
  ["Manutenzione degli impianti di illuminazione pubblica", "services", "restricted", ["50232100-1"], "52040", "Valdoria", "Manutenzione ordinaria e straordinaria di circa 2 300 punti luce."],
  ["Fornitura di veicoli commerciali elettrici per la polizia locale", "supplies", "open", ["34144900-7"], "52040", "Valdoria", "Fornitura di quattro veicoli commerciali elettrici allestiti per la polizia locale."],
  ["Rifacimento della pavimentazione stradale di via Garibaldi", "works", "open", ["45233140-2"], "52041", "Borgo Ceriano", "Fresatura e nuovo tappeto d'usura su 900 metri di carreggiata e marciapiedi."],
  ["Servizio di pulizia degli edifici comunali", "services", "negotiated", ["90910000-9"], "52040", "Valdoria", "Pulizia ordinaria del municipio, della biblioteca e di sei sedi comunali."],
  ["Servizio di raccolta e trasporto dei rifiuti urbani", "services", "open", ["90513100-7"], "52040", "Valdoria", "Raccolta porta a porta e trasporto dei rifiuti urbani all'impianto di trattamento."],
  ["Fornitura di arredi scolastici", "supplies", "open", ["39160000-1"], "52040", "Valdoria", "Fornitura di banchi, sedie e armadi per quattro plessi scolastici."],
  ["Servizio di sgombero neve e trattamento antighiaccio", "services", "open", ["90620000-9"], "52042", "Monte Aurelio", "Sgombero neve e spargimento di sale sulle strade comunali per le stagioni 2026-2028."],
  ["Estensione della rete idrica in località Borgo Ceriano", "works", "restricted", ["45231300-8"], "52041", "Borgo Ceriano", "Posa di 3,8 km di condotta idrica con allacci alle utenze."],
  ["Fornitura di personal computer per gli uffici comunali", "supplies", "open", ["30213100-6"], "52040", "Valdoria", "Fornitura di 30 computer portatili con docking station."],
  ["Progettazione della rete fognaria delle frazioni", "services", "open", ["71320000-7"], "52042", "Monte Aurelio", "Progettazione di fattibilità tecnico-economica ed esecutiva della rete fognaria di tre frazioni."],
];

const PROCEDURA = { open: "Procedura aperta", restricted: "Procedura ristretta", negotiated: "Procedura negoziata" } as const;
const TIPOLOGIA = { works: "Lavori", services: "Servizi", supplies: "Forniture" } as const;

function build(): LabTender[] {
  const day = today(ZONE);
  return ROWS.map(([title, nature, procedure, cpv, postalCode, city, description], i) => {
    const n = 41 + i;
    const id = `G${2026}${String(n).padStart(4, "0")}`;
    const ref = `VLD-2026-${String(n).padStart(3, "0")}`;
    const t: LabTender = {
      id,
      referenceNumber: ref,
      title,
      buyerName: BUYER,
      publicationDate: addDays(day, -(i + 2)),
      deadlineDate: addDays(day, 10 + i * 2),
      deadlineTime: i % 3 === 1 ? "13:00" : "12:00",
      description,
      procedureType: procedure,
      contractNature: nature,
      cpv,
      postalCode,
      city,
      withdrawn: i === 6,
      files: [
        { name: `Bando_di_gara_${ref}.pdf`, bytes: fakePdf(`Bando di gara ${ref} ${title}`) },
        { name: `Disciplinare_di_gara_${ref}.pdf`, bytes: fakePdf(`Disciplinare di gara ${ref}`) },
      ],
    };
    const forms = [
      { name: `Capitolato_speciale_${ref}.pdf`, bytes: fakePdf(`Capitolato speciale d'appalto ${ref} ${description}`) },
      { name: `Modello_A_Domanda_di_partecipazione_${ref}.docx`, bytes: fakeFile(`Domanda di partecipazione ${ref}`) },
    ];
    // Every fourth tender (from the third) packs its tender specification and forms in a ZIP.
    if (i % 4 === 2) t.zip = { name: `Documentazione_${ref}.zip`, members: forms };
    else t.files.push(...forms);
    return t;
  });
}

const tenders = build();

const VARIANTS = {
  "renamed-keys": "JSON keys renamed (elementi → risultati, next → cursoreSuccessivo, oggetto → titolo, scadenza → termineOfferte, stazioneAppaltante → ente, allegati → documenti, nome → nomeFile, url → link, ...).",
  "moved-api": "The API moves from /comune/api/bandi to /comune/api/v2/gare (search, details and allegati); the old addresses answer 404.",
  "cursor-to-pages": "Cursor pagination replaced by page numbers: the search takes {\"pagina\":N,\"dimensione\":5} and answers pagina, pagine and totale instead of next; a cursor is ignored.",
  "date-format": "Dates as '18/11/2026' and deadlines as '09/12/2026 ore 12:00' instead of ISO local times.",
  "cookie-banner": "A cookie consent overlay in the app shell. Data unchanged: must stay serving.",
  "empty-day": "No tenders today: the search answers an empty list and the page says 'Nessuna gara in corso.'. Must stay serving, not broken.",
};

/** JSON key names; they change together in the renamed-keys variant. */
const KEYS_V1 = {
  list: "elementi", next: "next", title: "oggetto", ref: "codice", buyer: "stazioneAppaltante", published: "dataPubblicazione",
  deadline: "scadenza", state: "stato", procedure: "procedura", nature: "tipologia", cpv: "cpv", desc: "descrizione",
  place: "luogo", postal: "cap", city: "comune", docsLink: "linkAllegati", detailLink: "dettaglio",
  files: "allegati", fileName: "nome", fileSize: "dimensione", fileLink: "url",
};
const KEYS_V2: typeof KEYS_V1 = {
  list: "risultati", next: "cursoreSuccessivo", title: "titolo", ref: "numeroGara", buyer: "ente", published: "pubblicataIl",
  deadline: "termineOfferte", state: "statoGara", procedure: "tipoProcedura", nature: "categoria", cpv: "codiciCpv", desc: "oggettoEsteso",
  place: "sede", postal: "codicePostale", city: "localita", docsLink: "documentiUrl", detailLink: "scheda",
  files: "documenti", fileName: "nomeFile", fileSize: "byte", fileLink: "link",
};

const keys = (variant: string) => (variant === "renamed-keys" ? KEYS_V2 : KEYS_V1);

/** Full API path (with /comune) of the tender resources. */
export function apiBase(variant: string): string {
  return variant === "moved-api" ? "/comune/api/v2/gare" : "/comune/api/bandi";
}

function itDate(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}

function dates(t: LabTender, variant: string) {
  if (variant === "date-format") return { published: itDate(t.publicationDate), deadline: `${itDate(t.deadlineDate)} ore ${t.deadlineTime}` };
  return { published: t.publicationDate, deadline: `${t.deadlineDate}T${t.deadlineTime}:00` };
}

function summary(t: LabTender, variant: string) {
  const k = keys(variant);
  const d = dates(t, variant);
  return {
    id: t.id,
    [k.ref]: t.referenceNumber,
    [k.title]: t.title,
    [k.buyer]: t.buyerName,
    [k.published]: d.published,
    [k.deadline]: d.deadline,
    [k.state]: t.withdrawn ? "revocata" : "in corso",
    [k.detailLink]: `${apiBase(variant)}/${t.id}`,
  };
}

function detail(t: LabTender, variant: string) {
  const k = keys(variant);
  return {
    ...summary(t, variant),
    [k.desc]: t.description,
    [k.procedure]: PROCEDURA[t.procedureType],
    [k.nature]: TIPOLOGIA[t.contractNature],
    [k.cpv]: t.cpv,
    [k.place]: { [k.postal]: t.postalCode, [k.city]: t.city, provincia: "VD" },
    ...(t.withdrawn ? { motivazioneRevoca: "Gara revocata in autotutela con determinazione dirigenziale." } : {}),
    [k.docsLink]: `${apiBase(variant)}/${t.id}/allegati`,
  };
}

/** What the allegati endpoint lists: the files, then the ZIP (whose members are the truth's documents). */
export function downloads(t: LabTender): Array<{ name: string; bytes: Buffer }> {
  return [...t.files, ...(t.zip ? [{ name: t.zip.name, bytes: zipBytes(t) }] : [])];
}

function allegati(t: LabTender, variant: string) {
  const k = keys(variant);
  return {
    id: t.id,
    [k.files]: downloads(t).map((f) => ({
      [k.fileName]: f.name,
      [k.fileSize]: f.bytes.length,
      [k.fileLink]: `/comune/download/${t.id}/${encodeURIComponent(f.name)}`,
    })),
  };
}

// ---------------------------------------------------------------- cursors

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset, v: 1 })).toString("base64url");
}

function decodeCursor(c: unknown): number | null {
  if (c === undefined || c === null || c === "") return 0;
  if (typeof c !== "string") return null;
  try {
    const o = (JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as { o?: unknown }).o;
    return typeof o === "number" && Number.isInteger(o) && o >= 0 ? o : null;
  } catch {
    return null;
  }
}

function sizeOf(v: unknown): number {
  const n = Number(v ?? PAGE_SIZE);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_SIZE) : PAGE_SIZE;
}

/** Answers one search request body. */
export function search(list: LabTender[], body: Record<string, unknown>, variant: string): { status: number; data: unknown } {
  const k = keys(variant);
  const size = sizeOf(body.dimensione);
  if (variant === "cursor-to-pages") {
    const pages = Math.max(1, Math.ceil(list.length / size));
    const n = Math.max(1, Math.floor(Number(body.pagina ?? 1)) || 1);
    const start = (n - 1) * size;
    return { status: 200, data: { [k.list]: list.slice(start, start + size).map((t) => summary(t, variant)), pagina: n, dimensione: size, pagine: pages, totale: list.length } };
  }
  const start = decodeCursor(body.cursore);
  if (start === null) return { status: 400, data: { errore: "cursore non valido" } };
  const end = start + size;
  return {
    status: 200,
    data: { [k.list]: list.slice(start, end).map((t) => summary(t, variant)), [k.next]: end < list.length ? encodeCursor(end) : null, dimensione: size },
  };
}

// ---------------------------------------------------------------- app

/** The app knows its own API: key names, address and paging style change together with the variant. */
function appJs(variant: string): string {
  const cfg = { api: apiBase(variant), k: keys(variant), size: PAGE_SIZE, pages: variant === "cursor-to-pages" };
  return `
const C = ${JSON.stringify(cfg)};
const app = document.getElementById("app");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const revocata = (g) => g[C.k.state] === "revocata";
async function cerca(body) {
  const r = await fetch(C.api + "/ricerca", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
function riga(g) {
  return '<article class="gara"><h2><a href="/comune/bandi/' + encodeURIComponent(g.id) + '">' + esc(g[C.k.title]) + '</a></h2>' +
    '<p class="codice">' + esc(g[C.k.ref]) + ' · ' + esc(g[C.k.buyer]) + '</p>' +
    '<p>Scadenza offerte: ' + esc(g[C.k.deadline]) + (revocata(g) ? ' · <strong class="revocata">Revocata</strong>' : '') + '</p></article>';
}
const vuoto = () => { app.innerHTML = "<h1>Bandi di gara</h1><p class='vuoto'>Nessuna gara in corso.</p>"; };
async function elencoCursore() {
  let cursore = null;
  const box = document.createElement("div");
  box.className = "elenco";
  app.innerHTML = "<h1>Bandi di gara</h1>";
  app.appendChild(box);
  const altri = document.createElement("button");
  altri.className = "carica-altri";
  altri.textContent = "Carica altri bandi";
  async function carica() {
    const d = await cerca({ dimensione: C.size, cursore });
    const items = d[C.k.list] || [];
    if (!items.length && !box.children.length) return vuoto();
    box.insertAdjacentHTML("beforeend", items.map(riga).join(""));
    cursore = d[C.k.next];
    if (cursore) app.appendChild(altri); else altri.remove();
  }
  altri.addEventListener("click", carica);
  await carica();
}
async function elencoPagine(n) {
  const d = await cerca({ pagina: n, dimensione: C.size });
  const items = d[C.k.list] || [];
  if (!items.length) return vuoto();
  const nav = Array.from({ length: d.pagine }, (_, i) => '<button data-pagina="' + (i + 1) + '"' + (i + 1 === n ? ' aria-current="page"' : '') + '>' + (i + 1) + '</button>').join("");
  app.innerHTML = '<h1>Bandi di gara</h1><div class="elenco">' + items.map(riga).join("") + '</div><nav class="paginazione">' + nav + '</nav>';
  app.querySelectorAll("button[data-pagina]").forEach((b) => b.addEventListener("click", () => elencoPagine(Number(b.dataset.pagina))));
}
async function scheda(id) {
  const r = await fetch(C.api + "/" + encodeURIComponent(id));
  if (!r.ok) { app.innerHTML = "<h1>Gara non trovata</h1>"; return; }
  const g = await r.json();
  const l = g[C.k.place] || {};
  app.innerHTML = '<h1>' + esc(g[C.k.title]) + '</h1>' + (revocata(g) ? '<p class="revocata">Gara revocata. ' + esc(g.motivazioneRevoca) + '</p>' : '') +
    '<dl class="dati"><dt>Codice gara</dt><dd>' + esc(g[C.k.ref]) + '</dd><dt>Stazione appaltante</dt><dd>' + esc(g[C.k.buyer]) + '</dd>' +
    '<dt>Data di pubblicazione</dt><dd>' + esc(g[C.k.published]) + '</dd><dt>Termine presentazione offerte</dt><dd>' + esc(g[C.k.deadline]) + '</dd>' +
    '<dt>Procedura</dt><dd>' + esc(g[C.k.procedure]) + '</dd><dt>Tipologia</dt><dd>' + esc(g[C.k.nature]) + '</dd>' +
    '<dt>CPV</dt><dd>' + esc((g[C.k.cpv] || []).join(", ")) + '</dd><dt>Luogo di esecuzione</dt><dd>' + esc(l[C.k.postal]) + ' ' + esc(l[C.k.city]) + '</dd>' +
    '<dt>Stato</dt><dd>' + esc(g[C.k.state]) + '</dd></dl><p class="descrizione">' + esc(g[C.k.desc]) + '</p>' +
    '<p><a class="allegati" href="/comune/bandi/' + encodeURIComponent(id) + '/allegati">Documentazione di gara (allegati)</a></p>';
}
async function elencoAllegati(id) {
  const r = await fetch(C.api + "/" + encodeURIComponent(id) + "/allegati");
  if (!r.ok) { app.innerHTML = "<h1>Gara non trovata</h1>"; return; }
  const d = await r.json();
  app.innerHTML = '<h1>Allegati</h1><p><a href="/comune/bandi/' + encodeURIComponent(id) + '">Torna alla gara</a></p><ul class="allegati">' +
    d[C.k.files].map((f) => '<li><a href="' + esc(f[C.k.fileLink]) + '">' + esc(f[C.k.fileName]) + '</a> (' + esc(f[C.k.fileSize]) + ' byte)</li>').join("") + '</ul>';
}
const a = location.pathname.match(/^\\/comune\\/bandi\\/([^/]+)\\/allegati$/);
const s = location.pathname.match(/^\\/comune\\/bandi\\/([^/]+)$/);
if (a) elencoAllegati(decodeURIComponent(a[1]));
else if (s) scheda(decodeURIComponent(s[1]));
else if (C.pages) elencoPagine(1);
else elencoCursore();
`;
}

function shell(variant: string): string {
  const banner = variant === "cookie-banner" ? cookieBanner("Questo sito utilizza cookie tecnici e di terze parti per statistiche di navigazione.", "Accetta tutti") : "";
  const initial = variant === "empty-day" ? "<p class='vuoto'>Nessuna gara in corso.</p>" : "<p class='caricamento'>Caricamento dei bandi in corso…</p>";
  return page(
    "Bandi di gara | Comune di Valdoria",
    "it",
    `${banner}<header><a href="/comune/">Comune di Valdoria · Amministrazione trasparente · Bandi di gara e contratti</a></header>` +
      `<main id="app">${initial}<noscript>Per consultare i bandi è necessario abilitare JavaScript.</noscript></main>` +
      `<footer>${esc(BUYER)} · Piazza del Comune 1 · 52040 Valdoria</footer><script src="/comune/static/bandi.js" defer></script>`,
  );
}

// ---------------------------------------------------------------- server

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw) as unknown;
        resolve(v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function handleSearch(req: IncomingMessage, res: ServerResponse, list: LabTender[], variant: string): void {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ errore: "Metodo non consentito: usare POST con un corpo JSON." }));
    return;
  }
  readJson(req)
    .then((body) => {
      if (!body) return sendJson(res, { errore: "corpo JSON non valido" }, 400);
      const r = search(list, body, variant);
      sendJson(res, r.data, r.status);
    })
    .catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
}

export const comune: LabPortal = {
  slug: "comune",
  name: "Comune di Valdoria",
  country: "IT",
  timeZone: ZONE,
  kind: "JavaScript app over a POST JSON API, cursor pagination, two-hop documents",
  notes: [
    "The search API only answers POST /comune/api/bandi/ricerca with a JSON body; GET answers 405.",
    "Pagination by the opaque 'next' cursor, passed back as 'cursore'.",
    "Gara G20260047 is revoked (stato 'revocata').",
    "scadenza is Europe/Rome local time without offset.",
    "Documents: detail → linkAllegati → file; some files only inside a ZIP.",
  ],
  tenders,
  variants: VARIANTS,
  tenderUrl: (base, t) => `${base}/comune/bandi/${t.id}`,

  handle(req, res, path, _url, ctx) {
    const v = ctx.variant;
    const list = v === "empty-day" ? [] : tenders;
    const api = apiBase(v).slice("/comune".length);
    if (path === "/" || path === "" || /^\/bandi\/[^/]+(\/allegati)?$/.test(path)) return sendHtml(res, shell(v));
    if (path === "/static/bandi.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(appJs(v));
      return;
    }
    if (path === `${api}/ricerca`) return handleSearch(req, res, list, v);
    const rest = path.startsWith(api + "/") ? path.slice(api.length + 1) : null;
    const m = rest?.match(/^([^/]+)(\/allegati)?$/);
    if (m) {
      const t = list.find((x) => x.id === m[1]);
      if (!t) return sendJson(res, { errore: "gara non trovata" }, 404);
      return sendJson(res, m[2] ? allegati(t, v) : detail(t, v));
    }
    const dl = path.match(/^\/download\/([^/]+)\/([^/]+)$/);
    if (dl) {
      const t = list.find((x) => x.id === dl[1]);
      const f = t && downloads(t).find((x) => x.name === dl[2]);
      return f ? sendFile(res, f.name, f.bytes) : notFound(res);
    }
    notFound(res);
  },
};
