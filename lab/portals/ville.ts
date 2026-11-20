/**
 * Demo portal 2: Ville de Rivemont (FR). A JavaScript app: the HTML is an empty shell and the
 * tenders come from a JSON API (/ville/api/consultations?page=N&taille=5). Detail pages are
 * rendered by the same app from /ville/api/consultations/{id}.
 * Traps: nothing in the raw HTML, deadlines as local Paris time without offset ("2026-12-09 12:00"),
 * CPV with check digits, one cancelled consultation ("annulee": true).
 */
import { addDays, fakeFile, fakePdf, notFound, page, sendFile, sendHtml, sendJson, today, type LabPortal, type LabTender } from "./common.js";

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

function apiItem(t: LabTender) {
  return {
    id: t.id,
    reference: t.referenceNumber,
    intitule: t.title,
    acheteur: { nom: t.buyerName },
    datePublication: t.publicationDate,
    dateLimiteRemise: `${t.deadlineDate} ${t.deadlineTime}`,
    procedure: PROCEDURE[t.procedureType],
    nature: NATURE[t.contractNature],
    codesCpv: t.cpv,
    lieuExecution: { codePostal: t.postalCode, ville: t.city },
    objet: t.description,
    annulee: t.withdrawn,
    pieces: t.files.map((f) => ({ nom: f.name, taille: f.bytes.length, lien: `/ville/api/consultations/${t.id}/pieces/${encodeURIComponent(f.name)}` })),
  };
}

const APP_JS = `
const app = document.getElementById("app");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
async function list(page) {
  const r = await fetch("/ville/api/consultations?page=" + page + "&taille=${PAGE_SIZE}");
  const d = await r.json();
  const rows = d.resultats.map((c) =>
    '<article class="consultation"><h2><a href="/ville/consultation/' + c.id + '">' + esc(c.intitule) + '</a></h2>' +
    '<p class="ref">' + esc(c.reference) + ' · ' + esc(c.acheteur.nom) + '</p>' +
    '<p>Date limite : ' + esc(c.dateLimiteRemise) + (c.annulee ? ' · <strong>Annulée</strong>' : '') + '</p></article>').join("");
  const pages = Math.ceil(d.total / d.taille);
  const nav = Array.from({ length: pages }, (_, i) => '<button data-page="' + (i + 1) + '"' + (i + 1 === page ? ' aria-current="page"' : '') + '>' + (i + 1) + '</button>').join("");
  app.innerHTML = '<h1>Consultations en cours</h1>' + rows + '<nav class="pagination">' + nav + '</nav>';
  app.querySelectorAll("button[data-page]").forEach((b) => b.addEventListener("click", () => list(Number(b.dataset.page))));
}
async function detail(id) {
  const r = await fetch("/ville/api/consultations/" + id);
  if (!r.ok) { app.innerHTML = "<h1>Consultation introuvable</h1>"; return; }
  const c = await r.json();
  app.innerHTML = '<h1>' + esc(c.intitule) + '</h1>' + (c.annulee ? '<p class="annulee">Cette consultation a été annulée.</p>' : '') +
    '<ul class="infos"><li>Référence : ' + esc(c.reference) + '</li><li>Acheteur : ' + esc(c.acheteur.nom) + '</li>' +
    '<li>Procédure : ' + esc(c.procedure) + '</li><li>Nature : ' + esc(c.nature) + '</li>' +
    '<li>Codes CPV : ' + esc(c.codesCpv.join(", ")) + '</li><li>Lieu : ' + esc(c.lieuExecution.codePostal + " " + c.lieuExecution.ville) + '</li>' +
    '<li>Publiée le : ' + esc(c.datePublication) + '</li><li>Date limite de remise : ' + esc(c.dateLimiteRemise) + '</li></ul>' +
    '<p class="objet">' + esc(c.objet) + '</p><h2>Dossier de consultation (DCE)</h2><ul class="pieces">' +
    c.pieces.map((p) => '<li><a href="' + p.lien + '">' + esc(p.nom) + '</a></li>').join("") + '</ul>';
}
const m = location.pathname.match(/^\\/ville\\/consultation\\/([^/]+)$/);
if (m) detail(m[1]); else list(1);
`;

const SHELL = page(
  "Marchés publics | Ville de Rivemont",
  "fr",
  `<header><a href="/ville/">Ville de Rivemont · Marchés publics</a></header><main id="app"><noscript>Activez JavaScript pour consulter les marchés.</noscript></main><script src="/ville/app.js"></script>`,
);

export const ville: LabPortal = {
  slug: "ville",
  name: "Ville de Rivemont",
  country: "FR",
  timeZone: ZONE,
  kind: "JavaScript app over a JSON API, page-number pagination",
  notes: ["Consultation c-2026149 is cancelled ('annulee': true).", "dateLimiteRemise is Europe/Paris local time without offset."],
  tenders,
  tenderUrl: (base, t) => `${base}/ville/consultation/${t.id}`,

  handle(_req, res, path, url) {
    if (path === "/" || path === "" || /^\/consultation\/[^/]+$/.test(path)) return sendHtml(res, SHELL);
    if (path === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      return res.end(APP_JS);
    }
    if (path === "/api/consultations") {
      const size = Math.min(Math.max(1, Number(url.searchParams.get("taille") ?? PAGE_SIZE) || PAGE_SIZE), 50);
      const n = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
      return sendJson(res, { total: tenders.length, page: n, taille: size, resultats: tenders.slice((n - 1) * size, n * size).map(apiItem) });
    }
    const one = path.match(/^\/api\/consultations\/([^/]+)$/);
    if (one) {
      const t = tenders.find((x) => x.id === one[1]);
      return t ? sendJson(res, apiItem(t)) : sendJson(res, { erreur: "introuvable" }, 404);
    }
    const file = path.match(/^\/api\/consultations\/([^/]+)\/pieces\/([^/]+)$/);
    if (file) {
      const f = tenders.find((x) => x.id === file[1])?.files.find((x) => x.name === decodeURIComponent(file[2]!));
      return f ? sendFile(res, f.name, f.bytes) : notFound(res);
    }
    notFound(res);
  },
};
