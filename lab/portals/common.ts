/**
 * Shared pieces for the lab's demo portals (person D).
 * Every demo portal is generated from a fixed list of tenders, so its ground truth is exact.
 */
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { localWallTime } from "../../src/shared/time.js";

export interface LabFile {
  name: string;
  bytes: Buffer;
}

/** One tender as the demo portal holds it, before the portal renders it in its own way. */
export interface LabTender {
  /** The portal's own identifier (in its URLs and data). */
  id: string;
  referenceNumber: string;
  title: string;
  buyerName: string;
  /** YYYY-MM-DD */
  publicationDate: string;
  /** YYYY-MM-DD and HH:mm, local time of the portal. */
  deadlineDate: string;
  deadlineTime: string;
  description: string;
  procedureType: "open" | "restricted" | "negotiated";
  contractNature: "works" | "services" | "supplies";
  /** With check digit, as portals show them, e.g. 45231300-8. */
  cpv: string[];
  postalCode: string;
  city: string;
  withdrawn: boolean;
  /** Files linked directly. */
  files: LabFile[];
  /** A ZIP linked next to the files; the truth lists its unpacked members. */
  zip?: { name: string; members: LabFile[] };
}

export interface TruthDocument {
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

/** What Watchtower should deliver for one tender (lastChangedAt and file paths are ours, so left out). */
export interface TruthTender {
  id: string;
  url: string;
  title: string;
  buyerName: string;
  publicationDate: string;
  submissionDeadline: string;
  status: "open" | "withdrawn";
  documents: TruthDocument[];
  referenceNumber: string;
  description: string;
  procedureType: string;
  contractNature: string;
  cpvCodes: string[];
  placeOfPerformance: { postalCode: string; city: string; countryCode: string };
}

export interface Truth {
  portal: string;
  url: string;
  country: string;
  timeZone: string;
  kind: string;
  notes: string[];
  /** Ids may be either the portal id or the reference number; match tenders by url. */
  tenders: TruthTender[];
  /** The state Watchtower should end in after attach. "failed" for portals that block us on purpose. */
  expect: "serving" | "failed";
  /** For "failed": what the reason should say, in plain words. */
  expectReason?: string;
}

export interface LabPortal {
  slug: string;
  name: string;
  country: string;
  timeZone: string;
  kind: string;
  notes: string[];
  tenders: LabTender[];
  /** The state Watchtower should end in after attach (default "serving"). "failed" for portals that block us on purpose. */
  expect?: "serving" | "failed";
  /** For expect "failed": what Watchtower's reason should say, in plain words. */
  expectReason?: string;
  /** Changed versions the mutator can switch to: name → what changes. "v1" is always the original. */
  variants: Record<string, string>;
  /** Absolute URL of a tender's own page. */
  tenderUrl(base: string, t: LabTender): string;
  /** Handles a request under /<slug>/. `path` is the rest after the slug, starting with "/". */
  handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL, ctx: PortalCtx): void;
}

export interface PortalCtx {
  /** e.g. http://localhost:4100 */
  base: string;
  /** Changed version set by the mutator; "v1" is the original. */
  variant: string;
}

// ---------------------------------------------------------------- dates

/** Today as YYYY-MM-DD in the given zone. LAB_TODAY fixes it (for tests and repeatable evals). */
export function today(zone: string): string {
  if (process.env.LAB_TODAY) return process.env.LAB_TODAY;
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 2026-12-05 → 05.12.2026 */
export function dotted(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}.${m}.${y}`;
}

// ---------------------------------------------------------------- files

/** A small, valid-looking PDF whose bytes depend only on the text. */
export function fakePdf(text: string): Buffer {
  const body = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n` +
      `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n` +
      `4 0 obj<</Length ${body.length}>>stream\n${body}\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
  );
}

/** Plain bytes for a non-PDF attachment (e.g. a form as .docx or .xlsx stand-in). */
export function fakeFile(text: string): Buffer {
  return Buffer.from(`Lab document\n${text}\n`);
}

/** Minimal ZIP writer (stored, no compression). Enough for the document fetcher to unpack. */
export function makeZip(files: LabFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.bytes) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.bytes.length, 18);
    local.writeUInt32LE(f.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, f.bytes);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.bytes.length, 20);
    central.writeUInt32LE(f.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + f.bytes.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

function doc(f: LabFile): TruthDocument {
  return { fileName: f.name, sizeBytes: f.bytes.length, sha256: sha256(f.bytes) };
}

/** Bytes of the ZIP for a tender (built once and cached so its hash is stable). */
const zipCache = new Map<string, Buffer>();
export function zipBytes(t: LabTender): Buffer {
  if (!t.zip) throw new Error(`tender ${t.id} has no zip`);
  const key = `${t.id}/${t.zip.name}`;
  let z = zipCache.get(key);
  if (!z) zipCache.set(key, (z = makeZip(t.zip.members)));
  return z;
}

// ---------------------------------------------------------------- truth

/** Variants that are not breakage: the system must stay serving and must not repair. */
export const HARMLESS = new Set(["cookie-banner", "empty-day"]);

export function truthOf(p: LabPortal, base: string, variant = "v1"): Truth & { variant: string } {
  const tenders = variant === "empty-day" ? [] : p.tenders;
  return {
    portal: p.slug,
    variant,
    url: `${base}/${p.slug}/`,
    country: p.country,
    timeZone: p.timeZone,
    kind: p.kind,
    notes: p.notes,
    expect: p.expect ?? "serving",
    ...(p.expectReason ? { expectReason: p.expectReason } : {}),
    tenders: tenders.map((t) => ({
      id: t.id,
      url: p.tenderUrl(base, t),
      title: t.title,
      buyerName: t.buyerName,
      publicationDate: t.publicationDate,
      submissionDeadline: localWallTime(t.deadlineDate, t.deadlineTime, p.timeZone),
      status: t.withdrawn ? "withdrawn" : "open",
      documents: [...t.files.map(doc), ...(t.zip?.members.map(doc) ?? [])],
      referenceNumber: t.referenceNumber,
      description: t.description,
      procedureType: t.procedureType,
      contractNature: t.contractNature,
      cpvCodes: t.cpv.map((c) => c.slice(0, 8)),
      placeOfPerformance: { postalCode: t.postalCode, city: t.city, countryCode: p.country },
    })),
  };
}

// ---------------------------------------------------------------- http helpers

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function sendHtml(res: ServerResponse, html: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

export function sendFile(res: ServerResponse, name: string, bytes: Buffer): void {
  const type = name.endsWith(".pdf") ? "application/pdf" : name.endsWith(".zip") ? "application/zip" : "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "content-length": bytes.length,
    "content-disposition": `attachment; filename="${name}"`,
  });
  res.end(bytes);
}

export function notFound(res: ServerResponse): void {
  sendHtml(res, "<!doctype html><title>Not found</title><h1>Not found</h1>", 404);
}

/** German, French and Polish month names for the date-format variants. */
const MONTHS: Record<string, string[]> = {
  de: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
  fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
  pl: ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"],
};

/** 2026-12-05 → "5. Dezember 2026" (de), "5 décembre 2026" (fr), "5 grudnia 2026" (pl) */
export function longDate(day: string, lang: "de" | "fr" | "pl"): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return `${d}${lang === "de" ? "." : ""} ${MONTHS[lang]![m - 1]} ${y}`;
}

/** A cookie consent overlay. Changes the page, not the data. */
export function cookieBanner(text: string, accept: string): string {
  return (
    `<div id="cookie-consent" class="consent-overlay" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:999">` +
    `<div class="consent-box"><p>${esc(text)}</p><button type="button" onclick="this.closest('#cookie-consent').remove()">${esc(accept)}</button></div></div>`
  );
}

export function page(title: string, lang: string, body: string, head = ""): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${esc(title)}</title>${head}</head><body>${body}</body></html>`;
}
