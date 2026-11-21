/**
 * Demo portal 1: Stadtwerke Lindenau (DE). Server-rendered HTML table, "Weiter" link pagination,
 * a detail page per tender with labelled fields and direct PDF links.
 * Traps: German date format with local time, CPV with check digits, one withdrawn tender
 * ("Aufgehoben"), list on a sub-page of the start page.
 */
import { addDays, cookieBanner, dotted, esc, fakeFile, fakePdf, longDate, notFound, page, sendFile, sendHtml, today, type LabPortal, type LabTender } from "./common.js";

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
/** The "cancelled" variant: the buyer cancels the first tender, which was open. */
const cancelled = tenders.map((t, i) => (i === 0 ? { ...t, withdrawn: true } : t));
const tendersFor = (variant: string) => (variant === "cancelled" ? cancelled : tenders);

/** Detail labels as the original shows them, and as the "renamed-labels" variant does. */
const LABELS = {
  ref: "Vergabenummer", buyer: "Auftraggeber", published: "Veröffentlicht am", deadline: "Angebotsfrist",
  procedure: "Verfahrensart", nature: "Art des Auftrags", cpv: "CPV-Code", place: "Ausführungsort", status: "Status",
};
const RENAMED_LABELS: typeof LABELS = {
  ref: "Aktenzeichen", buyer: "Öffentlicher Auftraggeber", published: "Datum der Veröffentlichung", deadline: "Ablauf der Angebotsfrist",
  procedure: "Vergabeverfahren", nature: "Auftragsart", cpv: "CPV-Codes", place: "Erfüllungsort", status: "Verfahrensstand",
};

const VARIANTS = {
  "renamed-classes": "CSS classes renamed (table.tenders → table.vergabeliste, dl.details → dl.angaben, ul.unterlagen → ul.dokumente, a.next → a.weiter).",
  "moved-list": "The list moves from /ausschreibungen to /vergabe/aktuell; the old address answers 404.",
  "new-pagination": "Next link removed; numbered pages with ?page=N and 5 tenders per page.",
  "date-format": "Dates shown as '5. Dezember 2026, 10:00 Uhr' instead of '05.12.2026 10:00'.",
  "cookie-banner": "A cookie consent overlay on every page. Data unchanged: must stay serving.",
  "empty-day": "No tenders today; the list says so. Must stay serving, not broken.",
  "redirect-list": "The list moves from /ausschreibungen to /vergabe/aktuell and the old address answers 301 to the new one. Data unchanged: must stay serving.",
  "reordered-columns": "The list table's columns come in a new order (Titel, Angebotsfrist, Status, Vergabenummer, Veröffentlicht, Vergabestelle).",
  "renamed-labels": "The detail page's labels are renamed (Angebotsfrist → Ablauf der Angebotsfrist, Verfahrensart → Vergabeverfahren, Auftraggeber → Öffentlicher Auftraggeber, ...).",
  cancelled: "The buyer cancels tender 4711: list and detail page say 'Aufgehoben'. Must stay serving and show it as withdrawn, without a repair.",
};

interface Look {
  table: string;
  next: string;
  dl: string;
  docs: string;
  listPath: string;
  pageParam: string;
  perPage: number;
  nextLink: boolean;
  date(day: string): string;
  deadline(t: LabTender): string;
  banner: boolean;
  empty: boolean;
  redirectFrom: string | null;
  reordered: boolean;
  labels: typeof LABELS;
}

function look(variant: string): Look {
  const l: Look = {
    table: "tenders",
    next: "next",
    dl: "details",
    docs: "unterlagen",
    listPath: "/ausschreibungen",
    pageParam: "seite",
    perPage: PER_PAGE,
    nextLink: true,
    date: dotted,
    deadline: (t) => `${dotted(t.deadlineDate)} ${t.deadlineTime}`,
    banner: false,
    empty: false,
    redirectFrom: null,
    reordered: false,
    labels: LABELS,
  };
  if (variant === "renamed-classes") Object.assign(l, { table: "vergabeliste", next: "weiter", dl: "angaben", docs: "dokumente" });
  if (variant === "moved-list") l.listPath = "/vergabe/aktuell";
  if (variant === "new-pagination") Object.assign(l, { pageParam: "page", perPage: 5, nextLink: false });
  if (variant === "date-format") Object.assign(l, { date: (d: string) => longDate(d, "de"), deadline: (t: LabTender) => `${longDate(t.deadlineDate, "de")}, ${t.deadlineTime} Uhr` });
  if (variant === "cookie-banner") l.banner = true;
  if (variant === "empty-day") l.empty = true;
  if (variant === "redirect-list") Object.assign(l, { listPath: "/vergabe/aktuell", redirectFrom: "/ausschreibungen" });
  if (variant === "reordered-columns") l.reordered = true;
  if (variant === "renamed-labels") l.labels = RENAMED_LABELS;
  return l;
}

function layout(l: Look, title: string, body: string): string {
  const banner = l.banner ? cookieBanner("Wir verwenden Cookies, um unsere Website für Sie optimal zu gestalten.", "Alle akzeptieren") : "";
  return page(
    `${title} | Stadtwerke Lindenau`,
    "de",
    `${banner}<header><a href="/stadtwerke/">Stadtwerke Lindenau</a> · <a href="/stadtwerke${l.listPath}">Ausschreibungen</a></header><main>${body}</main>` +
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
  variants: VARIANTS,
  tendersFor,
  tenderUrl: (base, t) => `${base}/stadtwerke/ausschreibung/${t.id}`,

  handle(_req, res, path, url, ctx) {
    const l = look(ctx.variant);
    const list = l.empty ? [] : tendersFor(ctx.variant);
    if (l.redirectFrom && path === l.redirectFrom) {
      res.writeHead(301, { location: `/stadtwerke${l.listPath}${url.search}` });
      return void res.end();
    }
    if (path === "/" || path === "") {
      return sendHtml(
        res,
        layout(l, "Start", `<h1>Vergabeplattform der Stadtwerke Lindenau</h1><p>Hier veröffentlichen wir unsere laufenden Vergabeverfahren.</p><p><a href="/stadtwerke${l.listPath}">Aktuelle Ausschreibungen</a></p>`),
      );
    }
    if (path === l.listPath) {
      if (list.length === 0) {
        return sendHtml(res, layout(l, "Ausschreibungen", `<h1>Aktuelle Ausschreibungen</h1><p class="leer">Derzeit liegen keine Ausschreibungen vor.</p>`));
      }
      const pages = Math.ceil(list.length / l.perPage);
      const n = Math.min(Math.max(1, Number(url.searchParams.get(l.pageParam) ?? 1) || 1), pages);
      const rows = list
        .slice((n - 1) * l.perPage, n * l.perPage)
        .map(
          (t) => {
            const ref = `<td>${esc(t.referenceNumber)}</td>`;
            const title = `<td><a href="/stadtwerke/ausschreibung/${t.id}">${esc(t.title)}</a></td>`;
            const buyer = `<td>${esc(t.buyerName)}</td>`;
            const published = `<td>${l.date(t.publicationDate)}</td>`;
            const deadline = `<td>${l.deadline(t)}</td>`;
            const status = `<td>${t.withdrawn ? "Aufgehoben" : "Offen"}</td>`;
            return `<tr>${l.reordered ? title + deadline + status + ref + published + buyer : ref + title + buyer + published + deadline + status}</tr>`;
          },
        )
        .join("");
      const self = `/stadtwerke${l.listPath}`;
      const pager = l.nextLink
        ? `${n > 1 ? `<a class="prev" href="${self}?${l.pageParam}=${n - 1}">« Zurück</a>` : ""} Seite ${n} von ${pages} ${n < pages ? `<a class="${l.next}" href="${self}?${l.pageParam}=${n + 1}">Weiter »</a>` : ""}`
        : Array.from({ length: pages }, (_, i) => (i + 1 === n ? `<strong>${i + 1}</strong>` : `<a href="${self}?${l.pageParam}=${i + 1}">${i + 1}</a>`)).join(" ");
      return sendHtml(
        res,
        layout(
          l,
          "Ausschreibungen",
          `<h1>Aktuelle Ausschreibungen</h1><table class="${l.table}"><thead><tr>${l.reordered ? "<th>Titel</th><th>Angebotsfrist</th><th>Status</th><th>Vergabenummer</th><th>Veröffentlicht</th><th>Vergabestelle</th>" : "<th>Vergabenummer</th><th>Titel</th><th>Vergabestelle</th><th>Veröffentlicht</th><th>Angebotsfrist</th><th>Status</th>"}</tr></thead>` +
            `<tbody>${rows}</tbody></table><nav class="pager">${pager}</nav>`,
        ),
      );
    }
    const detail = path.match(/^\/ausschreibung\/(\d+)$/);
    if (detail) {
      const t = list.find((x) => x.id === detail[1]);
      if (!t) return notFound(res);
      const files = t.files.map((f) => `<li><a href="/stadtwerke/dokumente/${t.id}/${encodeURIComponent(f.name)}">${esc(f.name)}</a></li>`).join("");
      const dl: Array<[string, string]> = [
        [l.labels.ref, t.referenceNumber],
        [l.labels.buyer, t.buyerName],
        [l.labels.published, l.date(t.publicationDate)],
        [l.labels.deadline, ctx.variant === "date-format" ? l.deadline(t) : `${dotted(t.deadlineDate)}, ${t.deadlineTime} Uhr`],
        [l.labels.procedure, VERFAHREN[t.procedureType]],
        [l.labels.nature, ART[t.contractNature]],
        [l.labels.cpv, t.cpv.join(", ")],
        [l.labels.place, `${t.postalCode} ${t.city}`],
        [l.labels.status, t.withdrawn ? "Aufgehoben" : "Offen"],
      ];
      return sendHtml(
        res,
        layout(
          l,
          t.title,
          `<h1>${esc(t.title)}</h1>${t.withdrawn ? `<p class="hinweis">Dieses Verfahren wurde aufgehoben.</p>` : ""}` +
            `<dl class="${l.dl}">${dl.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` +
            `<h2>Beschreibung</h2><p class="beschreibung">${esc(t.description)}</p>` +
            `<h2>Vergabeunterlagen</h2><ul class="${l.docs}">${files}</ul>`,
        ),
      );
    }
    const file = path.match(/^\/dokumente\/(\d+)\/([^/]+)$/);
    if (file) {
      const t = list.find((x) => x.id === file[1]);
      const f = t?.files.find((x) => x.name === decodeURIComponent(file[2]!));
      if (!f) return notFound(res);
      return sendFile(res, f.name, f.bytes);
    }
    notFound(res);
  },
};
