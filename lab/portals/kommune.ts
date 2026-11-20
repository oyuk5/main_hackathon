/**
 * Demo portal: Fjordby Kommune (DK, fictional). A server-rendered table of tenders with numbered
 * pagination (?side=N), an HTML detail page per tender with one PDF (the tender notice) and one ZIP
 * ("Udbudsmateriale") whose members sit in folders (01 Udbudsbetingelser/..., 02 Bilag/...).
 * Traps: ZIP members in (nested) folders, Danish labels, deadlines as "05.12.2026 kl. 12:00" in
 * Copenhagen time, 4-digit postal codes, CPV with check digits, one cancelled tender ("Annulleret").
 */
import { addDays, cookieBanner, dotted, esc, fakeFile, fakePdf, notFound, page, sendFile, sendHtml, today, zipBytes, type LabFile, type LabPortal, type LabTender } from "./common.js";

const ZONE = "Europe/Copenhagen";
const PER_PAGE = 5;
const BUYER = "Fjordby Kommune";

type Row = [title: string, nature: LabTender["contractNature"], procedure: LabTender["procedureType"], cpv: string[], postalCode: string, city: string, description: string];

const ROWS: Row[] = [
  ["Renovering af tag på Fjordby Skole", "works", "open", ["45453000-7", "45212222-8"], "6990", "Fjordby", "Udskiftning af tagbelægning og efterisolering af tag på Fjordby Skoles hovedbygning."],
  ["Levering af fødevarer til kommunens plejecentre", "supplies", "open", ["15894210-6"], "6990", "Fjordby", "Rammeaftale om levering af fødevarer til tre plejecentre i perioden 2027-2029."],
  ["Vintertjeneste på kommunale veje", "services", "open", ["90620000-9"], "6993", "Egvig", "Snerydning og glatførebekæmpelse på kommunale veje i Egvig-distriktet."],
  ["Rengøring af kommunale bygninger", "services", "restricted", ["90910000-9"], "6990", "Fjordby", "Daglig rengøring af rådhus, biblioteker og administrationsbygninger, ca. 18.000 m²."],
  ["Etablering af cykelsti langs Fjordvejen", "works", "open", ["45233140-2"], "6996", "Lundhede", "Anlæg af 3,2 km dobbeltrettet cykelsti med belysning mellem Fjordby og Lundhede."],
  ["Levering af it-udstyr til skolerne", "supplies", "open", ["30213100-6"], "6990", "Fjordby", "Levering af 400 bærbare computere og 60 skærme til kommunens folkeskoler."],
  ["Kloakseparering i Egvig by", "works", "negotiated", ["45232150-8", "45231300-8"], "6993", "Egvig", "Separering af fælleskloak til regn- og spildevand i Egvig bymidte, etape 2."],
  ["Drift og pleje af grønne områder", "services", "open", ["77310000-6"], "6990", "Fjordby", "Græsslåning, beskæring og renholdelse af parker og grønne områder 2027-2030."],
  ["Levering af elbiler til hjemmeplejen", "supplies", "open", ["34144900-7"], "6990", "Fjordby", "Levering af 25 elbiler til hjemmeplejen inklusive service i fire år."],
  ["Totalrådgivning ved ny daginstitution", "services", "restricted", ["71000000-8"], "6996", "Lundhede", "Totalrådgivning fra projektering til aflevering af ny daginstitution til 120 børn."],
  ["Energirenovering af Lundhede Hallen", "works", "open", ["45321000-3"], "6996", "Lundhede", "Udskiftning af vinduer, ventilation og belysning i Lundhede Hallen."],
  ["Kørsel af skolebørn", "services", "open", ["60130000-8"], "6990", "Fjordby", "Kørsel af skolebørn til og fra kommunens skoler i skoleårene 2027/28-2029/30."],
];

/** Tender index that is cancelled ("Annulleret") on the portal. */
const WITHDRAWN = new Set([6]);

const UDBUDSFORM = { open: "Offentligt udbud", restricted: "Begrænset udbud", negotiated: "Udbud med forhandling" } as const;
const KONTRAKTTYPE = { works: "Bygge- og anlægsarbejder", services: "Tjenesteydelser", supplies: "Varer" } as const;
const MONTHS_DA = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];

/** 2026-12-05 → "5. december 2026" */
function longDa(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${d}. ${MONTHS_DA[m - 1]} ${y}`;
}

function zipMembers(ref: string, title: string, nature: LabTender["contractNature"], i: number): LabFile[] {
  const m: LabFile[] = [
    { name: "01 Udbudsbetingelser/Udbudsbetingelser.pdf", bytes: fakePdf(`Udbudsbetingelser ${ref} ${title}`) },
    { name: "02 Bilag/Bilag 1 Kravspecifikation.pdf", bytes: fakePdf(`Bilag 1 Kravspecifikation ${ref}`) },
    { name: "02 Bilag/Tilbudsliste.xlsx", bytes: fakeFile(`Tilbudsliste ${ref}`) },
  ];
  // Works tenders carry drawings one folder deeper; every third tender has a draft contract.
  if (nature === "works") m.push({ name: "02 Bilag/Tegninger/Situationsplan.pdf", bytes: fakePdf(`Situationsplan ${ref}`) });
  if (i % 3 === 0) m.push({ name: "03 Kontrakt/Kontraktudkast.pdf", bytes: fakePdf(`Kontraktudkast ${ref}`) });
  return m;
}

function build(): LabTender[] {
  const day = today(ZONE);
  return ROWS.map(([title, nature, procedure, cpv, postalCode, city, description], i) => {
    const ref = `FK-2026-${String(412 + i * 3).padStart(4, "0")}`;
    return {
      id: String(70310 + i * 13),
      referenceNumber: ref,
      title,
      buyerName: BUYER,
      publicationDate: addDays(day, -i),
      deadlineDate: addDays(day, 10 + i * 2),
      deadlineTime: i % 4 === 3 ? "10:00" : "12:00",
      description,
      procedureType: procedure,
      contractNature: nature,
      cpv,
      postalCode,
      city,
      withdrawn: WITHDRAWN.has(i),
      files: [{ name: `Udbudsbekendtgoerelse_${ref}.pdf`, bytes: fakePdf(`Udbudsbekendtgoerelse ${ref} ${title}`) }],
      zip: { name: `Udbudsmateriale_${ref}.zip`, members: zipMembers(ref, title, nature, i) },
    };
  });
}

const tenders = build();

const VARIANTS = {
  "renamed-classes": "CSS classes renamed (table.udbudsliste → table.tender-oversigt, table.detaljer → dl.stamdata, ul.dokumenter → div.filer, a.fil → a.download, nav.sider → nav.paginering).",
  "new-pagination": "Numbered pages (?side=N) replaced by a single 'Vis flere' link with an offset parameter (?fra=5, ?fra=10); ?side is ignored.",
  "moved-documents": "Document links leave the detail page and move to a separate page per tender, /kommune/udbud/{id}/dokumenter, linked as 'Dokumenter'.",
  "date-format": "Dates as '5. december 2026' and deadlines as '5. december 2026 kl. 12.00' instead of '05.12.2026 kl. 12:00'.",
  "cookie-banner": "A cookie consent overlay on every page. Data unchanged: must stay serving.",
  "empty-day": "No tenders today; the list says 'Der er ingen aktuelle udbud.'. Must stay serving, not broken.",
};

function look(variant: string) {
  const renamed = variant === "renamed-classes";
  const longFmt = variant === "date-format";
  return {
    renamed,
    list: renamed ? "tender-oversigt" : "udbudsliste",
    docs: renamed ? "filer" : "dokumenter",
    file: renamed ? "download" : "fil",
    nav: renamed ? "paginering" : "sider",
    offset: variant === "new-pagination",
    movedDocs: variant === "moved-documents",
    date: (d: string) => (longFmt ? longDa(d) : dotted(d)),
    deadline: (t: LabTender) => (longFmt ? `${longDa(t.deadlineDate)} kl. ${t.deadlineTime.replace(":", ".")}` : `${dotted(t.deadlineDate)} kl. ${t.deadlineTime}`),
    banner: variant === "cookie-banner",
    empty: variant === "empty-day",
  };
}
type Look = ReturnType<typeof look>;

function layout(l: Look, title: string, body: string): string {
  const banner = l.banner ? cookieBanner("Fjordby Kommune bruger cookies til statistik og til at huske dine valg. Læs mere i vores cookiepolitik.", "Accepter alle") : "";
  return page(
    `${title} | Fjordby Kommune`,
    "da",
    `${banner}<header class="topbar"><a href="/kommune/">Fjordby Kommune</a> · <a href="/kommune/udbud">Udbud</a></header>` +
      `<main>${body}</main><footer>Fjordby Kommune · Torvet 1 · 6990 Fjordby · CVR 00000000</footer>`,
  );
}

const status = (t: LabTender) => (t.withdrawn ? "Annulleret" : "Aktiv");

function fileList(l: Look, t: LabTender): string {
  const href = (name: string) => `/kommune/filer/${t.id}/${encodeURIComponent(name)}`;
  const items = t.files.map((f) => `<li><a class="${l.file}" href="${href(f.name)}">Udbudsbekendtgørelse (PDF)</a> <span class="str">${f.bytes.length} bytes</span></li>`);
  if (t.zip) items.push(`<li><a class="${l.file}" href="${href(t.zip.name)}">Udbudsmateriale (ZIP)</a> <span class="str">${esc(t.zip.name)}</span></li>`);
  return l.renamed ? `<div class="${l.docs}">${items.map((x) => x.replace(/^<li>|<\/li>$/g, "")).join("<br>")}</div>` : `<ul class="${l.docs}">${items.join("")}</ul>`;
}

export const kommune: LabPortal = {
  slug: "kommune",
  name: "Fjordby Kommune",
  country: "DK",
  timeZone: ZONE,
  kind: "server-rendered table, ZIP with folders plus one PDF per tender",
  notes: [
    "Each detail page links one PDF (Udbudsbekendtgørelse) and one ZIP (Udbudsmateriale); the truth lists the PDF plus every unpacked ZIP member.",
    "ZIP members sit in folders (01 Udbudsbetingelser/, 02 Bilag/, 02 Bilag/Tegninger/, 03 Kontrakt/); the truth's fileName keeps that path, documents match by sha256.",
    "One tender is cancelled: status 'Annulleret' in the list and on its page.",
  ],
  tenders,
  variants: VARIANTS,
  tenderUrl: (base, t) => `${base}/kommune/udbud/${t.id}`,

  handle(_req, res, path, url, ctx) {
    const l = look(ctx.variant);
    const list = l.empty ? [] : tenders;
    if (path === "/" || path === "") {
      return sendHtml(
        res,
        layout(l, "Forside", `<h1>Udbud og indkøb i Fjordby Kommune</h1><p>Her finder du kommunens aktuelle udbud.</p><p><a class="cta" href="/kommune/udbud">Se aktuelle udbud</a></p>`),
      );
    }
    if (path === "/udbud") {
      if (list.length === 0) return sendHtml(res, layout(l, "Aktuelle udbud", `<h1>Aktuelle udbud</h1><p class="ingen">Der er ingen aktuelle udbud.</p>`));
      const self = "/kommune/udbud";
      let start: number;
      let nav: string;
      if (l.offset) {
        start = Math.min(Math.max(0, Number(url.searchParams.get("fra") ?? 0) || 0), list.length - 1);
        const end = Math.min(start + PER_PAGE, list.length);
        const more = end < list.length ? `<a class="vis-flere" href="${self}?fra=${end}">Vis flere</a>` : "";
        nav = `<p class="antal">Viser ${start + 1}-${end} af ${list.length} udbud</p>${more}`;
      } else {
        const pages = Math.ceil(list.length / PER_PAGE);
        const n = Math.min(Math.max(1, Number(url.searchParams.get("side") ?? 1) || 1), pages);
        start = (n - 1) * PER_PAGE;
        const links = Array.from({ length: pages }, (_, i) => (i + 1 === n ? `<span class="aktiv">${i + 1}</span>` : `<a href="${self}?side=${i + 1}">${i + 1}</a>`)).join(" ");
        nav = `${n > 1 ? `<a rel="prev" href="${self}?side=${n - 1}">‹ Forrige</a> ` : ""}${links}${n < pages ? ` <a rel="next" class="naeste" href="${self}?side=${n + 1}">Næste ›</a>` : ""}`;
      }
      const rows = list
        .slice(start, start + PER_PAGE)
        .map(
          (t) =>
            `<tr${t.withdrawn ? ' class="annulleret"' : ""}><td><a href="/kommune/udbud/${t.id}">${esc(t.title)}</a></td><td>${esc(t.referenceNumber)}</td>` +
            `<td>${UDBUDSFORM[t.procedureType]}</td><td>${l.date(t.publicationDate)}</td><td>${l.deadline(t)}</td><td>${status(t)}</td></tr>`,
        )
        .join("");
      return sendHtml(
        res,
        layout(
          l,
          "Aktuelle udbud",
          `<h1>Aktuelle udbud</h1><table class="${l.list}"><thead><tr><th>Titel</th><th>Udbudsnr.</th><th>Udbudsform</th><th>Offentliggjort</th><th>Tilbudsfrist</th><th>Status</th></tr></thead>` +
            `<tbody>${rows}</tbody></table><nav class="${l.nav}">${nav}</nav>`,
        ),
      );
    }
    const detail = path.match(/^\/udbud\/(\d+)$/);
    if (detail) {
      const t = list.find((x) => x.id === detail[1]);
      if (!t) return notFound(res);
      const fields: Array<[string, string]> = [
        ["Udbudsnummer", t.referenceNumber],
        ["Ordregiver", t.buyerName],
        ["Udbudsform", UDBUDSFORM[t.procedureType]],
        ["Kontrakttype", KONTRAKTTYPE[t.contractNature]],
        ["CPV-kode", t.cpv.join(", ")],
        ["Leveringssted", `${t.postalCode} ${t.city}`],
        ["Offentliggjort", l.date(t.publicationDate)],
        ["Tilbudsfrist", l.deadline(t)],
        ["Status", status(t)],
      ];
      const facts = l.renamed
        ? `<dl class="stamdata">${fields.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`
        : `<table class="detaljer">${fields.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
      const cancelled = t.withdrawn ? `<p class="advarsel"><strong>Udbuddet er annulleret.</strong> Ordregiver har annulleret udbuddet, og der kan ikke længere afgives tilbud.</p>` : "";
      const docs = l.movedDocs
        ? `<p><a class="dokumentside" href="/kommune/udbud/${t.id}/dokumenter">Dokumenter</a></p>`
        : `<h2>Udbudsdokumenter</h2>${fileList(l, t)}`;
      return sendHtml(res, layout(l, t.title, `<h1>${esc(t.title)}</h1>${cancelled}${facts}<h2>Beskrivelse</h2><p class="beskrivelse">${esc(t.description)}</p>${docs}`));
    }
    const docPage = path.match(/^\/udbud\/(\d+)\/dokumenter$/);
    if (docPage && l.movedDocs) {
      const t = list.find((x) => x.id === docPage[1]);
      if (!t) return notFound(res);
      return sendHtml(
        res,
        layout(l, `Dokumenter: ${t.title}`, `<h1>Dokumenter</h1><p>${esc(t.referenceNumber)}: <a href="/kommune/udbud/${t.id}">${esc(t.title)}</a></p>${fileList(l, t)}`),
      );
    }
    const file = path.match(/^\/filer\/(\d+)\/([^/]+)$/);
    if (file) {
      const t = list.find((x) => x.id === file[1]);
      const name = file[2]!;
      if (t?.zip && t.zip.name === name) return sendFile(res, name, zipBytes(t));
      const f = t?.files.find((x) => x.name === name);
      return f ? sendFile(res, f.name, f.bytes) : notFound(res);
    }
    notFound(res);
  },
};
