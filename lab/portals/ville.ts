/**
 * Demo portal 2: Ville de Rivemont (FR). A JavaScript app: the HTML is an empty shell and the
 * tenders come from a JSON API (/ville/api/consultations?page=N&taille=5). Detail pages are
 * rendered by the same app from /ville/api/consultations/{id}.
 * Traps: nothing in the raw HTML, deadlines as local Paris time without offset ("2026-12-09 12:00"),
 * CPV with check digits, one cancelled consultation ("annulee": true).
 */
import { addDays, cookieBanner, fakeFile, fakePdf, notFound, page, sendFile, sendHtml, sendJson, today, type LabPortal, type LabTender } from "./common.js";

const ZONE = "Europe/Paris";
const PAGE_SIZE = 5;

const ROWS: Array<[string, LabTender["contractNature"], LabTender["procedureType"], string[], string, string, string]> = [
  ["Rénovation énergétique de l'école Jules Ferry", "works", "open", ["45321000-3", "45331000-6"], "69003", "Rivemont", "Isolation thermique par l'extérieur et remplacement du système de chauffage."],
  ["Fourniture de repas pour la restauration scolaire", "supplies", "open", ["15894210-6"], "69003", "Rivemont", "Fourniture et livraison de repas en liaison froide pour 1 400 élèves."],
  ["Entretien des espaces verts", "services", "open", ["77310000-6"], "69004", "Rivemont", "Tonte, taille et désherbage des parcs et jardins municipaux."],
  ["Maintenance de l'éclairage public", "services", "restricted", ["50232100-1"], "69003", "Rivemont", "Maintenance préventive et curative de 4 200 points lumineux."],
  ["Acquisition de véhicules utilitaires électriques", "supplies", "open", ["34144900-7"], "69003", "Rivemont", "Acquisition de huit véhicules utilitaires électriques."],
  ["Réfection de la voirie rue Victor Hugo", "works", "open", ["45233140-2"], "69005", "Rivemont", "Réfection de la chaussée et des trottoirs sur 600 mètres."],
  ["Prestations de nettoyage des bâtiments communaux", "services", "negotiated", ["90910000-9"], "69003", "Rivemont", "Nettoyage courant de douze bâtiments communaux."],
  ["Construction d'un gymnase", "works", "restricted", ["45212222-8"], "69006", "Rivemont", "Construction d'un gymnase de type C avec tribunes."],
  ["Fourniture de mobilier scolaire", "supplies", "open", ["39160000-1"], "69003", "Rivemont", "Fourniture de tables, chaises et rangements pour six écoles."],
  ["Assistance à maîtrise d'ouvrage informatique", "services", "open", ["72224000-1"], "69003", "Rivemont", "Assistance pour le renouvellement du système d'information."],
  ["Travaux d'accessibilité de la mairie", "works", "open", ["45453000-7"], "69003", "Rivemont", "Mise en accessibilité PMR de l'hôtel de ville."],
];

const PROCEDURE = { open: "Appel d'offres ouvert", restricted: "Appel d'offres restreint", negotiated: "Procédure négociée" } as const;
const NATURE = { works: "Travaux", services: "Services", supplies: "Fournitures" } as const;

function build(): LabTender[] {
  const day = today(ZONE);
  return ROWS.map(([title, nature, procedure, cpv, postalCode, city, description], i) => {
    const id = `c-${2026}${String(140 + i * 3)}`;
    const ref = `2026-RIV-${String(14 + i).padStart(3, "0")}`;
    const files = [
      { name: `RC_${ref}.pdf`, bytes: fakePdf(`Reglement de consultation ${ref}`) },
      { name: `CCTP_${ref}.pdf`, bytes: fakePdf(`CCTP ${ref} ${description}`) },
    ];
    if (i % 4 === 1) files.push({ name: `DPGF_${ref}.xlsx`, bytes: fakeFile(`DPGF ${ref}`) });
    return {
      id,
      referenceNumber: ref,
      title,
      buyerName: "Ville de Rivemont",
      publicationDate: addDays(day, -(2 * i + 1)),
      deadlineDate: addDays(day, 12 + i * 2),
      deadlineTime: i % 3 === 0 ? "12:00" : "17:00",
      description,
      procedureType: procedure,
      contractNature: nature,
      cpv,
      postalCode,
      city,
      withdrawn: i === 3,
      files,
    };
  });
}

const tenders = build();

const VARIANTS = {
  "renamed-keys": "JSON keys renamed (resultats → items, intitule → titre, acheteur.nom → organisme, dateLimiteRemise → dateLimite, pieces → documents, ...).",
  "moved-list": "The API moves from /ville/api/consultations to /ville/api/v2/consultations; the old address answers 404.",
  "new-pagination": "Page numbers replaced by offset/limit (?offset=0&limit=4); the page parameter is ignored.",
  "date-format": "Dates as '18/11/2026' and deadlines as '09/12/2026 à 12h00' instead of ISO.",
  "cookie-banner": "A cookie consent overlay in the app shell. Data unchanged: must stay serving.",
  "empty-day": "No consultations today (total 0). Must stay serving, not broken.",
};

/** JSON key names that change in the renamed-keys variant. */
const KEYS_V1 = { list: "resultats", total: "total", title: "intitule", deadline: "dateLimiteRemise", published: "datePublication", files: "pieces", fileName: "nom", fileLink: "lien" };
const KEYS_V2 = { list: "items", total: "count", title: "titre", deadline: "dateLimite", published: "publieLe", files: "documents", fileName: "fichier", fileLink: "url" };

function apiBase(variant: string): string {
  return variant === "moved-list" ? "/ville/api/v2/consultations" : "/ville/api/consultations";
}

function frDate(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}

function apiItem(t: LabTender, variant: string) {
  const k = variant === "renamed-keys" ? KEYS_V2 : KEYS_V1;
  const fmt = variant === "date-format";
  const files = t.files.map((f) => ({
    [k.fileName]: f.name,
    taille: f.bytes.length,
    [k.fileLink]: `${apiBase(variant)}/${t.id}/pieces/${encodeURIComponent(f.name)}`,
  }));
  if (variant === "renamed-keys") {
    return {
      id: t.id,
      numero: t.referenceNumber,
      [k.title]: t.title,
      organisme: t.buyerName,
      [k.published]: t.publicationDate,
      [k.deadline]: `${t.deadlineDate} ${t.deadlineTime}`,
      typeProcedure: PROCEDURE[t.procedureType],
      categorie: NATURE[t.contractNature],
      cpv: t.cpv,
      lieu: { cp: t.postalCode, commune: t.city },
      description: t.description,
      etat: t.withdrawn ? "annulée" : "en cours",
      [k.files]: files,
    };
  }
  return {
    id: t.id,
    reference: t.referenceNumber,
    intitule: t.title,
    acheteur: { nom: t.buyerName },
    datePublication: fmt ? frDate(t.publicationDate) : t.publicationDate,
    dateLimiteRemise: fmt ? `${frDate(t.deadlineDate)} à ${t.deadlineTime.replace(":", "h")}` : `${t.deadlineDate} ${t.deadlineTime}`,
    procedure: PROCEDURE[t.procedureType],
    nature: NATURE[t.contractNature],
    codesCpv: t.cpv,
    lieuExecution: { codePostal: t.postalCode, ville: t.city },
    objet: t.description,
    annulee: t.withdrawn,
    pieces: files,
  };
}

/** The app knows its own API: key names, address and paging style change together with the variant. */
function appJs(variant: string): string {
  const k = variant === "renamed-keys" ? KEYS_V2 : KEYS_V1;
  const v2 = variant === "renamed-keys";
  const offset = variant === "new-pagination";
  const cfg = {
    api: apiBase(variant),
    k,
    buyer: v2 ? "organisme" : "acheteur.nom",
    ref: v2 ? "numero" : "reference",
    cancelled: v2 ? "etat" : "annulee",
    size: offset ? 4 : PAGE_SIZE,
    offset,
  };
  return `
const C = ${JSON.stringify(cfg)};
const app = document.getElementById("app");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const get = (o, p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
const isCancelled = (c) => { const v = get(c, C.cancelled); return v === true || v === "annulée"; };
async function list(page) {
  const q = C.offset ? "?offset=" + (page - 1) * C.size + "&limit=" + C.size : "?page=" + page + "&taille=" + C.size;
  const d = await (await fetch(C.api + q)).json();
  const items = d[C.k.list];
  if (!items.length) { app.innerHTML = "<h1>Consultations en cours</h1><p class='vide'>Aucune consultation en cours.</p>"; return; }
  const rows = items.map((c) =>
    '<article class="consultation"><h2><a href="/ville/consultation/' + c.id + '">' + esc(c[C.k.title]) + '</a></h2>' +
    '<p class="ref">' + esc(get(c, C.ref)) + ' · ' + esc(get(c, C.buyer)) + '</p>' +
    '<p>Date limite : ' + esc(c[C.k.deadline]) + (isCancelled(c) ? ' · <strong>Annulée</strong>' : '') + '</p></article>').join("");
  const pages = Math.ceil(d[C.k.total] / C.size);
  const nav = Array.from({ length: pages }, (_, i) => '<button data-page="' + (i + 1) + '"' + (i + 1 === page ? ' aria-current="page"' : '') + '>' + (i + 1) + '</button>').join("");
  app.innerHTML = '<h1>Consultations en cours</h1>' + rows + '<nav class="pagination">' + nav + '</nav>';
  app.querySelectorAll("button[data-page]").forEach((b) => b.addEventListener("click", () => list(Number(b.dataset.page))));
}
async function detail(id) {
  const r = await fetch(C.api + "/" + id);
  if (!r.ok) { app.innerHTML = "<h1>Consultation introuvable</h1>"; return; }
  const c = await r.json();
  app.innerHTML = '<h1>' + esc(c[C.k.title]) + '</h1>' + (isCancelled(c) ? '<p class="annulee">Cette consultation a été annulée.</p>' : '') +
    '<ul class="infos"><li>Référence : ' + esc(get(c, C.ref)) + '</li><li>Acheteur : ' + esc(get(c, C.buyer)) + '</li>' +
    '<li>Publiée le : ' + esc(c[C.k.published]) + '</li><li>Date limite de remise : ' + esc(c[C.k.deadline]) + '</li></ul>' +
    '<h2>Dossier de consultation (DCE)</h2><ul class="pieces">' +
    c[C.k.files].map((p) => '<li><a href="' + p[C.k.fileLink] + '">' + esc(p[C.k.fileName]) + '</a></li>').join("") + '</ul>';
}
const m = location.pathname.match(/^\\/ville\\/consultation\\/([^/]+)$/);
if (m) detail(m[1]); else list(1);
`;
}

function shell(variant: string): string {
  const banner = variant === "cookie-banner" ? cookieBanner("Ce site utilise des cookies pour mesurer l'audience.", "Tout accepter") : "";
  return page(
    "Marchés publics | Ville de Rivemont",
    "fr",
    `${banner}<header><a href="/ville/">Ville de Rivemont · Marchés publics</a></header><main id="app"><noscript>Activez JavaScript pour consulter les marchés.</noscript></main><script src="/ville/app.js"></script>`,
  );
}

export const ville: LabPortal = {
  slug: "ville",
  name: "Ville de Rivemont",
  country: "FR",
  timeZone: ZONE,
  kind: "JavaScript app over a JSON API, page-number pagination",
  notes: ["Consultation c-2026149 is cancelled ('annulee': true).", "dateLimiteRemise is Europe/Paris local time without offset."],
  tenders,
  variants: VARIANTS,
  tenderUrl: (base, t) => `${base}/ville/consultation/${t.id}`,

  handle(_req, res, path, url, ctx) {
    const v = ctx.variant;
    const list = v === "empty-day" ? [] : tenders;
    const api = apiBase(v).slice("/ville".length);
    const k = v === "renamed-keys" ? KEYS_V2 : KEYS_V1;
    if (path === "/" || path === "" || /^\/consultation\/[^/]+$/.test(path)) return sendHtml(res, shell(v));
    if (path === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(appJs(v));
      return;
    }
    if (path === api) {
      let start: number;
      let size: number;
      if (v === "new-pagination") {
        size = Math.min(Math.max(1, Number(url.searchParams.get("limit") ?? 4) || 4), 50);
        start = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
      } else {
        size = Math.min(Math.max(1, Number(url.searchParams.get("taille") ?? PAGE_SIZE) || PAGE_SIZE), 50);
        start = (Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1) - 1) * size;
      }
      const body: Record<string, unknown> = { [k.total]: list.length, [k.list]: list.slice(start, start + size).map((t) => apiItem(t, v)) };
      if (v === "new-pagination") Object.assign(body, { offset: start, limit: size });
      else Object.assign(body, { page: Math.floor(start / size) + 1, taille: size });
      return sendJson(res, body);
    }
    const one = path.startsWith(api + "/") ? path.slice(api.length + 1) : null;
    if (one && !one.includes("/")) {
      const t = list.find((x) => x.id === one);
      return t ? sendJson(res, apiItem(t, v)) : sendJson(res, { erreur: "introuvable" }, 404);
    }
    const file = one?.match(/^([^/]+)\/pieces\/([^/]+)$/);
    if (file) {
      const f = list.find((x) => x.id === file[1])?.files.find((x) => x.name === decodeURIComponent(file[2]!));
      return f ? sendFile(res, f.name, f.bytes) : notFound(res);
    }
    notFound(res);
  },
};
