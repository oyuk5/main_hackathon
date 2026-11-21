/**
 * Value normalization for the Extractor. Pure functions, no network, no model.
 * Rule: a wrong value is worse than a missing one. When unsure return null
 * (or undefined for the enum mappers).
 */
import { formatWithOffset, localWallTime, offsetMinutes } from "../shared/time.js";

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Collapse whitespace, trim, decode nbsp; empty -> null. Accepts unknown (numbers -> String). */
export function cleanText(v: unknown): string | null {
  let s: string;
  if (typeof v === "string") s = v;
  else if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    s = String(v);
  } else return null;
  s = s
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/[   ​﻿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s === "" ? null : s;
}

/** Lowercase, strip accents (incl. Polish ł), for keyword matching. */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/ß/g, "ss");
}

// ---------------------------------------------------------------------------
// Cancellation words
// ---------------------------------------------------------------------------

/**
 * Words portals use for a tender the buyer cancelled, folded (lowercase, no accents). Matched only
 * against a tender's own status or label text and the start of its title, never a whole page, so
 * boilerplate like "Ausschreibungen können widerrufen werden" cannot mark a tender withdrawn.
 */
export const CANCELLATION_WORDS: readonly string[] = [
  // de
  "aufgehoben", "widerrufen", "zuruckgezogen", "zurueckgezogen",
  // fr
  "annule", "annulee", "annules", "annulees",
  // nl
  "ingetrokken", "geannuleerd",
  // it
  "annullato", "annullata", "annullati", "annullate", "revocato", "revocata",
  // es / pt
  "anulada", "anulado", "anuladas", "anulados", "revocada", "revocado",
  // da / no
  "aflyst", "annulleret", "avlyst",
  // cs
  "zruseno", "zrusena", "zruseny",
  // pl
  "uniewaznione", "uniewazniony", "uniewazniona", "uniewaznienie",
  // en
  "cancelled", "canceled", "withdrawn",
];

const CANCELLATION_SET = new Set(CANCELLATION_WORDS);
const NEGATIONS = new Set(["nicht", "kein", "keine", "not", "non", "niet", "geen", "nie", "ne", "no", "ikke", "ej", "pas"]);
const CANCELLATION_ALT = CANCELLATION_WORDS.join("|");
/** A title that opens with a cancellation word: "AUFGEHOBEN: …", "[Annulé] …", "(Widerrufen) …", "Cancelled - …". */
const CANCELLED_TITLE = new RegExp(`^\\s*(?:[\\[(]\\s*(?:${CANCELLATION_ALT})\\s*[\\])]|(?:${CANCELLATION_ALT})\\s*[:|\\-–—])`);

/** Labels longer than this are sentences, not status labels. */
const MAX_LABEL_CHARS = 40;
const MAX_LABEL_WORDS = 4;

/**
 * True when `text` is a short status label that says cancelled ("Widerrufen", "Status: Annulleret",
 * "ZRUŠENO"). A sentence or a longer text never counts, even when it contains the word.
 */
export function isCancellationLabel(text: unknown): boolean {
  const clean = cleanText(text);
  if (!clean || clean.length > MAX_LABEL_CHARS) return false;
  const words = fold(clean).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0 || words.length > MAX_LABEL_WORDS) return false;
  // "nicht widerrufen", "not cancelled", "non annullato": a negated label is no cancellation.
  if (words.some((w) => NEGATIONS.has(w))) return false;
  return words.some((w) => CANCELLATION_SET.has(w));
}

/** True when the title opens with a cancellation marker followed by a separator or in brackets. */
export function hasCancelledTitlePrefix(title: unknown): boolean {
  const clean = cleanText(title);
  return clean !== null && CANCELLED_TITLE.test(fold(clean));
}

/** Field names that hold a tender's status in a JSON item or a label on its page, folded. */
export function isStatusLabel(label: unknown): boolean {
  const clean = cleanText(label);
  if (!clean) return false;
  // tenderStatus → tender_status, so a camelCase JSON key ends in its own word.
  const s = fold(clean.replace(/(\p{Ll})(\p{Lu})/gu, "$1_$2")).replace(/[:\s]+$/, "");
  return /^(status|state|statut|stato|estado|estado do processo|stav|stav zakazky|tilstand|zustand|stand|verfahrensstand|status postepowania|status procedury|udbudsstatus|status van de aanbesteding|etat|phase)$/.test(s)
    || /(^|_|-)(status|state|stato|estado|statut|stav)$/.test(s);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTH_WORDS: Record<number, string[]> = {
  1: ["january", "jan", "januar", "janner", "jan", "janvier", "janv", "januari", "enero", "ene", "gennaio", "gen", "styczen", "stycznia", "sty", "janeiro"],
  2: ["february", "feb", "febr", "februar", "fevrier", "fevr", "fev", "februari", "febrero", "febbraio", "luty", "lutego", "lut", "fevereiro"],
  3: ["march", "mar", "marz", "maerz", "mrz", "mars", "maart", "mrt", "marzo", "marzec", "marca", "marco"],
  4: ["april", "apr", "avril", "avr", "abril", "abr", "aprile", "kwiecien", "kwietnia", "kwi"],
  5: ["may", "mai", "mei", "mayo", "maggio", "mag", "maj", "maja", "maio"],
  6: ["june", "jun", "juni", "juin", "junio", "giugno", "giu", "czerwiec", "czerwca", "cze", "junho"],
  7: ["july", "jul", "juli", "juillet", "juil", "julio", "luglio", "lug", "lipiec", "lipca", "lip", "julho"],
  8: ["august", "aug", "aout", "augustus", "agosto", "ago", "sierpien", "sierpnia", "sie"],
  9: ["september", "sep", "sept", "septembre", "septiembre", "setiembre", "set", "settembre", "wrzesien", "wrzesnia", "wrz", "setembro"],
  10: ["october", "oct", "oktober", "okt", "octobre", "octubre", "ottobre", "ott", "pazdziernik", "pazdziernika", "paz", "outubro", "out"],
  11: ["november", "nov", "novembre", "noviembre", "listopad", "listopada", "lis", "novembro"],
  12: ["december", "dec", "dezember", "dez", "decembre", "diciembre", "dic", "dicembre", "grudzien", "grudnia", "gru", "dezembro"],
};

const MONTHS = new Map<string, number>();
for (const [m, words] of Object.entries(MONTH_WORDS)) for (const w of words) MONTHS.set(w, Number(m));

function monthFromWord(word: string): number | null {
  return MONTHS.get(fold(word).replace(/\.$/, "")) ?? null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fullYear(y: string): number {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

function validYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

interface DateHit {
  y: number;
  m: number;
  d: number;
  start: number;
  end: number;
  iso: boolean;
  /** Set only when a `format` with time tokens matched. */
  time?: { h: number; mi: number; s: number };
}

const L = "\\p{L}";

const DATE_PATTERNS: { re: RegExp; iso: boolean; pick: (m: RegExpExecArray) => [number, number | null, number] | null }[] = [
  // 2026-12-09, 2026/12/09, 2026.12.09 (year first)
  {
    re: /(?<!\d)(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)/gu,
    iso: true,
    pick: (m) => [Number(m[1]), Number(m[3]), Number(m[4])],
  },
  // 09.12.2026, 9.12.2026, 09/12/2026, 09-12-2026, 09.12.26 (day first, always)
  {
    re: /(?<![\d.\/-])(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?![\d])/gu,
    iso: false,
    pick: (m) => [fullYear(m[4]!), Number(m[3]), Number(m[1])],
  },
  // 9 déc. 2026, 9. Dezember 2026, 9 de diciembre de 2026, 9 grudnia 2026, 9th December 2026
  {
    re: new RegExp(
      `(?<![\\d])(\\d{1,2})(?:st|nd|rd|th|er|e|º)?\\.?\\s*(?:de\\s+)?([${L}]{3,}\\.?)\\s*(?:de\\s+|del\\s+)?,?\\s*(\\d{4})(?!\\d)`,
      "giu",
    ),
    iso: false,
    pick: (m) => {
      const mo = monthFromWord(m[2]!);
      return mo === null ? null : [Number(m[3]), mo, Number(m[1])];
    },
  },
  // December 9, 2026 / Dec. 9th 2026
  {
    re: new RegExp(`(?<![${L}])([${L}]{3,}\\.?)\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, "giu"),
    iso: false,
    pick: (m) => {
      const mo = monthFromWord(m[1]!);
      return mo === null ? null : [Number(m[3]), mo, Number(m[2])];
    },
  },
];

/** Finds the earliest valid date in `s` with the built-in patterns. */
function findDate(s: string): DateHit | null {
  let best: DateHit | null = null;
  for (const p of DATE_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(s)) !== null) {
      if (best && m.index >= best.start) break;
      const parts = p.pick(m);
      if (parts && parts[1] !== null && validYmd(parts[0], parts[1], parts[2])) {
        best = { y: parts[0], m: parts[1], d: parts[2], start: m.index, end: m.index + m[0].length, iso: p.iso };
        break;
      }
      if (m[0].length === 0) p.re.lastIndex++;
    }
  }
  return best;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a regex from a format like "dd.MM.yyyy HH:mm" and matches it inside `s`. */
function matchFormat(s: string, format: string): DateHit | null {
  const tokens = /yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|H|hh|h|mm|ss|a|'[^']*'/g;
  const groups: string[] = [];
  let re = "";
  let last = 0;
  let t: RegExpExecArray | null;
  while ((t = tokens.exec(format)) !== null) {
    re += literal(format.slice(last, t.index));
    last = t.index + t[0].length;
    const tok = t[0];
    if (tok.startsWith("'")) {
      re += escapeRe(tok.slice(1, -1));
      continue;
    }
    groups.push(tok);
    switch (tok) {
      case "yyyy": re += "(\\d{4})"; break;
      case "yy": re += "(\\d{2})"; break;
      case "MMMM":
      case "MMM": re += `([${L}]{3,}\\.?)`; break;
      case "MM": case "dd": case "HH": case "hh": case "mm": case "ss": re += "(\\d{2})"; break;
      case "a": re += "([AaPp]\\.?[Mm]\\.?)"; break;
      default: re += "(\\d{1,2})"; // M, d, H, h
    }
  }
  re += literal(format.slice(last));
  let rx: RegExp;
  try {
    rx = new RegExp(`(?<!\\d)${re}(?!\\d)`, "iu");
  } catch {
    return null;
  }
  const m = rx.exec(s);
  if (!m) return null;
  let y: number | null = null, mo: number | null = null, d: number | null = null;
  let h: number | null = null, mi: number | null = null, sec = 0, ampm: string | null = null;
  groups.forEach((g, i) => {
    const v = m[i + 1]!;
    switch (g) {
      case "yyyy": case "yy": y = fullYear(v); break;
      case "MMMM": case "MMM": mo = monthFromWord(v); break;
      case "MM": case "M": mo = Number(v); break;
      case "dd": case "d": d = Number(v); break;
      case "HH": case "H": case "hh": case "h": h = Number(v); break;
      case "mm": mi = Number(v); break;
      case "ss": sec = Number(v); break;
      case "a": ampm = v; break;
    }
  });
  if (y === null || mo === null || d === null || !validYmd(y, mo, d)) return null;
  const hit: DateHit = { y, m: mo, d, start: m.index, end: m.index + m[0].length, iso: false };
  if (h !== null) {
    const time = makeTime(h, mi ?? 0, sec, ampm);
    if (!time) return null;
    hit.time = time;
  }
  return hit;

  function literal(x: string): string {
    // Any whitespace in the format matches flexible whitespace.
    return x
      .split(/\s+/)
      .map(escapeRe)
      .join("\\s*");
  }
}

/** Calendar date "YYYY-MM-DD" or null. */
export function parseDate(v: unknown, format?: string): string | null {
  const s = typeof v === "string" ? cleanText(v) : null;
  if (!s) return null;
  const hit = (format ? matchFormat(s, format) : null) ?? findDate(s);
  return hit ? ymd(hit.y, hit.m, hit.d) : null;
}

// ---------------------------------------------------------------------------
// Date-times
// ---------------------------------------------------------------------------

function makeTime(h: number, mi: number, s: number, ampm: string | null): { h: number; mi: number; s: number } | null {
  if (ampm) {
    const pm = /^p/i.test(ampm);
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h === 24 && mi === 0 && s === 0) return { h: 24, mi: 0, s: 0 };
  if (h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) return null;
  return { h, mi, s };
}

const AMPM = "(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)(?![\\p{L}])";
const TIME_PATTERNS: RegExp[] = [
  // 10:00, 10:00:00, 10.00, 10h00, 10 h 00, 10:00 Uhr, 10:00 AM
  new RegExp(`(?<![\\d.:,])(\\d{1,2})\\s*(?::|\\.|\\s?h\\s?)\\s*(\\d{2})(?::(\\d{2}))?(?![\\d])(?:\\.\\d+)?\\s*(?:uhr\\b|${AMPM})?`, "iu"),
  // 10 Uhr, 10h, 10 AM
  new RegExp(`(?<![\\d.:,])(\\d{1,2})\\s*(?:uhr\\b|h(?![\\p{L}\\d])|${AMPM})`, "iu"),
];

/** A time must sit within this many characters of the date, so stray numbers elsewhere are ignored. */
const NEAR = 30;

interface TimeHit {
  h: number;
  mi: number;
  s: number;
  start: number;
  end: number;
}

function findTime(s: string): TimeHit | null {
  for (const re of TIME_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const isFirst = re === TIME_PATTERNS[0];
    const h = Number(m[1]);
    const mi = isFirst ? Number(m[2]) : 0;
    const sec = isFirst && m[3] ? Number(m[3]) : 0;
    const ampm = (isFirst ? m[4] : m[2]) ?? null;
    const t = makeTime(h, mi, sec, ampm);
    if (!t) return null; // something time-like but impossible: do not guess
    return { ...t, start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/** Explicit offset right after the time: Z, UTC, GMT, GMT+1, +01:00 (bare offset only for ISO dates). */
function findOffset(after: string, iso: boolean): number | null {
  const named = /^\s*(?:Z(?![\p{L}])|UTC|GMT)\s*(?:([+-])(\d{1,2})(?::?(\d{2}))?)?/iu.exec(after);
  if (named) {
    if (!named[1]) return 0;
    return offsetValue(named[1], named[2]!, named[3]);
  }
  if (iso) {
    const bare = /^\s*([+-])(\d{2}):?(\d{2})(?!\d)/.exec(after);
    if (bare) return offsetValue(bare[1]!, bare[2]!, bare[3]);
  }
  return null;
}

function offsetValue(sign: string, hh: string, mm?: string): number | null {
  const h = Number(hh), m = Number(mm ?? 0);
  if (h > 14 || m > 59) return null;
  return (sign === "-" ? -1 : 1) * (h * 60 + m);
}

/** Date-time WITH offset (e.g. "2026-12-09T10:00:00+01:00") or null. */
export function parseDateTime(v: unknown, timeZone: string, format?: string): string | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 1e11) return null;
    return safeFormat(new Date(v), timeZone);
  }
  const s = cleanText(v);
  if (!s) return null;
  if (/^\d{12,13}$/.test(s)) return safeFormat(new Date(Number(s)), timeZone);

  const hit = (format ? matchFormat(s, format) : null) ?? findDate(s);
  if (!hit) return null;

  let time = hit.time ? { ...hit.time, end: hit.end } : null;
  if (!time) {
    // Prefer a time after the date, then one before it. A time after the next date belongs to that
    // date, and "15.02.2027" must not be read as 15:02, so the search stops where another date starts.
    let after = s.slice(hit.end);
    const nextDate = findDate(after);
    if (nextDate) after = after.slice(0, nextDate.start);
    const t1 = findTime(after);
    if (t1 && t1.start <= NEAR) time = { h: t1.h, mi: t1.mi, s: t1.s, end: hit.end + t1.end };
    else {
      const before = s.slice(0, hit.start);
      const t2 = findTime(before);
      if (t2 && before.length - t2.end <= NEAR) time = { h: t2.h, mi: t2.mi, s: t2.s, end: t2.end };
    }
  }
  if (!time) return null; // a date alone: never invent a time

  // 24:00 means the end of that day.
  let { y, m, d } = hit;
  let h = time.h;
  if (h === 24) {
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
    h = 0;
  }

  const offset = findOffset(s.slice(time.end), hit.iso);
  if (offset !== null) {
    const instant = Date.UTC(y, m - 1, d, h, time.mi, time.s) - offset * 60000;
    return safeFormat(new Date(instant), timeZone);
  }
  try {
    const wall = `${pad2(h)}:${pad2(time.mi)}:${pad2(time.s)}`;
    const out = localWallTime(ymd(y, m, d), wall, timeZone);
    const wallDateTime = `${ymd(y, m, d)}T${wall}`;
    // A spring gap does not exist. During a fall overlap the same clock time can name two instants.
    if (out.slice(0, 19) !== wallDateTime) return null;
    const instant = Date.parse(out);
    const currentOffset = offsetMinutes(new Date(instant), timeZone);
    for (const delta of [-86_400_000, 86_400_000]) {
      const otherOffset = offsetMinutes(new Date(instant + delta), timeZone);
      if (otherOffset === currentOffset) continue;
      const alternative = new Date(instant + (currentOffset - otherOffset) * 60_000);
      if (formatWithOffset(alternative, timeZone).slice(0, 19) === wallDateTime) return null;
    }
    return out;
  } catch {
    return null;
  }
}

function safeFormat(d: Date, zone: string): string | null {
  if (Number.isNaN(d.getTime())) return null;
  try {
    return formatWithOffset(d, zone);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CPV
// ---------------------------------------------------------------------------

/** Valid CPV divisions (first two digits). Rejects dates and other 8-digit junk. */
const CPV_DIVISIONS = new Set([
  "03", "09", "14", "15", "16", "18", "19", "22", "24", "30", "31", "32", "33", "34", "35", "37", "38", "39",
  "41", "42", "43", "44", "45", "48", "50", "51", "55", "60", "63", "64", "65", "66", "70", "71", "72", "73",
  "75", "76", "77", "79", "80", "85", "90", "92", "98",
]);

const CPV_RE = /(?<![\d.,])(\d{8})(?:\s?-\s?\d)?(?![\d.,]?\d)/g;

function cpvCandidates(v: unknown): string[] {
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0) return [];
    // A number cannot carry the leading zero of division 03.
    const s = String(v);
    return s.length === 7 || s.length === 8 ? [s.padStart(8, "0")] : [];
  }
  const s = cleanText(v);
  if (!s) return [];
  const out: string[] = [];
  for (const m of s.matchAll(CPV_RE)) out.push(m[1]!);
  return out;
}

function validCpv(c: string): boolean {
  return /^\d{8}$/.test(c) && CPV_DIVISIONS.has(c.slice(0, 2));
}

/** "45000000-7" -> "45000000"; anything not giving exactly 8 digits -> null. */
export function normalizeCpv(v: unknown): string | null {
  const found = [...new Set(cpvCandidates(v))];
  if (found.length !== 1) return null;
  return validCpv(found[0]!) ? found[0]! : null;
}

/** Pulls every CPV code out of a string/array ("45000000-7, 45200000-9" or ["..."]); dedupes, order kept. */
export function normalizeCpvList(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(x)) for (const y of x) walk(y, depth + 1);
    else for (const c of cpvCandidates(x)) if (validCpv(c) && !out.includes(c)) out.push(c);
  };
  walk(v, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

function words(v: unknown): string | null {
  const s = cleanText(v);
  if (!s) return null;
  return ` ${fold(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

const PROCEDURE_RULES: [RegExp, "open" | "restricted" | "negotiated" | "other"][] = [
  // other first: these names may contain "open"/"negotiat..." style words
  [/ (competitive dialogue?|comp dial|wettbewerbliche[rn]? dialog|dialogue competitif|concurrentiegerichte dialoog|dialogo competitivo|dialog konkurencyjny|innovation partnership|innovationspartnerschaft|partenariat d innovation|innovatiepartnerschap|asociacion para la innovacion|partenariato per l innovazione|partnerstwo innowacyjne|freihandige vergabe|direktauftrag|direktvergabe|direct award|zamowienie z wolnej reki|z wolnej reki|affidamento diretto|adjudicacion directa|gre a gre|design contest|prijsvraag|oth single|oth mult|open house) /, "other"],
  [/ (verhandlungsverfahren|verhandlungsvergabe|negotiated?|negotiation|neg w call|neg wo call|negocie|negociee|negociation|onderhandeling\p{L}*|onderhandelings\p{L}*|negociado|negociacion|negoziat\p{L}*|negocjac\p{L}*|z negocjacjami) /u, "negotiated"],
  [/ (nichtoffene\p{L}*|nicht offene\p{L}*|beschrankte\p{L}*|restreint\p{L}*|niet openba\p{L}*|nietopenba\p{L}*|restringid\p{L}*|ristrett\p{L}*|restricted|ograniczony) /u, "restricted"],
  [/ (offene\p{L}*|offentliche ausschreibung|ouvert\p{L}*|openbaar\p{L}*|openbare|open|abierto\p{L}*|aperta|aperto|nieograniczony) /u, "open"],
];

export function mapProcedureType(v: unknown): "open" | "restricted" | "negotiated" | "other" | undefined {
  const w = words(v);
  if (!w) return undefined;
  const exact = w.trim();
  if (exact === "other" || exact === "innovation") return "other";
  const hits = new Set(PROCEDURE_RULES.filter(([re]) => re.test(w)).map(([, val]) => val));
  // Restricted and "other" names often contain an open word ("nicht offenes", "Open House"): they win over open.
  if (hits.has("restricted") || hits.has("other")) hits.delete("open");
  // Text naming two procedures ("Offenes Verfahren oder Verhandlungsverfahren") is not one value: leave it out.
  return hits.size === 1 ? [...hits][0] : undefined;
}

const NATURE_RULES: [RegExp, "works" | "services" | "supplies"][] = [
  [/ (bau|bauleistung\p{L}*|bauauftrag\p{L}*|bauarbeiten|travaux|werken|obras?|lavori|roboty budowlane|robota budowlana|works) /u, "works"],
  [/ (dienstleistung\p{L}*|dienstleistungsauftrag\p{L}*|services?|prestations? de services?|diensten|dienstverlening|servicios?|servizi|servizio|uslugi|usluga) /u, "services"],
  [/ (lieferleistung\p{L}*|lieferung\p{L}*|lieferauftrag\p{L}*|fournitures?|leveringen|levering|suministros?|forniture|fornitura|dostawy|dostawa|supplies|supply) /u, "supplies"],
];

export function mapContractNature(v: unknown): "works" | "services" | "supplies" | undefined {
  const w = words(v);
  if (!w) return undefined;
  const hits = NATURE_RULES.filter(([re]) => re.test(w)).map(([, val]) => val);
  // Mixed ("Bau- und Dienstleistungen") is ambiguous: leave it out.
  return hits.length === 1 ? hits[0] : undefined;
}

// ---------------------------------------------------------------------------
// Place and links
// ---------------------------------------------------------------------------

/** Postal code as shown (trimmed), only if it looks like a postal code (digits/letters 3-10, e.g. "10115", "1012 AB", "75001"), else null. */
export function normalizePostalCode(v: unknown): string | null {
  let s = cleanText(v);
  if (!s) return null;
  // Old country prefix: "D-10115", "F-75001", "NL-1012 AB".
  s = s.replace(/^[A-Z]{1,2}\s?-\s?(?=\d)/, "");
  if (s.length < 3 || s.length > 10) return null;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|[ -](?=[A-Za-z0-9])){2,9}$/.test(s)) return null;
  if ((s.match(/[ -]/g) ?? []).length > 1) return null;
  if (!/\d/.test(s)) return null;
  return s;
}

/** Resolve href against base; only http(s); javascript:/mailto:/# -> null. */
export function absoluteUrl(href: unknown, base: string): string | null {
  if (typeof href !== "string") return null;
  const h = href.replace(/[ ]/g, " ").trim();
  if (!h || h.startsWith("#")) return null;
  if (/^(javascript|mailto|tel|data|about|file|ftp|blob):/i.test(h.replace(/\s+/g, ""))) return null;
  let url: URL;
  try {
    url = new URL(h, base);
  } catch {
    try {
      url = new URL(h);
    } catch {
      return null;
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href;
}
