/**
 * Demo portal 3: Gmina Lipowo (PL). Paginated cards (?strona=N), a detail page per tender, and a
 * multi-step download: the detail page links to a "Dokumentacja" page that lists the files,
 * one of them a ZIP with more files inside.
 * Traps: two-hop documents, ZIP to unpack, Polish labels, local Warsaw time
 * ("04.12.2026 godz. 09:00"), postal codes like 11-034, CPV with check digits.
 */
import { addDays, dotted, esc, fakeFile, fakePdf, notFound, page, sendFile, sendHtml, today, zipBytes, type LabPortal, type LabTender } from "./common.js";

const ZONE = "Europe/Warsaw";
const PER_PAGE = 6;

const ROWS: Array<[string, LabTender["contractNature"], LabTender["procedureType"], string[], string, string, string]> = [
  ["Przebudowa drogi gminnej w miejscowości Kosewo", "works", "open", ["45233140-2"], "11-034", "Kosewo", "Przebudowa drogi gminnej o długości 2,4 km wraz z odwodnieniem."],
  ["Dostawa oleju opałowego do szkół", "supplies", "open", ["09135100-5"], "11-034", "Lipowo", "Dostawa 120 000 litrów oleju opałowego do trzech szkół."],
  ["Odbiór i zagospodarowanie odpadów komunalnych", "services", "open", ["90513100-7"], "11-034", "Lipowo", "Odbiór odpadów komunalnych z nieruchomości zamieszkałych w latach 2027-2028."],
  ["Budowa świetlicy wiejskiej w Bartągu", "works", "open", ["45212000-6"], "11-036", "Bartąg", "Budowa parterowej świetlicy wiejskiej z zapleczem."],
  ["Dowóz uczniów do szkół", "services", "restricted", ["60130000-8"], "11-034", "Lipowo", "Dowóz uczniów do szkół podstawowych w roku szkolnym 2026/2027."],
  ["Dostawa sprzętu komputerowego dla urzędu", "supplies", "open", ["30213100-6"], "11-034", "Lipowo", "Dostawa 25 laptopów i 10 monitorów."],
  ["Termomodernizacja budynku urzędu gminy", "works", "open", ["45321000-3"], "11-034", "Lipowo", "Docieplenie ścian i stropodachu oraz wymiana okien."],
  ["Zimowe utrzymanie dróg gminnych", "services", "open", ["90620000-9"], "11-034", "Lipowo", "Odśnieżanie i zwalczanie śliskości na drogach gminnych."],
  ["Budowa sieci wodociągowej Lipowo-Kosewo", "works", "restricted", ["45231300-8"], "11-034", "Kosewo", "Budowa sieci wodociągowej o długości 5,1 km."],
  ["Dostawa wyposażenia placu zabaw", "supplies", "open", ["37535200-9"], "11-036", "Bartąg", "Dostawa i montaż urządzeń placu zabaw."],
  ["Opracowanie dokumentacji projektowej kanalizacji", "services", "open", ["71320000-7"], "11-034", "Lipowo", "Projekt kanalizacji sanitarnej dla trzech sołectw."],
  ["Remont remizy OSP Lipowo", "works", "open", ["45453000-7"], "11-034", "Lipowo", "Remont dachu i elewacji remizy Ochotniczej Straży Pożarnej."],
  ["Dostawa paliw do pojazdów gminnych", "supplies", "open", ["09130000-9"], "11-034", "Lipowo", "Sukcesywna dostawa benzyny i oleju napędowego."],
];

const TRYB = { open: "Przetarg nieograniczony", restricted: "Przetarg ograniczony", negotiated: "Negocjacje z ogłoszeniem" } as const;
const RODZAJ = { works: "Roboty budowlane", services: "Usługi", supplies: "Dostawy" } as const;

function build(): LabTender[] {
  const day = today(ZONE);
  return ROWS.map(([title, nature, procedure, cpv, postalCode, city, description], i) => {
    const id = String(3200 + i * 11);
    const ref = `ZP.271.${String(40 + i)}.2026`;
    const t: LabTender = {
      id,
      referenceNumber: ref,
      title,
      buyerName: "Gmina Lipowo",
      publicationDate: addDays(day, -i),
      deadlineDate: addDays(day, 7 + i * 3),
      deadlineTime: i % 2 === 0 ? "09:00" : "11:30",
      description,
      procedureType: procedure,
      contractNature: nature,
      cpv,
      postalCode,
      city,
      withdrawn: false,
      files: [{ name: `Ogloszenie_${ref}.pdf`, bytes: fakePdf(`Ogloszenie o zamowieniu ${ref}`) }],
    };
    // Every second tender has its SWZ and forms in a ZIP; the others link them one by one.
    const members = [
      { name: `SWZ_${ref}.pdf`, bytes: fakePdf(`Specyfikacja warunkow zamowienia ${ref} ${description}`) },
      { name: `Zalacznik_1_Formularz_ofertowy_${ref}.docx`, bytes: fakeFile(`Formularz ofertowy ${ref}`) },
    ];
    if (i % 2 === 0) t.zip = { name: `Dokumentacja_${ref.replace(/\./g, "_")}.zip`, members };
    else t.files.push(...members);
    return t;
  });
}

const tenders = build();

function layout(title: string, body: string): string {
  return page(
    `${title} - Gmina Lipowo`,
    "pl",
    `<header><a href="/gmina/">Gmina Lipowo</a> · <a href="/gmina/przetargi">Przetargi</a></header><main>${body}</main><footer>Urząd Gminy Lipowo, ul. Kościelna 1, 11-034 Lipowo</footer>`,
  );
}

function fileLinks(t: LabTender): string {
  const items = t.files.map((f) => `<li><a class="plik" href="/gmina/pliki/${t.id}/${encodeURIComponent(f.name)}">${esc(f.name)}</a> (${f.bytes.length} B)</li>`);
  if (t.zip) items.push(`<li><a class="plik" href="/gmina/pliki/${t.id}/${encodeURIComponent(t.zip.name)}">${esc(t.zip.name)}</a> (archiwum ZIP)</li>`);
  return items.join("");
}

export const gmina: LabPortal = {
  slug: "gmina",
  name: "Gmina Lipowo",
  country: "PL",
  timeZone: ZONE,
  kind: "paginated cards, detail pages, two-step document download with ZIP",
  notes: ["Documents are on /przetarg/{id}/dokumentacja, one hop from the detail page.", "Even-numbered tenders ship SWZ and forms in a ZIP; the truth lists the unpacked files."],
  tenders,
  tenderUrl: (base, t) => `${base}/gmina/przetarg/${t.id}`,

  handle(_req, res, path, url) {
    if (path === "/" || path === "") {
      return sendHtml(res, layout("Strona główna", `<h1>Biuletyn zamówień publicznych Gminy Lipowo</h1><p><a href="/gmina/przetargi">Zobacz aktualne przetargi</a></p>`));
    }
    if (path === "/przetargi") {
      const pages = Math.ceil(tenders.length / PER_PAGE);
      const n = Math.min(Math.max(1, Number(url.searchParams.get("strona") ?? 1) || 1), pages);
      const cards = tenders
        .slice((n - 1) * PER_PAGE, n * PER_PAGE)
        .map(
          (t) =>
            `<div class="karta"><h3><a href="/gmina/przetarg/${t.id}">${esc(t.title)}</a></h3>` +
            `<p class="zamawiajacy">Zamawiający: ${esc(t.buyerName)}</p><p class="numer">Nr: ${esc(t.referenceNumber)}</p>` +
            `<p class="daty">Data publikacji: ${dotted(t.publicationDate)} · Termin składania ofert: ${dotted(t.deadlineDate)} godz. ${t.deadlineTime}</p></div>`,
        )
        .join("");
      const links = Array.from({ length: pages }, (_, i) =>
        i + 1 === n ? `<span class="biezaca">${i + 1}</span>` : `<a href="/gmina/przetargi?strona=${i + 1}">${i + 1}</a>`,
      ).join(" ");
      const next = n < pages ? ` <a rel="next" class="nastepna" href="/gmina/przetargi?strona=${n + 1}">Następna ›</a>` : "";
      return sendHtml(res, layout("Przetargi", `<h1>Aktualne przetargi</h1><section class="lista">${cards}</section><nav class="stronicowanie">${links}${next}</nav>`));
    }
    const detail = path.match(/^\/przetarg\/(\d+)$/);
    if (detail) {
      const t = tenders.find((x) => x.id === detail[1]);
      if (!t) return notFound(res);
      const rows: Array<[string, string]> = [
        ["Numer postępowania", t.referenceNumber],
        ["Zamawiający", t.buyerName],
        ["Tryb postępowania", TRYB[t.procedureType]],
        ["Rodzaj zamówienia", RODZAJ[t.contractNature]],
        ["Kod CPV", t.cpv.join(", ")],
        ["Miejsce realizacji", `${t.postalCode} ${t.city}`],
        ["Data publikacji", dotted(t.publicationDate)],
        ["Termin składania ofert", `${dotted(t.deadlineDate)} godz. ${t.deadlineTime}`],
      ];
      return sendHtml(
        res,
        layout(
          t.title,
          `<h1>${esc(t.title)}</h1><table class="szczegoly">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}</table>` +
            `<h2>Przedmiot zamówienia</h2><p class="opis">${esc(t.description)}</p>` +
            `<p><a class="dokumentacja" href="/gmina/przetarg/${t.id}/dokumentacja">Dokumentacja postępowania</a></p>`,
        ),
      );
    }
    const docs = path.match(/^\/przetarg\/(\d+)\/dokumentacja$/);
    if (docs) {
      const t = tenders.find((x) => x.id === docs[1]);
      if (!t) return notFound(res);
      return sendHtml(res, layout(`Dokumentacja: ${t.title}`, `<h1>Dokumentacja postępowania</h1><p>${esc(t.referenceNumber)}: ${esc(t.title)}</p><ul class="pliki">${fileLinks(t)}</ul>`));
    }
    const file = path.match(/^\/pliki\/(\d+)\/([^/]+)$/);
    if (file) {
      const t = tenders.find((x) => x.id === file[1]);
      const name = decodeURIComponent(file[2]!);
      if (t?.zip && t.zip.name === name) return sendFile(res, name, zipBytes(t));
      const f = t?.files.find((x) => x.name === name);
      return f ? sendFile(res, f.name, f.bytes) : notFound(res);
    }
    notFound(res);
  },
};
