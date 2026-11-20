/**
 * Demo portal 1: Stadtwerke Lindenau (DE). Server-rendered HTML table, "Weiter" link pagination,
 * a detail page per tender with labelled fields and direct PDF links.
 * Traps: German date format with local time, CPV with check digits, one withdrawn tender
 * ("Aufgehoben"), list on a sub-page of the start page.
 */
import { addDays, dotted, esc, fakeFile, fakePdf, notFound, page, sendFile, sendHtml, today, type LabPortal, type LabTender } from "./common.js";

const ZONE = "Europe/Berlin";
const PER_PAGE = 10;

const ROWS: Array<[string, LabTender["contractNature"], LabTender["procedureType"], string[], string, string, string]> = [
  ["Erneuerung Trinkwasserleitung Nordring", "works", "open", ["45231300-8"], "34117", "Kassel", "Erneuerung von 1,2 km Trinkwasserleitung DN 200 einschließlich Hausanschlüssen."],
  ["Wartung Blockheizkraftwerk Süd", "services", "open", ["50532000-3"], "34119", "Kassel", "Wartung und Instandhaltung von zwei BHKW-Modulen für drei Jahre."],
  ["Lieferung Glasfaserkabel Los 2", "supplies", "open", ["32562000-0"], "34121", "Kassel", "Lieferung von 40 km Glasfaserkabel für den Breitbandausbau."],
  ["Winterdienst Betriebshof", "services", "restricted", ["90620000-9"], "34123", "Kassel", "Räum- und Streudienst auf den Flächen des Betriebshofs, Saison 2026/27."],
  ["Sanierung Hochbehälter Am Weinberg", "works", "open", ["45252127-4"], "34128", "Kassel", "Betonsanierung und Innenbeschichtung des Hochbehälters."],
  ["Rahmenvertrag Arbeitsschutzkleidung", "supplies", "open", ["18100000-0"], "34117", "Kassel", "Rahmenvertrag über Arbeitsschutzkleidung für 250 Beschäftigte."],
  ["Gebäudereinigung Verwaltung", "services", "negotiated", ["90910000-9"], "34117", "Kassel", "Unterhalts- und Glasreinigung im Verwaltungsgebäude."],
  ["Neubau Pumpwerk Fuldaaue", "works", "open", ["45232150-8"], "34125", "Kassel", "Neubau eines Abwasserpumpwerks mit Druckleitung."],
  ["Lieferung Wasserzähler", "supplies", "open", ["38421100-3"], "34117", "Kassel", "Lieferung von 3.000 Ultraschall-Wasserzählern mit Funkmodul."],
  ["Softwarepflege Netzleitsystem", "services", "negotiated", ["72267000-4"], "34117", "Kassel", "Pflege und Weiterentwicklung des Netzleitsystems für vier Jahre."],
  ["Straßenbeleuchtung LED-Umrüstung", "works", "open", ["45316110-9"], "34132", "Kassel", "Umrüstung von 1.800 Leuchten auf LED-Technik."],
  ["Fahrzeugbeschaffung Elektro-Transporter", "supplies", "restricted", ["34144900-7"], "34117", "Kassel", "Beschaffung von sechs elektrischen Transportern."],
  ["Gutachten Netzstrukturplanung", "services", "open", ["71241000-9"], "34117", "Kassel", "Gutachten zur Zielnetzplanung Strom bis 2040."],
  ["Tiefbau Fernwärme Bauabschnitt 3", "works", "open", ["45232140-5"], "34127", "Kassel", "Tiefbauarbeiten für 900 m Fernwärmetrasse."],
];

const VERFAHREN = { open: "Offenes Verfahren", restricted: "Beschränkte Ausschreibung", negotiated: "Verhandlungsverfahren" } as const;
const ART = { works: "Bauleistung", services: "Dienstleistung", supplies: "Lieferleistung" } as const;

function build(): LabTender[] {
  const day = today(ZONE);
  return ROWS.map(([title, nature, procedure, cpv, postalCode, city, description], i) => {
    const id = String(4711 + i * 7);
    const ref = `SWL-2026-${String(31 + i).padStart(4, "0")}`;
    const files = [
      { name: `Bekanntmachung_${ref}.pdf`, bytes: fakePdf(`Bekanntmachung ${ref} ${title}`) },
      { name: `Leistungsbeschreibung_${ref}.pdf`, bytes: fakePdf(`Leistungsbeschreibung ${ref} ${description}`) },
    ];
    if (i % 3 === 0) files.push({ name: `Preisblatt_${ref}.xlsx`, bytes: fakeFile(`Preisblatt ${ref}`) });
    return {
      id,
      referenceNumber: ref,
      title,
      buyerName: "Stadtwerke Lindenau GmbH",
      publicationDate: addDays(day, -(i + 1)),
      deadlineDate: addDays(day, 9 + i * 2),
      deadlineTime: i % 2 === 0 ? "10:00" : "14:30",
      description,
      procedureType: procedure,
      contractNature: nature,
      cpv,
      postalCode,
      city,
      withdrawn: i === 6,
      files,
    };
  });
}

const tenders = build();

function layout(title: string, body: string): string {
  return page(
    `${title} | Stadtwerke Lindenau`,
    "de",
    `<header><a href="/stadtwerke/">Stadtwerke Lindenau</a> · <a href="/stadtwerke/ausschreibungen">Ausschreibungen</a></header><main>${body}</main>` +
      `<footer>Vergabestelle der Stadtwerke Lindenau GmbH · Impressum</footer>`,
  );
}

export const stadtwerke: LabPortal = {
  slug: "stadtwerke",
  name: "Stadtwerke Lindenau",
  country: "DE",
  timeZone: ZONE,
  kind: "html table, next-link pagination, detail pages, direct PDF links",
  notes: ["Tender 4753 is withdrawn (Status 'Aufgehoben').", "Deadlines are Europe/Berlin local time without offset."],
  tenders,
  tenderUrl: (base, t) => `${base}/stadtwerke/ausschreibung/${t.id}`,

  handle(_req, res, path, url) {
    if (path === "/" || path === "") {
      return sendHtml(
        res,
        layout("Start", `<h1>Vergabeplattform der Stadtwerke Lindenau</h1><p>Hier veröffentlichen wir unsere laufenden Vergabeverfahren.</p><p><a href="/stadtwerke/ausschreibungen">Aktuelle Ausschreibungen</a></p>`),
      );
    }
    if (path === "/ausschreibungen") {
      const pages = Math.ceil(tenders.length / PER_PAGE);
      const n = Math.min(Math.max(1, Number(url.searchParams.get("seite") ?? 1) || 1), pages);
      const rows = tenders
        .slice((n - 1) * PER_PAGE, n * PER_PAGE)
        .map(
          (t) =>
            `<tr><td>${esc(t.referenceNumber)}</td><td><a href="/stadtwerke/ausschreibung/${t.id}">${esc(t.title)}</a></td><td>${esc(t.buyerName)}</td>` +
            `<td>${dotted(t.publicationDate)}</td><td>${dotted(t.deadlineDate)} ${t.deadlineTime}</td><td>${t.withdrawn ? "Aufgehoben" : "Offen"}</td></tr>`,
        )
        .join("");
      const next = n < pages ? `<a class="next" href="/stadtwerke/ausschreibungen?seite=${n + 1}">Weiter »</a>` : "";
      const prev = n > 1 ? `<a class="prev" href="/stadtwerke/ausschreibungen?seite=${n - 1}">« Zurück</a>` : "";
      return sendHtml(
        res,
        layout(
          "Ausschreibungen",
          `<h1>Aktuelle Ausschreibungen</h1><table class="tenders"><thead><tr><th>Vergabenummer</th><th>Titel</th><th>Vergabestelle</th><th>Veröffentlicht</th><th>Angebotsfrist</th><th>Status</th></tr></thead>` +
            `<tbody>${rows}</tbody></table><nav class="pager">${prev} Seite ${n} von ${pages} ${next}</nav>`,
        ),
      );
    }
    const detail = path.match(/^\/ausschreibung\/(\d+)$/);
    if (detail) {
      const t = tenders.find((x) => x.id === detail[1]);
      if (!t) return notFound(res);
      const files = t.files.map((f) => `<li><a href="/stadtwerke/dokumente/${t.id}/${encodeURIComponent(f.name)}">${esc(f.name)}</a></li>`).join("");
      const dl: Array<[string, string]> = [
        ["Vergabenummer", t.referenceNumber],
        ["Auftraggeber", t.buyerName],
        ["Veröffentlicht am", dotted(t.publicationDate)],
        ["Angebotsfrist", `${dotted(t.deadlineDate)}, ${t.deadlineTime} Uhr`],
        ["Verfahrensart", VERFAHREN[t.procedureType]],
        ["Art des Auftrags", ART[t.contractNature]],
        ["CPV-Code", t.cpv.join(", ")],
        ["Ausführungsort", `${t.postalCode} ${t.city}`],
        ["Status", t.withdrawn ? "Aufgehoben" : "Offen"],
      ];
      return sendHtml(
        res,
        layout(
          t.title,
          `<h1>${esc(t.title)}</h1>${t.withdrawn ? `<p class="hinweis">Dieses Verfahren wurde aufgehoben.</p>` : ""}` +
            `<dl class="details">${dl.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` +
            `<h2>Beschreibung</h2><p class="beschreibung">${esc(t.description)}</p>` +
            `<h2>Vergabeunterlagen</h2><ul class="unterlagen">${files}</ul>`,
        ),
      );
    }
    const file = path.match(/^\/dokumente\/(\d+)\/([^/]+)$/);
    if (file) {
      const t = tenders.find((x) => x.id === file[1]);
      const f = t?.files.find((x) => x.name === decodeURIComponent(file[2]!));
      if (!f) return notFound(res);
      return sendFile(res, f.name, f.bytes);
    }
    notFound(res);
  },
};
