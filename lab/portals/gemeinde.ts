/**
 * Demo portal "gemeinde": Marktgemeinde Almbach (AT, fictional). The list of tenders exists only
 * after JavaScript runs: the served HTML holds an encoded blob (reversed base64 JSON) inside an
 * inline script, no tender titles, no detail links and no API a reader could call. The script shows
 * 6 tenders; a "Weitere laden" button adds 6 more per click (no URL change) until all are shown.
 * Every tender links to a server-rendered detail page with direct document links.
 * Traps: browser tier with clickNext, Austrian labels ("Angebotsfrist", "Vergabeverfahren",
 * "Geschäftszahl"), Vienna local time ("05.12.2026, 12:00 Uhr"), CPV with check digits,
 * one withdrawn tender ("Widerrufen").
 */
import { addDays, dotted, esc, fakeFile, fakePdf, notFound, page, sendFile, sendHtml, today, type LabPortal, type LabTender } from "./common.js";

const ZONE = "Europe/Vienna";
const SLUG = "gemeinde";
const BUYER = "Marktgemeinde Almbach";
const STEP = 6;

const ROWS: Array<[string, LabTender["contractNature"], LabTender["procedureType"], string[], string, string, string]> = [
  ["Thermische Sanierung der Volksschule Almbach", "works", "open", ["45321000-3"], "4872", "Almbach", "Dämmung der Außenwände und der obersten Geschoßdecke sowie Tausch von 46 Fenstern."],
  ["Winterdienst auf Gemeindestraßen 2026/2027", "services", "open", ["90620000-9"], "4872", "Almbach", "Schneeräumung und Streuung auf 38 km Gemeindestraßen und Gehsteigen."],
  ["Neubau Wasserleitung Ortsteil Reith", "works", "restricted", ["45231300-8"], "4873", "Reith", "Errichtung einer Versorgungsleitung DN 150 mit einer Länge von 3,2 km."],
  ["Lieferung eines elektrischen Kommunalfahrzeugs", "supplies", "open", ["34144900-7"], "4872", "Almbach", "Lieferung eines elektrisch betriebenen Pritschenwagens für den Bauhof."],
  ["Sammlung und Verwertung von Bioabfällen", "services", "negotiated", ["90513100-7"], "4872", "Almbach", "Sammlung der Biotonnen im Gemeindegebiet und Verwertung in einer Kompostieranlage."],
  ["Spielgeräte für den Gemeindekindergarten", "supplies", "open", ["37535200-9"], "4872", "Almbach", "Lieferung und Montage von Spielgeräten samt Fallschutz."],
  ["Generalsanierung der Gemeindestraße Almbach–Moos", "works", "open", ["45233140-2"], "4874", "Moos", "Erneuerung von Unterbau und Asphaltdecke auf 1,8 km samt Entwässerung."],
  ["Planungsleistungen Kanalisation Bauabschnitt 07", "services", "open", ["71320000-7"], "4872", "Almbach", "Einreichplanung und Ausschreibungsplanung für die Ortskanalisation BA 07."],
  ["Neubau Mehrzweckhalle Almbach", "works", "restricted", ["45212000-6"], "4872", "Almbach", "Errichtung einer Mehrzweckhalle mit Bühne, Garderoben und Lagerräumen."],
  ["Schülerbeförderung zur Mittelschule", "services", "open", ["60130000-8"], "4872", "Almbach", "Tägliche Beförderung von rund 120 Schülerinnen und Schülern in den Schuljahren 2027/28 und 2028/29."],
  ["IT-Ausstattung für das Gemeindeamt", "supplies", "open", ["30213100-6"], "4872", "Almbach", "Lieferung von 18 Notebooks samt Dockingstationen und Bildschirmen."],
  ["Barrierefreier Umbau des Gemeindeamts", "works", "open", ["45453000-7"], "4872", "Almbach", "Einbau eines Personenaufzugs und barrierefreier Umbau des Bürgerservice."],
  ["Grünraumpflege im Ortszentrum", "services", "open", ["77310000-6"], "4872", "Almbach", "Pflege der Grünflächen, Blumenbeete und Bäume im Ortszentrum."],
  ["Möblierung des neuen Kindergartengruppenraums", "supplies", "negotiated", ["39160000-1"], "4873", "Reith", "Lieferung von Tischen, Sesseln und Regalen für einen Gruppenraum."],
];

const VERFAHREN = {
  open: "Offenes Verfahren",
  restricted: "Nicht offenes Verfahren mit vorheriger Bekanntmachung",
  negotiated: "Verhandlungsverfahren mit vorheriger Bekanntmachung",
} as const;
const AUFTRAGSART = { works: "Bauauftrag", services: "Dienstleistungsauftrag", supplies: "Lieferauftrag" } as const;
/** Austrian month names: "Jänner", not "Januar". */
const MONATE = ["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function build(): LabTender[] {
  const day = today(ZONE);
  return ROWS.map(([title, nature, procedure, cpv, postalCode, city, description], i) => {
    const id = String(5100 + i * 13);
    const ref = `AL-VG-2026/${String(31 + i).padStart(3, "0")}`;
    const slugRef = ref.replace(/[^A-Za-z0-9]+/g, "_");
    const files = [
      { name: `Ausschreibungsunterlagen_${slugRef}.pdf`, bytes: fakePdf(`Ausschreibungsunterlagen ${ref} ${title}`) },
      { name: `Leistungsverzeichnis_${slugRef}.pdf`, bytes: fakePdf(`Leistungsverzeichnis ${ref} ${description}`) },
    ];
    if (i % 3 === 0) files.push({ name: `Angebotsformblatt_${slugRef}.docx`, bytes: fakeFile(`Angebotsformblatt ${ref}`) });
    return {
      id,
      referenceNumber: ref,
      title,
      buyerName: BUYER,
      publicationDate: addDays(day, -Math.floor(i * 1.5)),
      deadlineDate: addDays(day, 10 + i * 2),
      deadlineTime: i % 3 === 0 ? "12:00" : i % 3 === 1 ? "10:00" : "09:30",
      description,
      procedureType: procedure,
      contractNature: nature,
      cpv,
      postalCode,
      city,
      withdrawn: i === 4,
      files,
    };
  });
}

const tenders = build();

const VARIANTS = {
  "renamed-classes": "Rendered markup renamed (ul.vergabe-liste/li.vergabe-eintrag → div.ausschreibungen-raster/article.kachel, table.vergabe-details → table.angaben, a.dok → a.datei-link).",
  "button-text": "The load-more button 'Weitere laden' (button#weitere-laden.btn-weitere) becomes 'Mehr anzeigen' (button.mehr-anzeigen-btn, no id).",
  "moved-list": "The list moves from /gemeinde/ausschreibungen to /gemeinde/buergerservice/vergaben; the old address answers 404 and the start page links the new one.",
  "date-format": "Dates as '5. Dezember 2026' and deadlines as '5. Dezember 2026, 12:00 Uhr' (Austrian month names, 'Jänner') instead of '05.12.2026, 12:00 Uhr'.",
  "cookie-banner": "A cookie notice bar at the bottom of every page that does not cover the data or the button. Data unchanged: must stay serving.",
  "empty-day": "No tenders today: the script renders 'Derzeit sind keine Ausschreibungen veröffentlicht.' Must stay serving, not broken.",
};

function longAt(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${d}. ${MONATE[m - 1]} ${y}`;
}

function look(variant: string) {
  const renamed = variant === "renamed-classes";
  const longFmt = variant === "date-format";
  return {
    listPath: variant === "moved-list" ? "/buergerservice/vergaben" : "/ausschreibungen",
    list: renamed ? { wrap: "div", wrapClass: "ausschreibungen-raster", item: "article", itemClass: "kachel", title: "kachel-titel", meta: "kachel-info", badge: "hinweis-widerruf" } : { wrap: "ul", wrapClass: "vergabe-liste", item: "li", itemClass: "vergabe-eintrag", title: "eintrag-titel", meta: "eintrag-daten", badge: "status-widerrufen" },
    table: renamed ? "angaben" : "vergabe-details",
    docs: renamed ? "downloads" : "unterlagen",
    docLink: renamed ? "datei-link" : "dok",
    button: variant === "button-text" ? { attrs: 'class="mehr-anzeigen-btn"', text: "Mehr anzeigen" } : { attrs: 'id="weitere-laden" class="btn-weitere"', text: "Weitere laden" },
    date: (d: string) => (longFmt ? longAt(d) : dotted(d)),
    deadline: (t: LabTender) => `${longFmt ? longAt(t.deadlineDate) : dotted(t.deadlineDate)}, ${t.deadlineTime} Uhr`,
    banner: variant === "cookie-banner",
    empty: variant === "empty-day",
  };
}
type Look = ReturnType<typeof look>;

/** A notice bar at the bottom; the page keeps room for it so it never covers the list or the button. */
function cookieBar(): string {
  return (
    `<div id="cookie-hinweis" role="region" aria-label="Cookie-Hinweis" style="position:fixed;left:0;right:0;bottom:0;height:56px;background:#223;color:#fff;padding:8px 16px;z-index:50">` +
    `Diese Website verwendet Cookies, um die Nutzung zu analysieren. ` +
    `<button type="button" onclick="document.getElementById('cookie-hinweis').remove()">Alle akzeptieren</button></div>`
  );
}

function layout(l: Look, title: string, body: string, script = ""): string {
  return page(
    `${title} | ${BUYER}`,
    "de-AT",
    `${l.banner ? cookieBar() : ""}<div style="${l.banner ? "padding-bottom:140px" : ""}"><header class="kopf"><a href="/${SLUG}/">${BUYER}</a> · <a href="/${SLUG}${l.listPath}">Ausschreibungen</a></header>` +
      `<main>${body}</main><footer>Marktgemeindeamt Almbach, Marktplatz 1, 4872 Almbach · Amtsstunden Mo–Fr 8:00–12:00 Uhr</footer></div>${script}`,
  );
}

/** The list page: an empty container and a script carrying the data as reversed base64 JSON. */
function listPage(l: Look): string {
  const list = l.empty ? [] : tenders;
  const data = list.map((t) => ({
    k: t.id,
    t: t.title,
    g: t.referenceNumber,
    v: l.date(t.publicationDate),
    f: l.deadline(t),
    a: VERFAHREN[t.procedureType],
    w: t.withdrawn ? 1 : 0,
  }));
  const blob = Buffer.from(JSON.stringify(data), "utf8").toString("base64").split("").reverse().join("");
  const c = l.list;
  const cfg = { s: STEP, wrap: c.wrap, wc: c.wrapClass, item: c.item, ic: c.itemClass, tc: c.title, mc: c.meta, bc: c.badge };
  const script = `<script>
(function () {
  var D = "${blob}";
  var C = ${JSON.stringify(cfg)};
  var rows = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(D.split("").reverse().join("")), function (ch) { return ch.charCodeAt(0); })));
  var box = document.getElementById("vergabe-app");
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (x) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[x]; }); };
  var base = "/" + "${SLUG}" + "/ver" + "gabe/";
  var shown = 0;
  function item(r) {
    return "<" + C.item + ' class="' + C.ic + '"><h3 class="' + C.tc + '"><a href="' + base + r.k + '">' + esc(r.t) + "</a></h3>" +
      '<p class="' + C.mc + '">Geschäftszahl: ' + esc(r.g) + " · Veröffentlicht am: " + esc(r.v) + " · Angebotsfrist: " + esc(r.f) + "</p>" +
      "<p>" + esc(r.a) + (r.w ? ' · <strong class="' + C.bc + '">Widerrufen</strong>' : "") + "</p></" + C.item + ">";
  }
  function more() {
    var list = box.querySelector("." + C.wc);
    list.insertAdjacentHTML("beforeend", rows.slice(shown, shown + C.s).map(item).join(""));
    shown = Math.min(rows.length, shown + C.s);
    box.querySelector(".anzahl").textContent = shown + " von " + rows.length + " Ausschreibungen";
    var b = box.querySelector("button");
    if (shown >= rows.length && b) b.remove();
  }
  function start() {
    if (!rows.length) { box.innerHTML = '<p class="leer">Derzeit sind keine Ausschreibungen veröffentlicht.</p>'; return; }
    box.innerHTML = '<p class="anzahl"></p><' + C.wrap + ' class="' + C.wc + '"></' + C.wrap + '><button type="button" ${l.button.attrs}>${l.button.text}</button>';
    var b = box.querySelector("button");
    b.addEventListener("click", function () {
      if (b.disabled) return;
      b.disabled = true;
      b.textContent = "Wird geladen …";
      setTimeout(function () { more(); b.disabled = false; b.textContent = "${l.button.text}"; }, 300);
    });
    more();
  }
  setTimeout(start, 150);
})();
</script>`;
  return layout(
    l,
    "Ausschreibungen",
    `<h1>Ausschreibungen und Vergaben</h1><p>Aktuelle Vergabeverfahren der ${BUYER} nach dem Bundesvergabegesetz.</p>` +
      `<div id="vergabe-app"><noscript>Bitte aktivieren Sie JavaScript, um die Ausschreibungen anzuzeigen.</noscript><p class="laden">Ausschreibungen werden geladen …</p></div>`,
    script,
  );
}

function detailPage(l: Look, t: LabTender): string {
  const rows: Array<[string, string]> = [
    ["Geschäftszahl", t.referenceNumber],
    ["Auftraggeber", t.buyerName],
    ["Vergabeverfahren", VERFAHREN[t.procedureType]],
    ["Auftragsart", AUFTRAGSART[t.contractNature]],
    ["CPV-Code", t.cpv.join(", ")],
    ["Erfüllungsort", `${t.postalCode} ${t.city}`],
    ["Veröffentlicht am", l.date(t.publicationDate)],
    ["Angebotsfrist", l.deadline(t)],
    ["Status", t.withdrawn ? "Widerrufen" : "Laufend"],
  ];
  const docs = t.files
    .map((f) => `<li><a class="${l.docLink}" href="/${SLUG}/dokumente/${t.id}/${encodeURIComponent(f.name)}">${esc(f.name)}</a> (${(f.bytes.length / 1024).toFixed(1).replace(".", ",")} KB)</li>`)
    .join("");
  return layout(
    l,
    t.title,
    `<p><a href="/${SLUG}${l.listPath}">‹ Zurück zur Übersicht</a></p><h1>${esc(t.title)}</h1>` +
      (t.withdrawn ? `<p class="widerruf"><strong>Das Vergabeverfahren wurde widerrufen.</strong></p>` : "") +
      `<table class="${l.table}">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}</table>` +
      `<h2>Leistungsbeschreibung</h2><p class="beschreibung">${esc(t.description)}</p>` +
      `<h2>Ausschreibungsunterlagen</h2><ul class="${l.docs}">${docs}</ul>`,
  );
}

export const gemeinde: LabPortal = {
  slug: SLUG,
  name: BUYER,
  country: "AT",
  timeZone: ZONE,
  kind: "JavaScript-only list with a load-more button (browser tier)",
  notes: [
    "The list is rendered by an inline script from an encoded blob: no tenders and no API in the served HTML.",
    "6 tenders show first; 'Weitere laden' adds 6 per click without changing the URL.",
    "Tender 5152 is withdrawn (Status 'Widerrufen').",
    "Angebotsfrist is Europe/Vienna local time without offset.",
  ],
  tenders,
  variants: VARIANTS,
  tenderUrl: (base, t) => `${base}/${SLUG}/vergabe/${t.id}`,

  handle(_req, res, path, _url, ctx) {
    const l = look(ctx.variant);
    const list = l.empty ? [] : tenders;
    if (path === "/" || path === "") {
      return sendHtml(
        res,
        layout(
          l,
          "Startseite",
          `<h1>Willkommen in der ${BUYER}</h1><ul class="kacheln"><li><a href="/${SLUG}${l.listPath}">Ausschreibungen und Vergaben</a></li>` +
            `<li>Müllabfuhrkalender</li><li>Gemeindezeitung</li><li>Bürgerservice</li></ul>`,
        ),
      );
    }
    if (path === l.listPath) return sendHtml(res, listPage(l));
    const detail = path.match(/^\/vergabe\/(\d+)$/);
    if (detail) {
      const t = list.find((x) => x.id === detail[1]);
      return t ? sendHtml(res, detailPage(l, t)) : notFound(res);
    }
    const file = path.match(/^\/dokumente\/(\d+)\/([^/]+)$/);
    if (file) {
      const name = decodeURIComponent(file[2]!);
      const f = list.find((x) => x.id === file[1])?.files.find((x) => x.name === name);
      return f ? sendFile(res, f.name, f.bytes) : notFound(res);
    }
    notFound(res);
  },
};
