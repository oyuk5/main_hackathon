/**
 * Demo portal 8: Obec Lipnice (CZ, fictional). Server-rendered "Veřejné zakázky" table and a public
 * detail page per tender, but every document sits behind a login:
 *   /obec/dokument/{id}/{file}  → 302 to /obec/prihlaseni (a username/password form, HTTP 200)
 *   /obec/soubory/{id}/{file}   → 401 without the session cookie
 * The brief says no logins, so Watchtower must end in `failed` with a reason saying documents need
 * a login, never serve these tenders with missing documents. The truth still lists every tender and
 * its documents (what a logged-in user would get).
 * Traps: Czech labels, Prague local time ("15.12.2026 v 10:00 hod."), postal codes like "394 64",
 * CPV with check digits, one cancelled tender ("Zrušeno").
 */
import type { IncomingMessage } from "node:http";
import { addDays, cookieBanner, dotted, esc, fakeFile, fakePdf, notFound, page, sendFile, sendHtml, today, type LabPortal, type LabTender } from "./common.js";

const ZONE = "Europe/Prague";

/** Session cookie a logged-in user would hold. Only the lab's own tests use it; Watchtower must not log in. */
export const OBEC_SESSION_COOKIE = "LIPNICE_SID=lab-session-7f3a";

const ROWS: Array<[string, LabTender["contractNature"], LabTender["procedureType"], string[], string, string, string]> = [
  ["Rekonstrukce místní komunikace Na Výsluní", "works", "open", ["45233140-2"], "394 64", "Lipnice", "Rekonstrukce místní komunikace v délce 640 m včetně odvodnění a veřejného osvětlení."],
  ["Svoz a odstraňování komunálního odpadu 2027–2029", "services", "open", ["90513100-7"], "394 64", "Lipnice", "Svoz směsného komunálního a tříděného odpadu z území obce na období tří let."],
  ["Výměna střešní krytiny budovy obecního úřadu", "works", "open", ["45261210-9"], "394 64", "Lipnice", "Výměna střešní krytiny a klempířských prvků na budově obecního úřadu."],
  ["Zimní údržba místních komunikací", "services", "negotiated", ["90620000-9"], "394 64", "Lipnice", "Zajištění zimní údržby místních komunikací a chodníků v sezóně 2026/2027."],
  ["Prodloužení vodovodního řadu v místní části Dvorce", "works", "open", ["45231300-8"], "394 65", "Dvorce", "Prodloužení vodovodního řadu PE 110 v délce 1,3 km včetně přípojek."],
  ["Dodávka vybavení dětského hřiště", "supplies", "open", ["37535200-9"], "394 64", "Lipnice", "Dodávka a montáž herních prvků a dopadových ploch pro dětské hřiště u školy."],
  ["Projektová dokumentace splaškové kanalizace", "services", "open", ["71320000-7"], "394 64", "Lipnice", "Zpracování projektové dokumentace pro stavební povolení splaškové kanalizace a ČOV."],
  ["Modernizace veřejného osvětlení", "works", "restricted", ["45316110-9"], "394 64", "Lipnice", "Výměna 180 svítidel veřejného osvětlení za LED a nové rozvaděče."],
  ["Dodávka nábytku pro základní školu", "supplies", "open", ["39160000-1"], "394 64", "Lipnice", "Dodávka školních lavic, židlí a skříní pro čtyři učebny."],
  ["Údržba veřejné zeleně", "services", "open", ["77310000-6"], "394 64", "Lipnice", "Sečení, ořez dřevin a údržba záhonů na veřejných prostranstvích obce."],
  ["Oprava hasičské zbrojnice Dvorce", "works", "open", ["45453000-7"], "394 65", "Dvorce", "Oprava fasády, výměna vrat a sanace vlhkého zdiva hasičské zbrojnice."],
  ["Dodávka elektromobilu pro technické služby", "supplies", "negotiated", ["34144900-7"], "394 64", "Lipnice", "Dodávka jednoho užitkového elektromobilu s valníkovou nástavbou."],
];

const RIZENI = { open: "Otevřené řízení", restricted: "Užší řízení", negotiated: "Jednací řízení s uveřejněním" } as const;
const DRUH = { works: "Stavební práce", services: "Služby", supplies: "Dodávky" } as const;

function build(): LabTender[] {
  const day = today(ZONE);
  return ROWS.map(([title, nature, procedure, cpv, postalCode, city, description], i) => {
    const id = String(1050 + i * 13);
    const ref = `VZ/${String(21 + i).padStart(3, "0")}/2026`;
    const slug = ref.replace(/\//g, "_");
    const files = [
      { name: `Vyzva_k_podani_nabidek_${slug}.pdf`, bytes: fakePdf(`Vyzva k podani nabidek ${ref} ${title}`) },
      { name: `Zadavaci_dokumentace_${slug}.pdf`, bytes: fakePdf(`Zadavaci dokumentace ${ref} ${description}`) },
    ];
    if (i % 3 === 1) files.push({ name: `Kryci_list_nabidky_${slug}.docx`, bytes: fakeFile(`Kryci list nabidky ${ref}`) });
    if (nature === "works") files.push({ name: `Vykaz_vymer_${slug}.xlsx`, bytes: fakeFile(`Vykaz vymer ${ref}`) });
    return {
      id,
      referenceNumber: ref,
      title,
      buyerName: "Obec Lipnice",
      publicationDate: addDays(day, -(i + 1)),
      deadlineDate: addDays(day, 10 + i * 2),
      deadlineTime: i % 2 === 0 ? "10:00" : "13:00",
      description,
      procedureType: procedure,
      contractNature: nature,
      cpv,
      postalCode,
      city,
      withdrawn: i === 5,
      files,
    };
  });
}

const tenders = build();

const VARIANTS = {
  "renamed-classes": "CSS classes renamed (table.zakazky → table.seznam-vz, table.udaje → dl.parametry, ul.dokumenty → ul.prilohy). Documents still need a login.",
  "cookie-banner": "A cookie consent overlay on every page. Data unchanged: still failed for the document login.",
  "empty-day": "No tenders today; the list says so. Not broken.",
};

function look(variant: string) {
  const renamed = variant === "renamed-classes";
  return {
    renamed,
    table: renamed ? "seznam-vz" : "zakazky",
    docs: renamed ? "prilohy" : "dokumenty",
    banner: variant === "cookie-banner",
    empty: variant === "empty-day",
  };
}
type Look = ReturnType<typeof look>;

const deadline = (t: LabTender) => `${dotted(t.deadlineDate)} v ${t.deadlineTime} hod.`;
const stav = (t: LabTender) => (t.withdrawn ? "Zrušeno" : "Probíhá");

function layout(l: Look, title: string, body: string): string {
  const banner = l.banner ? cookieBanner("Tento web používá soubory cookies. Používáním webu souhlasíte s jejich ukládáním.", "Souhlasím") : "";
  return page(
    `${title} | Obec Lipnice`,
    "cs",
    `${banner}<header><a href="/obec/">Obec Lipnice</a> · <a href="/obec/verejne-zakazky">Veřejné zakázky</a> · <a href="/obec/prihlaseni">Přihlášení</a></header>` +
      `<main>${body}</main><footer>Obecní úřad Lipnice, Náves 1, 394 64 Lipnice · Úřední hodiny Po a St 8–17 hod.</footer>`,
  );
}

function hasSession(req: IncomingMessage): boolean {
  return (req.headers.cookie ?? "").split(/;\s*/).includes(OBEC_SESSION_COOKIE);
}

function loginPage(l: Look, back: string): string {
  return layout(
    l,
    "Přihlášení do systému",
    `<h1>Přihlášení do systému</h1><p>Zadávací dokumentace je dostupná pouze registrovaným dodavatelům po přihlášení.</p>` +
      `<form class="prihlaseni" method="post" action="/obec/prihlaseni"><input type="hidden" name="navrat" value="${esc(back)}">` +
      `<label>Uživatelské jméno <input type="text" name="username" autocomplete="username"></label>` +
      `<label>Heslo <input type="password" name="password" autocomplete="current-password"></label>` +
      `<button type="submit">Přihlásit</button></form><p><a href="/obec/registrace">Registrace dodavatele</a></p>`,
  );
}

export const obec: LabPortal = {
  slug: "obec",
  name: "Obec Lipnice",
  country: "CZ",
  timeZone: ZONE,
  kind: "public list, documents behind a login (expect failed)",
  notes: [
    "List and detail pages are public; every document link answers 302 to a login page and the files answer 401 without a session.",
    "Watchtower must not log in: the expected state is failed, with a reason saying documents need a login.",
    "The truth still lists the documents a logged-in user would get.",
    `Tender ${tenders[5]!.id} is cancelled (Stav 'Zrušeno').`,
    "Deadlines are Europe/Prague local time without offset.",
  ],
  tenders,
  expect: "failed",
  expectReason: "Documents require a login",
  variants: VARIANTS,
  tenderUrl: (base, t) => `${base}/obec/zakazka/${t.id}`,

  handle(req, res, path, url, ctx) {
    const l = look(ctx.variant);
    const list = l.empty ? [] : tenders;
    if (path === "/" || path === "") {
      return sendHtml(
        res,
        layout(l, "Úvod", `<h1>Obec Lipnice</h1><p>Vítejte na oficiálních stránkách obce.</p><ul><li><a href="/obec/verejne-zakazky">Veřejné zakázky</a></li><li>Úřední deska</li><li>Kontakty</li></ul>`),
      );
    }
    if (path === "/verejne-zakazky") {
      if (list.length === 0) return sendHtml(res, layout(l, "Veřejné zakázky", `<h1>Veřejné zakázky</h1><p class="zadne">V současné době nejsou vypsány žádné veřejné zakázky.</p>`));
      const rows = list
        .map(
          (t) =>
            `<tr><td>${esc(t.referenceNumber)}</td><td><a href="/obec/zakazka/${t.id}">${esc(t.title)}</a></td><td>${DRUH[t.contractNature]}</td>` +
            `<td>${dotted(t.publicationDate)}</td><td>${deadline(t)}</td><td>${stav(t)}</td></tr>`,
        )
        .join("");
      return sendHtml(
        res,
        layout(
          l,
          "Veřejné zakázky",
          `<h1>Veřejné zakázky</h1><table class="${l.table}"><thead><tr><th>Evidenční číslo</th><th>Název zakázky</th><th>Druh</th><th>Datum uveřejnění</th><th>Lhůta pro podání nabídek</th><th>Stav</th></tr></thead>` +
            `<tbody>${rows}</tbody></table>`,
        ),
      );
    }
    const detail = path.match(/^\/zakazka\/(\d+)$/);
    if (detail) {
      const t = list.find((x) => x.id === detail[1]);
      if (!t) return notFound(res);
      const fields: Array<[string, string]> = [
        ["Evidenční číslo", t.referenceNumber],
        ["Zadavatel", t.buyerName],
        ["Druh zadávacího řízení", RIZENI[t.procedureType]],
        ["Druh veřejné zakázky", DRUH[t.contractNature]],
        ["Kód CPV", t.cpv.join(", ")],
        ["Místo plnění", `${t.postalCode} ${t.city}`],
        ["Datum uveřejnění", dotted(t.publicationDate)],
        ["Lhůta pro podání nabídek", deadline(t)],
        ["Stav", stav(t)],
      ];
      const table = l.renamed
        ? `<dl class="parametry">${fields.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`
        : `<table class="udaje">${fields.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
      const files = t.files.map((f) => `<li><a href="/obec/dokument/${t.id}/${encodeURIComponent(f.name)}">${esc(f.name)}</a> (${f.bytes.length} B)</li>`).join("");
      return sendHtml(
        res,
        layout(
          l,
          t.title,
          `<h1>${esc(t.title)}</h1>${t.withdrawn ? `<p class="upozorneni">Zadávací řízení bylo zrušeno.</p>` : ""}${table}` +
            `<h2>Předmět zakázky</h2><p class="popis">${esc(t.description)}</p>` +
            `<h2>Zadávací dokumentace</h2><p class="pozn">Ke stažení po přihlášení.</p><ul class="${l.docs}">${files}</ul>`,
        ),
      );
    }
    // Document link: without a session, off to the login page; with one, on to the file.
    const link = path.match(/^\/dokument\/(\d+)\/([^/]+)$/);
    if (link) {
      const t = list.find((x) => x.id === link[1]);
      if (!t?.files.some((f) => f.name === link[2])) return notFound(res);
      const target = `/obec/soubory/${t.id}/${encodeURIComponent(link[2]!)}`;
      const location = hasSession(req) ? target : `/obec/prihlaseni?navrat=${encodeURIComponent(`/obec/dokument/${t.id}/${encodeURIComponent(link[2]!)}`)}`;
      res.writeHead(302, { location });
      res.end();
      return;
    }
    const file = path.match(/^\/soubory\/(\d+)\/([^/]+)$/);
    if (file) {
      const t = list.find((x) => x.id === file[1]);
      const f = t?.files.find((x) => x.name === file[2]);
      if (!f) return notFound(res);
      if (!hasSession(req)) {
        return sendHtml(res, layout(l, "Přístup odepřen", `<h1>401 – Přístup odepřen</h1><p>Pro stažení dokumentu se musíte <a href="/obec/prihlaseni">přihlásit</a>.</p>`), 401);
      }
      return sendFile(res, f.name, f.bytes);
    }
    if (path === "/prihlaseni") {
      if (req.method === "POST") {
        req.resume();
        return sendHtml(res, loginPage(l, "/obec/").replace("<form", `<p class="chyba">Neplatné uživatelské jméno nebo heslo.</p><form`), 401);
      }
      return sendHtml(res, loginPage(l, url.searchParams.get("navrat") ?? "/obec/"));
    }
    if (path === "/registrace") {
      return sendHtml(res, layout(l, "Registrace dodavatele", `<h1>Registrace dodavatele</h1><p>Registraci provádí obecní úřad na základě písemné žádosti.</p>`));
    }
    notFound(res);
  },
};
