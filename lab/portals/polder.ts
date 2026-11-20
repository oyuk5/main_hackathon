/**
 * Demo portal 4: Gemeente Polderwijk (NL). The municipality publishes its tenders as an RSS 2.0 feed.
 * The start page links the feed (also as <link rel="alternate">) and an HTML list; every feed item
 * links to an HTML detail page with the full data and the PDF documents.
 * Traps: feed tier, Dutch labels, Amsterdam local time ("05-12-2026 14:00"), RFC 822 pubDates with
 * offset, postal codes like "1471 AB", CPV with check digits, one withdrawn tender ("Ingetrokken").
 */
import { localWallTime } from "../../src/shared/time.js";
import { addDays, cookieBanner, esc, fakeFile, fakePdf, notFound, page, sendFile, sendHtml, today, type LabPortal, type LabTender } from "./common.js";
import type { ServerResponse } from "node:http";

const ZONE = "Europe/Amsterdam";
const BUYER = "Gemeente Polderwijk";

const ROWS: Array<[string, LabTender["contractNature"], LabTender["procedureType"], string[], string, string, string]> = [
  ["Reconstructie Dorpsstraat Oosterdijk", "works", "open", ["45233140-2"], "1473 KD", "Oosterdijk", "Herinrichting van de Dorpsstraat over 850 meter, inclusief riolering en nieuwe bestrating."],
  ["Onderhoud openbaar groen 2027-2030", "services", "open", ["77310000-6"], "1471 AB", "Polderwijk", "Maaien, snoeien en onderhoud van plantsoenen en bermen in de hele gemeente."],
  ["Levering elektrische dienstvoertuigen", "supplies", "open", ["34144900-7"], "1471 AB", "Polderwijk", "Levering van zes elektrische bestelwagens voor de buitendienst."],
  ["Schoonmaak gemeentelijke gebouwen", "services", "restricted", ["90910000-9"], "1471 AB", "Polderwijk", "Dagelijkse schoonmaak van het gemeentehuis, de bibliotheek en twee sporthallen."],
  ["Vervanging openbare verlichting Nieuwe Kade", "works", "open", ["45316110-9"], "1475 GR", "Nieuwe Kade", "Vervanging van 420 lichtmasten door LED-armaturen."],
  ["Gladheidsbestrijding winterseizoenen 2027-2029", "services", "open", ["90620000-9"], "1471 AB", "Polderwijk", "Strooien en sneeuwruimen op hoofdwegen, fietspaden en bij scholen."],
  ["Nieuwbouw brede school De Polderhoek", "works", "restricted", ["45212222-8"], "1474 MP", "Polderwijk", "Bouw van een brede school met gymzaal en kinderopvang."],
  ["Aanleg waterleiding bedrijventerrein Kadepark", "works", "open", ["45231300-8"], "1475 GR", "Nieuwe Kade", "Aanleg van 2,3 km waterleiding op het nieuwe bedrijventerrein."],
  ["Onderhoud verkeersregelinstallaties", "services", "negotiated", ["50232100-1"], "1471 AB", "Polderwijk", "Beheer en onderhoud van zeven verkeersregelinstallaties."],
  ["Levering en installatie speeltoestellen", "supplies", "open", ["39160000-1"], "1473 KD", "Oosterdijk", "Levering en plaatsing van speeltoestellen voor drie buurtspeelplaatsen."],
  ["Renovatie dak sporthal De Vaart", "works", "open", ["45453000-7"], "1474 MP", "Polderwijk", "Vervanging van de dakbedekking en isolatie van sporthal De Vaart."],
  ["Ontwikkeling zaaksysteem en burgerportaal", "services", "open", ["72224000-1", "72267000-4"], "1471 AB", "Polderwijk", "Implementatie en onderhoud van een zaaksysteem met een digitaal loket voor inwoners."],
];

const PROCEDURE = { open: "Openbare procedure", restricted: "Niet-openbare procedure", negotiated: "Onderhandelingsprocedure" } as const;
const NATURE = { works: "Werken", services: "Diensten", supplies: "Leveringen" } as const;
const WITHDRAWN = 5;

function build(): LabTender[] {
  const day = today(ZONE);
  return ROWS.map(([title, nature, procedure, cpv, postalCode, city, description], i) => {
    const id = String(26101 + i * 7);
    const ref = `PW-2026-${String(81 + i).padStart(3, "0")}`;
    const files = [
      { name: `Aankondiging_${ref}.pdf`, bytes: fakePdf(`Aankondiging opdracht ${ref} ${title}`) },
      { name: `Aanbestedingsleidraad_${ref}.pdf`, bytes: fakePdf(`Aanbestedingsleidraad ${ref} ${description}`) },
    ];
    if (i % 3 === 0) files.push({ name: `Inschrijvingsformulier_${ref}.docx`, bytes: fakeFile(`Inschrijvingsformulier ${ref}`) });
    return {
      id,
      referenceNumber: ref,
      title,
      buyerName: BUYER,
      publicationDate: addDays(day, -i),
      deadlineDate: addDays(day, 10 + i * 3),
      deadlineTime: i % 2 === 0 ? "14:00" : "10:00",
      description,
      procedureType: procedure,
      contractNature: nature,
      cpv,
      postalCode,
      city,
      withdrawn: i === WITHDRAWN,
      files,
    };
  });
}

const tenders = build();

const VARIANTS = {
  "feed-moved": "The feed moves from /aanbestedingen.rss to /feeds/aanbestedingen.xml; the old address answers 404 and the start page links the new one.",
  atom: "The feed at the same address switches from RSS 2.0 to Atom 1.0 (entry, link href, published, summary).",
  "renamed-classes": "Detail page markup renamed (dl.gegevens → table.kenmerken with th/td, p.omschrijving → div.toelichting, ul.documenten → ul.bijlagen, a.document → a.download).",
  "date-format": "Dates written as '5 december 2026' and deadlines as '5 december 2026, 14:00 uur' on detail pages and in the feed text, instead of '05-12-2026 14:00'.",
  "cookie-banner": "A cookie consent overlay on every HTML page. Data unchanged: must stay serving.",
  "empty-day": "The feed has no items and the list says 'Er zijn momenteel geen aanbestedingen.' Must stay serving, not broken.",
};

const MAANDEN = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 2026-12-05 → 05-12-2026 */
function dashed(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}-${m}-${y}`;
}
/** 2026-12-05 → 5 december 2026 */
function dutchLong(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${d} ${MAANDEN[m - 1]} ${y}`;
}
/** Publication moment (09:00 local) as RFC 822, e.g. "Sat, 21 Nov 2026 09:00:00 +0100". */
function rfc822(day: string): string {
  const iso = localWallTime(day, "09:00", ZONE);
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]}, ${String(d).padStart(2, "0")} ${MONTHS[m - 1]} ${y} 09:00:00 ${iso.slice(19).replace(":", "")}`;
}

function look(variant: string) {
  const long = variant === "date-format";
  const renamed = variant === "renamed-classes";
  return {
    feedPath: variant === "feed-moved" ? "/feeds/aanbestedingen.xml" : "/aanbestedingen.rss",
    atom: variant === "atom",
    renamed,
    date: (d: string) => (long ? dutchLong(d) : dashed(d)),
    deadline: (t: LabTender) => (long ? `${dutchLong(t.deadlineDate)}, ${t.deadlineTime} uur` : `${dashed(t.deadlineDate)} ${t.deadlineTime}`),
    banner: variant === "cookie-banner",
    empty: variant === "empty-day",
  };
}
type Look = ReturnType<typeof look>;

const detailPath = (t: LabTender) => `/polder/aanbesteding/${t.id}`;
const filePath = (t: LabTender, name: string) => `/polder/documenten/${t.id}/${encodeURIComponent(name)}`;
const status = (t: LabTender) => (t.withdrawn ? "Ingetrokken" : "Open");

function layout(l: Look, title: string, body: string): string {
  const banner = l.banner ? cookieBanner("Deze website gebruikt cookies om het gebruik te analyseren. Gaat u akkoord?", "Accepteren") : "";
  const type = l.atom ? "application/atom+xml" : "application/rss+xml";
  return page(
    `${title} | ${BUYER}`,
    "nl",
    `${banner}<header class="kop"><a href="/polder/">${BUYER}</a> · <a href="/polder/aanbestedingen">Aanbestedingen</a> · <a href="/polder${l.feedPath}">RSS</a></header>` +
      `<main>${body}</main><footer>Gemeentehuis Polderwijk, Raadhuisplein 1, 1471 AB Polderwijk</footer>`,
    `<link rel="alternate" type="${type}" title="Aanbestedingen ${BUYER}" href="/polder${l.feedPath}">`,
  );
}

/** Plain-text summary used in the feed (as escaped HTML in RSS, as text in Atom). */
function feedText(l: Look, t: LabTender): string {
  return (
    `${t.description} Referentie: ${t.referenceNumber}. Procedure: ${PROCEDURE[t.procedureType]}. ` +
    `Sluitingsdatum: ${l.deadline(t)}.${t.withdrawn ? " Status: Ingetrokken." : ""}`
  );
}

function rss(l: Look, base: string, list: LabTender[]): string {
  const items = list
    .map(
      (t) =>
        `<item><title>${esc(t.title)}</title><link>${base}${detailPath(t)}</link><guid isPermaLink="false">polderwijk-${t.id}</guid>` +
        `<pubDate>${rfc822(t.publicationDate)}</pubDate><category>${NATURE[t.contractNature]}</category>` +
        (t.withdrawn ? `<category>Ingetrokken</category>` : "") +
        `<description>${esc(`<p>${esc(feedText(l, t))}</p>`)}</description>` +
        `<enclosure url="${base}${filePath(t, t.files[0]!.name)}" length="${t.files[0]!.bytes.length}" type="application/pdf"/></item>`,
    )
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>` +
    `<title>Aanbestedingen ${BUYER}</title><link>${base}/polder/aanbestedingen</link>` +
    `<atom:link href="${base}/polder${l.feedPath}" rel="self" type="application/rss+xml"/>` +
    `<description>Actuele aanbestedingen en opdrachten van de ${BUYER}</description><language>nl-nl</language>\n${items}\n</channel></rss>\n`
  );
}

function atom(l: Look, base: string, list: LabTender[]): string {
  const stamp = (d: string) => localWallTime(d, "09:00", ZONE);
  const updated = stamp(list[0]?.publicationDate ?? today(ZONE));
  const entries = list
    .map(
      (t) =>
        `<entry><title>${esc(t.title)}</title><link rel="alternate" type="text/html" href="${base}${detailPath(t)}"/>` +
        `<id>urn:polderwijk:aanbesteding:${t.id}</id><published>${stamp(t.publicationDate)}</published><updated>${stamp(t.publicationDate)}</updated>` +
        `<category term="${NATURE[t.contractNature]}"/>${t.withdrawn ? `<category term="Ingetrokken"/>` : ""}` +
        `<summary type="text">${esc(feedText(l, t))}</summary></entry>`,
    )
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="nl">` +
    `<title>Aanbestedingen ${BUYER}</title><id>urn:polderwijk:aanbestedingen</id><updated>${updated}</updated>` +
    `<link rel="self" type="application/atom+xml" href="${base}/polder${l.feedPath}"/><link rel="alternate" type="text/html" href="${base}/polder/aanbestedingen"/>` +
    `<author><name>${BUYER}</name></author>\n${entries}\n</feed>\n`
  );
}

function sendXml(res: ServerResponse, type: string, xml: string): void {
  res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
  res.end(xml);
}

function detail(l: Look, t: LabTender): string {
  const rows: Array<[string, string]> = [
    ["Referentienummer", t.referenceNumber],
    ["Aanbestedende dienst", t.buyerName],
    ["Procedure", PROCEDURE[t.procedureType]],
    ["Type opdracht", NATURE[t.contractNature]],
    ["CPV-code", t.cpv.join(", ")],
    ["Plaats van uitvoering", `${t.postalCode} ${t.city}`],
    ["Publicatiedatum", l.date(t.publicationDate)],
    ["Sluitingsdatum inschrijving", l.deadline(t)],
    ["Status", status(t)],
  ];
  const facts = l.renamed
    ? `<table class="kenmerken">${rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${esc(v)}</td></tr>`).join("")}</table>`
    : `<dl class="gegevens">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  const docClass = l.renamed ? "download" : "document";
  const docs = t.files.map((f) => `<li><a class="${docClass}" href="${filePath(t, f.name)}">${esc(f.name)}</a> (${Math.max(1, Math.round(f.bytes.length / 1024))} kB)</li>`).join("");
  const notice = t.withdrawn ? `<p class="${l.renamed ? "melding" : "waarschuwing"}">Deze aanbesteding is ingetrokken.</p>` : "";
  const about = l.renamed ? `<div class="toelichting">${esc(t.description)}</div>` : `<p class="omschrijving">${esc(t.description)}</p>`;
  return (
    `<h1>${esc(t.title)}</h1>${notice}${facts}<h2>Omschrijving</h2>${about}` +
    `<h2>Documenten</h2><ul class="${l.renamed ? "bijlagen" : "documenten"}">${docs}</ul>`
  );
}

export const polder: LabPortal = {
  slug: "polder",
  name: BUYER,
  country: "NL",
  timeZone: ZONE,
  kind: "RSS/Atom feed with HTML detail pages",
  notes: [
    `Tender ${tenders[WITHDRAWN]!.id} is withdrawn (Status 'Ingetrokken', category 'Ingetrokken' in the feed).`,
    "The feed has title, link, pubDate and a text summary; buyer, CPV, place, procedure and documents are only on the detail pages.",
    "Deadlines are Europe/Amsterdam local time without offset ('05-12-2026 14:00').",
  ],
  tenders,
  variants: VARIANTS,
  tenderUrl: (base, t) => `${base}${detailPath(t)}`,

  handle(_req, res, path, _url, ctx) {
    const l = look(ctx.variant);
    const list = l.empty ? [] : tenders;
    if (path === "/" || path === "") {
      return sendHtml(
        res,
        layout(
          l,
          "Aanbestedingen",
          `<h1>Aanbestedingen van de ${BUYER}</h1><p>De gemeente publiceert haar opdrachten via een RSS-feed en op deze website.</p>` +
            `<ul class="ingangen"><li><a href="/polder/aanbestedingen">Bekijk alle actuele aanbestedingen</a></li>` +
            `<li><a class="feed" href="/polder${l.feedPath}">Abonneer op de RSS-feed met aanbestedingen</a></li></ul>`,
        ),
      );
    }
    if (path === l.feedPath) {
      return l.atom ? sendXml(res, "application/atom+xml", atom(l, ctx.base, list)) : sendXml(res, "application/rss+xml", rss(l, ctx.base, list));
    }
    if (path === "/aanbestedingen") {
      if (list.length === 0) return sendHtml(res, layout(l, "Aanbestedingen", `<h1>Actuele aanbestedingen</h1><p class="leeg">Er zijn momenteel geen aanbestedingen.</p>`));
      const rows = list
        .map(
          (t) =>
            `<tr><td><a href="${detailPath(t)}">${esc(t.title)}</a></td><td>${esc(t.referenceNumber)}</td>` +
            `<td>${l.date(t.publicationDate)}</td><td>${l.deadline(t)}</td><td>${status(t)}</td></tr>`,
        )
        .join("");
      return sendHtml(
        res,
        layout(
          l,
          "Aanbestedingen",
          `<h1>Actuele aanbestedingen</h1><table class="overzicht"><thead><tr><th>Opdracht</th><th>Referentie</th><th>Gepubliceerd</th><th>Sluitingsdatum</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`,
        ),
      );
    }
    const d = path.match(/^\/aanbesteding\/(\d+)$/);
    if (d) {
      const t = list.find((x) => x.id === d[1]);
      return t ? sendHtml(res, layout(l, t.title, detail(l, t))) : notFound(res);
    }
    const f = path.match(/^\/documenten\/(\d+)\/([^/]+)$/);
    if (f) {
      const t = list.find((x) => x.id === f[1]);
      const name = decodeURIComponent(f[2]!);
      const file = t?.files.find((x) => x.name === name);
      return file ? sendFile(res, file.name, file.bytes) : notFound(res);
    }
    notFound(res);
  },
};
