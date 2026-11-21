/**
 * Finds portal addresses in whatever list an operator has: Excel (.xlsx, .xlsm, old .xls), OpenDocument (.ods),
 * CSV/TSV, JSON, XML, HTML, Markdown or plain text, Word (.docx). No library: Office and OpenDocument files are
 * ZIP archives of XML, unpacked with the browser's own DecompressionStream.
 * Every http(s) or www. address is taken; the operator picks which ones to watch in the preview.
 */

import { t } from "./i18n";

export interface FoundUrl {
  url: string;
  /** For de-duplication: host (lower case, no www.) + path without trailing slash + query. */
  key: string;
  host: string;
  /** File name (or "pasted text") it came from. */
  source: string;
}

export const ACCEPT = ".xlsx,.xlsm,.xls,.ods,.csv,.tsv,.txt,.json,.xml,.html,.htm,.md,.docx,.odt";

/** XML namespaces and schema hosts that appear inside Office files but are never portals. */
const NOT_PORTALS = /(^|\.)(w3\.org|openxmlformats\.org|schemas\.microsoft\.com|purl\.org|ns\.adobe\.com|openoffice\.org|oasis-open\.org|xmlsoap\.org)$/i;

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s"'<>`{}|\\^[\],;]+/gi;

export function urlsInText(text: string, source: string): FoundUrl[] {
  const out: FoundUrl[] = [];
  // JSON escapes slashes as \/ ; undo it before matching.
  for (const m of text.replace(/\\\//g, "/").matchAll(URL_RE)) {
    let raw = m[0].replace(/[.:!?)'*]+$/, "");
    if (/^www\./i.test(raw)) raw = `https://${raw}`;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol) || !(u.hostname.includes(".") || u.hostname === "localhost") ||NOT_PORTALS.test(u.hostname)) continue;
    // u.host keeps a non-default port, so localhost:4100 and localhost:4300 count as different portals.
    const host = u.host.toLowerCase().replace(/^www\./, "");
    out.push({ url: u.href, key: `${host}${u.pathname.replace(/\/+$/, "")}${u.search}`, host, source });
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? all),
  );
}

/** Text content and link targets of an XML part, without namespace declarations or schema types. */
function xmlStrings(xml: string): string {
  const parts: string[] = [];
  for (const m of xml.matchAll(/\s(?:Target|xlink:href|href)="([^"]*)"/g)) parts.push(m[1]!);
  for (const m of xml.matchAll(/>([^<]+)</g)) parts.push(m[1]!);
  return decodeEntities(parts.join("\n"));
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The XML parts of a ZIP archive (central directory first, so data descriptors do not matter). */
async function zipXmlParts(buf: ArrayBuffer): Promise<string[]> {
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let end = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65_557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(t("imp.badSheet"));
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const texts: string[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count && v.getUint32(p, true) === 0x02014b50; n++) {
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const skip = nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + skip;
    if (!/\.(xml|rels)$/i.test(name)) continue;
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = u8.subarray(start, start + size);
    if (method === 0) texts.push(dec.decode(data));
    else if (method === 8) texts.push(dec.decode(await inflate(data)));
  }
  return texts;
}

export async function urlsInFile(file: File): Promise<FoundUrl[]> {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  // PK\3\4: xlsx, xlsm, ods, docx, odt.
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) {
    return (await zipXmlParts(buf)).flatMap((xml) => urlsInText(xmlStrings(xml), file.name));
  }
  // D0 CF 11 E0: old binary .xls. Its strings are Latin-1 or UTF-16; read the bytes both ways.
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    return [...urlsInText(new TextDecoder("latin1").decode(buf), file.name), ...urlsInText(new TextDecoder("utf-16le").decode(buf), file.name)];
  }
  const text = new TextDecoder().decode(buf);
  return urlsInText(/\.(xml|html?)$/i.test(file.name) ? decodeEntities(text) : text, file.name);
}

/** Keeps the first address for each key, in the order found. */
export function unique(found: FoundUrl[]): FoundUrl[] {
  const seen = new Set<string>();
  return found.filter((f) => !seen.has(f.key) && (seen.add(f.key), true));
}

export function keyOf(url: string): string {
  return urlsInText(url, "")[0]?.key ?? url;
}
