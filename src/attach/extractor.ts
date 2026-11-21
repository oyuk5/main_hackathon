/**
 * The Extractor: runs a Recipe against a portal. Owned by B.
 *
 * Deterministic and model-free: it never touches ctx.llm. All network goes through ctx.http
 * (1 request per second per portal). When a value is unclear it is left null or out.
 *
 * Recipe semantics (see the report in docs or the tests for examples):
 * - list.request.url/body/headers may contain {page}, {offset}, {pageSize}, {today}, {daysAgo:N}.
 *   {today} is today's date (YYYY-MM-DD) in the recipe's timeZone; {daysAgo:N} is N days before it.
 * - list.item is a CSS selector (html, feed) or a JSONPath (jsonApi) over the list page.
 * - Field selectors are relative to the item (list) or the whole page (detail).
 *   `const` may use {field} templates of values extracted so far, plus {today} and {daysAgo:N}.
 * - A field named `withdrawn` is a flag, not a tender field: true, "true", 1 (or any regex match when the
 *   rule has a regex) sets ExtractedTender.withdrawn = true. It is not in diagnostics.fieldFill.
 * - detail.urlFrom is a field name ("url") or a URL template ("https://x/{id}").
 * - documents.hops each yield one URL (const template, css link, jsonPath); files yield all file links.
 */
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { JSONPath } from "jsonpath-plus";
import { MAX_LIST_PAGES, type BrowserStep, type Recipe, type Selector, type FieldRule } from "../shared/recipe.js";
import type { DocumentRef, ExtractedTender, Extractor, FieldFill, PortalContext, ReadOutcome } from "../shared/modules.js";
import {
  absoluteUrl,
  cleanText,
  hasCancelledTitlePrefix,
  isCancellationLabel,
  isStatusLabel,
  mapContractNature,
  mapProcedureType,
  normalizeCpvList,
  normalizePostalCode,
  parseDate,
  parseDateTime,
} from "./normalize.js";
import { browserPages, type PageSource } from "./browser.js";

// ------------------------------------------------------------ limits

const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Staged enrichment: detail and document work per read is bounded, so a first read of a big portal
 * returns in a few minutes and the platform starts serving; later reads (A schedules them 1 min
 * apart while anything is pending) enrich the next batch, and the detail cache makes the ones
 * already done cost nothing. A tender needs 1 to 2 requests (detail page, document list) at 1
 * request per second, so a read stops starting new detail work after 120 tenders or 2 minutes,
 * whichever comes first: the detail part of a read stays at about 2 minutes. Newest tenders (by list publicationDate) go first.
 * Tenders past the budget keep their list values and get `documentRefsPending`.
 */
export const MAX_DETAIL_FETCHES = 120;
export const DETAIL_TIME_BUDGET_MS = 120_000;
/** The live budget; tests lower it. Dry-runs (readSample) are bounded by their own maxItems. */
export const detailBudget = { tenders: MAX_DETAIL_FETCHES, ms: DETAIL_TIME_BUDGET_MS };
/** A progress line every this many tenders of detail work. */
const PROGRESS_EVERY = 25;
const fmt = (n: number) => n.toLocaleString("en-US");
const REQUIRED_FIELDS = ["id", "url", "title", "buyerName", "publicationDate", "submissionDeadline"] as const;

// ------------------------------------------------------------ detail cache

interface CachedDetail {
  hash: string;
  fields: Record<string, unknown>;
  refs: DocumentRef[] | null;
  withdrawn: boolean;
}

/** portalId|detailUrl -> what the detail page and documents gave, keyed by the list item's hash. */
const detailCache = new Map<string, CachedDetail>();

/** For tests. */
export function clearDetailCache(): void {
  detailCache.clear();
}

/** Evicts up to `limit` cached detail entries for `portalId` so regular reads spot-check detail and document links. */
export function evictDetailCacheSample(portalId: string, limit = 3): void {
  let removed = 0;
  const prefix = `${portalId}|`;
  for (const key of detailCache.keys()) {
    if (!key.startsWith(prefix)) continue;
    detailCache.delete(key);
    removed += 1;
    if (removed >= limit) break;
  }
}

// ------------------------------------------------------------ pages and scopes

type Doc =
  | { kind: "markup"; $: CheerioAPI; url: string; raw: string }
  | { kind: "json"; data: unknown; url: string; raw: string };

type Scope =
  | { kind: "markup"; $: CheerioAPI; el: Cheerio<AnyNode>; url: string }
  | { kind: "json"; value: unknown; url: string };

/** One fetched page: over plain HTTP, or rendered in the browser (tier "browser"). */
export interface FetchedPage {
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  text: string;
}
type Page = FetchedPage;

class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

class FetchFailure extends Error {
  constructor(
    message: string,
    readonly cause: "timeout" | "network" | "robots",
  ) {
    super(message);
  }
}

interface ReadState {
  recipe: Recipe;
  ctx: PortalContext;
  requests: number;
  warned: Set<string>;
  limits?: SampleLimits;
  /** Tender pages whose documents rule found nothing: the file-like links they show anyway. */
  docMisses?: string[][];
  /** Tender pages the documents rule ran on. */
  docChecked?: number;
  /** Set for tier "browser": pages come from one rendered browser page instead of ctx.http. */
  pages?: PageSource;
}

/** Limits for a quick dry-run (the Cartographer's sample reads). Regular reads use none. */
export interface SampleLimits {
  maxPages: number;
  /** Tenders to process; later list items are ignored entirely. */
  maxItems: number;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function checkAbort(ctx: PortalContext): void {
  if (ctx.signal.aborted) throw new Cancelled();
}

function warnOnce(st: ReadState, key: string, message: string): void {
  if (st.warned.has(key)) return;
  st.warned.add(key);
  st.ctx.log(message, "warn");
}

/** The declared charset (header, meta tag or XML declaration), or null when the page declares none. */
function charsetOf(contentType: string, bytes: Uint8Array): string | null {
  const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ?? /encoding\s*=\s*["']([\w-]+)/i.exec(head)?.[1] ?? null;
}

export function decode(bytes: Uint8Array, contentType: string): string {
  const charset = charsetOf(contentType, bytes);
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown label: fall through to detection.
    }
  }
  // Nothing declared: UTF-8 if the bytes are valid UTF-8, else the usual legacy Western encoding.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * One request through ctx.http (or one rendered page through the browser for tier "browser") with a
 * time limit. Throws Cancelled or FetchFailure; any HTTP status is returned. `waitFor` is the list
 * item selector, which the browser waits for before taking the page.
 */
async function fetchPage(st: ReadState, url: string, init: RequestInit = {}, waitFor?: string): Promise<Page> {
  const { ctx, pages } = st;
  checkAbort(ctx);
  const timeoutMs = pages?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
  // The browser counts every request its page makes itself.
  if (!pages) st.requests += 1;
  let onAbort: (() => void) | null = null;
  const stop = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // The polite layer may replace our signal with its own; the race keeps the 30 s limit anyway.
  const work = pages ? pages.fetch(url, init, waitFor) : (async () => {
    const res = await ctx.http.fetch(url, { ...init, signal });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "";
    return {
      url: res.url || url,
      status: res.status,
      statusText: res.statusText,
      contentType,
      text: decode(bytes, contentType),
    } satisfies Page;
  })();
  work.catch(() => {});
  stop.catch(() => {});
  try {
    return await Promise.race([work, stop]);
  } catch (e) {
    if (ctx.signal.aborted) throw new Cancelled();
    const msg = e instanceof Error ? e.message : String(e);
    if (signal.aborted || /timeout|timed out/i.test(msg)) throw new FetchFailure(`The portal did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, "timeout");
    if (/robots\.txt|ERR_BLOCKED_BY_CLIENT/i.test(msg)) throw new FetchFailure(/robots\.txt/i.test(msg) ? msg : `robots.txt disallows ${url}`, "robots");
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
    throw new FetchFailure(`${msg}${cause}`, "network");
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function parseDoc(page: Page, tier: Recipe["tier"]): Doc {
  const text = page.text;
  const trimmed = text.trimStart();
  const ct = page.contentType.toLowerCase();
  if (ct.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { kind: "json", data: JSON.parse(text), url: page.url, raw: text };
    } catch {
      // not JSON after all: fall through to markup
    }
  }
  const isXml =
    tier === "feed" ||
    ((ct.includes("xml") || trimmed.startsWith("<?xml")) && !ct.includes("html") && !/<html[\s>]/i.test(trimmed.slice(0, 2000)));
  return { kind: "markup", $: cheerio.load(text, isXml ? { xml: true } : undefined), url: page.url, raw: text };
}

function rootScope(doc: Doc): Scope {
  return doc.kind === "json" ? { kind: "json", value: doc.data, url: doc.url } : { kind: "markup", $: doc.$, el: doc.$.root(), url: doc.url };
}

// ------------------------------------------------------------ text helpers

const BLOCK_TAGS = new Set([
  "br", "p", "div", "li", "td", "th", "tr", "dd", "dt", "dl", "h1", "h2", "h3", "h4", "h5", "h6",
  "section", "article", "table", "thead", "tbody", "ul", "ol", "option", "header", "footer", "label",
]);

/** Text of nodes with spaces between block elements, without script/style. */
function textOfNodes(nodes: Iterable<AnyNode>): string {
  const parts: string[] = [];
  const walk = (n: AnyNode) => {
    if (n.type === "text") {
      parts.push((n as unknown as { data: string }).data);
      return;
    }
    if (n.type === "script" || n.type === "style" || n.type === "comment") return;
    const children = (n as unknown as { children?: AnyNode[] }).children;
    if (!children) return;
    const name = (n as Element).name?.toLowerCase();
    const block = name !== undefined && BLOCK_TAGS.has(name);
    if (block) parts.push(" ");
    for (const c of children) walk(c);
    if (block) parts.push(" ");
  };
  for (const n of nodes) walk(n);
  return parts.join("").replace(/\s+/g, " ").trim();
}

function textOf(el: Cheerio<AnyNode>): string {
  return textOfNodes(el.toArray());
}

/** Direct text children only. */
function ownText(el: Element): string {
  return el.children
    .filter((c) => c.type === "text")
    .map((c) => (c as unknown as { data: string }).data)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function normLabel(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/\s*[:：]\s*$/, "").toLowerCase();
}

function jsonLeaves(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) jsonLeaves(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) jsonLeaves(x, out, depth + 1);
  return out;
}

/** Elements whose text is never a tender's own status: form controls and scripts. */
const NOT_A_LABEL = new Set(["option", "select", "button", "script", "style", "input", "textarea"]);

/**
 * A JSON item whose status key says cancelled: `"status": "CANCELLED"`, or `"status": {"label": "Annulé"}`.
 * Only status-like keys count; other values (a description that mentions a cancellation) never do.
 */
function jsonStatusCancelled(v: unknown, depth = 0): boolean {
  if (depth > 3 || !v || typeof v !== "object") return false;
  if (Array.isArray(v)) return false;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (isStatusLabel(key)) {
      if (isCancellationLabel(value)) return true;
      if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).some((x) => isCancellationLabel(x))) return true;
    } else if (value && typeof value === "object" && jsonStatusCancelled(value, depth + 1)) return true;
  }
  return false;
}

/**
 * A list row that carries a short cancellation label of its own: a status cell or a badge whose whole
 * text is "Widerrufen" or "Annulleret". Sentences in the row never count.
 */
function rowHasCancellationLabel(scope: Scope): boolean {
  if (scope.kind === "json") return jsonStatusCancelled(scope.value);
  let found = false;
  scope.el.find("*").each((_i, node) => {
    const el = node as Element;
    if (found || NOT_A_LABEL.has(el.name?.toLowerCase() ?? "")) return;
    // Only innermost elements: their text is one label, not a whole row.
    if (el.children.some((c) => c.type === "tag")) return;
    if (isCancellationLabel(textOfNodes([el]))) found = true;
  });
  return found;
}

/**
 * The tender's own page states a cancelled status beside a status label: `<tr><th>Status</th><td>Widerrufen</td>`,
 * `<dt>Stav</dt><dd>Zrušeno</dd>`, or one element reading "Status: Annulleret". Page boilerplate never counts.
 */
function pageStatusCancelled(scope: Scope): boolean {
  if (scope.kind === "json") return jsonStatusCancelled(scope.value);
  const $ = scope.$;
  let found = false;
  scope.el.find("tr, dt").each((_i, node) => {
    if (found) return;
    const row = $(node);
    const label = row.is("dt") ? row.text() : row.children("th, td").first().text();
    const value = row.is("dt") ? row.nextAll("dd").first().text() : row.children("th, td").eq(1).text();
    if (isStatusLabel(label) && isCancellationLabel(value)) found = true;
  });
  if (found) return true;
  scope.el.find("*").each((_i, node) => {
    const el = node as Element;
    if (found || NOT_A_LABEL.has(el.name?.toLowerCase() ?? "") || el.children.some((c) => c.type === "tag")) return;
    const m = /^([^:：]{2,40})[:：]\s*(.+)$/.exec(textOfNodes([el]));
    if (m && isStatusLabel(m[1]) && isCancellationLabel(m[2])) found = true;
  });
  return found;
}

function scopeText(scope: Scope): string {
  return scope.kind === "json" ? jsonLeaves(scope.value).join(" ") : textOf(scope.el);
}

// ------------------------------------------------------------ templates

type Values = Record<string, unknown>;

/**
 * Calendar date in `zone`, `daysAgo` days before today, as YYYY-MM-DD. Uses Intl, never toISOString(),
 * so the date flips at local midnight of the portal, not at UTC midnight.
 */
export function localDate(zone: string, daysAgo = 0, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // Pure calendar arithmetic on a UTC noon anchor; no instant is formatted in UTC for output.
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day") - daysAgo, 12));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const DATE_PLACEHOLDER = /^(?:today|daysAgo:(\d{1,4}))$/;

/** Value of {today} / {daysAgo:N}, or null when `name` is not a date placeholder. */
function datePlaceholder(name: string, zone: string): string | null {
  const m = DATE_PLACEHOLDER.exec(name);
  if (!m) return null;
  return localDate(zone, m[1] === undefined ? 0 : Number(m[1]));
}

function templateValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? v.map(String).join(",") : null;
  if (typeof v === "object") return null;
  const s = String(v);
  return s === "" ? null : s;
}

/** Replaces {name} with values, and {today} / {daysAgo:N} with dates in `zone`. Returns null when a placeholder has no value. */
function fillTemplate(template: string, values: Values, encode: boolean, zone: string): string | null {
  let missing = false;
  const out = template.replace(/\{([\w.]+(?::\d+)?)\}/g, (_, name: string) => {
    const v = templateValue(values[name]) ?? datePlaceholder(name, zone);
    if (v === null) {
      missing = true;
      return "";
    }
    return encode ? encodeURIComponent(v) : v;
  });
  return missing ? null : out;
}

// ------------------------------------------------------------ selectors

function jsonQuery(path: string, json: unknown): unknown[] {
  if (json === null || typeof json !== "object") return path.trim() === "$" ? [json] : [];
  const r = JSONPath({ path, json: json as object, wrap: true }) as unknown;
  return Array.isArray(r) ? r : [];
}

function findCss(scope: Extract<Scope, { kind: "markup" }>, css: string): Cheerio<AnyNode> {
  const c = css.trim();
  if (c === "" || c === ":scope" || c === ".") return scope.el;
  const found = scope.el.find(c);
  if (found.length > 0) return found;
  // The selector may describe the item itself, e.g. item "a.tender" and css "a".
  return scope.el.toArray().some((n) => n.type === "tag") && scope.el.is(c) ? scope.el : found;
}

function valueOfElement(scope: Extract<Scope, { kind: "markup" }>, el: Cheerio<AnyNode>, attr: string | undefined): string | null {
  if (attr) {
    const own = el.attr(attr);
    if (own !== undefined) return own;
    const inner = el.find(`[${attr}]`).first().attr(attr);
    return inner ?? null;
  }
  const t = textOf(el);
  return t === "" ? null : t;
}

/** Value next to a label: inline after the colon, dd after dt, next cell, following text, next element. */
function labelValues(scope: Extract<Scope, { kind: "markup" }>, label: string, within: Cheerio<AnyNode>, attr: string | undefined): string[] {
  const $ = scope.$;
  const want = normLabel(label);
  if (!want) return [];
  const out: string[] = [];
  const candidates = within.find("*").toArray().filter((n): n is Element => n.type === "tag");
  for (const cand of candidates) {
    const own = normLabel(ownText(cand));
    if (own !== want && !(own.startsWith(want) && /^\s*[:：]/.test(own.slice(want.length)))) continue;
    let node: Element | null = cand;
    for (let depth = 0; node && depth < 3; depth++) {
      const v = valueAfterLabel($, node, want, attr);
      if (v !== null) {
        out.push(v);
        break;
      }
      // The label may be wrapped (<td><b>Frist</b></td>): retry from the wrapper if it holds only the label.
      const parent: Element | null = node.parent && node.parent.type === "tag" ? (node.parent as Element) : null;
      if (!parent || !within.find(parent).length || normLabel(textOf($(parent))) !== want) break;
      node = parent;
    }
    if (out.length) break;
  }
  return out;
}

function valueAfterLabel($: CheerioAPI, node: Element, want: string, attr: string | undefined): string | null {
  const el = $(node);
  const nonEmpty = (s: string | null | undefined) => (s && s.trim() !== "" ? s.trim() : null);
  const pick = (target: Cheerio<AnyNode>): string | null => {
    if (!target.length) return null;
    if (attr) return nonEmpty(target.attr(attr) ?? target.find(`[${attr}]`).first().attr(attr));
    return nonEmpty(textOf(target));
  };
  // 1. Inline: "Frist: 12.03.2026" inside the label element itself.
  if (!attr) {
    const full = textOf(el);
    const lower = full.toLowerCase();
    if (lower.startsWith(want) && full.length > want.length) {
      const rest = full.slice(want.length).replace(/^\s*[:：\-–]?\s*/, "");
      if (rest !== "") return rest;
    }
  } else {
    const inner = el.find(`[${attr}]`).first().attr(attr);
    if (inner) return inner;
  }
  const tag = node.name.toLowerCase();
  // 2. Definition list.
  if (tag === "dt") return pick(el.nextAll("dd").first());
  // 3. Table row.
  if (tag === "th" || tag === "td") return pick(el.nextAll("td,th").first());
  // 4. Text right after the label, before the next element: "<b>Frist:</b> 12.03.2026".
  if (!attr) {
    const texts: AnyNode[] = [];
    for (let s = node.next; s && s.type !== "tag"; s = s.next) texts.push(s);
    const t = nonEmpty(textOfNodes(texts));
    if (t) return t;
  }
  // 5. Next element.
  return pick(el.next());
}

/** Raw values a selector yields in a scope (strings for markup, any JSON value for json). */
function resolveSelector(st: ReadState, sel: Selector, scope: Scope, values: Values, opts: { defaultAttr?: string; all?: boolean } = {}): unknown[] {
  const all = opts.all ?? sel.all ?? false;
  let raw: unknown[] = [];
  if (sel.const !== undefined) {
    const v = fillTemplate(sel.const, values, false, st.recipe.timeZone);
    raw = v === null ? [] : [v];
  } else if (sel.jsonPath !== undefined) {
    if (scope.kind === "json") raw = jsonQuery(sel.jsonPath, scope.value);
  } else if (scope.kind === "markup" && (sel.label !== undefined || sel.css !== undefined)) {
    if (sel.label !== undefined) {
      const within = sel.css ? findCss(scope, sel.css) : scope.el;
      raw = labelValues(scope, sel.label, within, sel.attr);
    } else {
      const els = findCss(scope, sel.css!);
      const attr = sel.attr ?? opts.defaultAttr;
      for (const n of els.toArray()) {
        const el = scope.$(n);
        let v = valueOfElement(scope, el, attr);
        if (v === null && attr && !sel.attr) v = valueOfElement(scope, el, undefined);
        if (v !== null) raw.push(v);
        if (!all && raw.length) break;
      }
    }
  } else if (sel.regex !== undefined) {
    // Regex alone runs over the whole scope's text.
    raw = [scopeText(scope)];
  }
  raw = raw.filter((v) => v !== null && v !== undefined);
  if (sel.regex !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(sel.regex, "u");
    } catch {
      try {
        re = new RegExp(sel.regex);
      } catch {
        warnOnce(st, `regex:${sel.regex}`, `The recipe has an invalid regex: ${sel.regex}.`);
        return [];
      }
    }
    const out: unknown[] = [];
    for (const v of raw) {
      if (v === null || typeof v === "object") continue;
      const m = re.exec(String(v));
      if (m) out.push(m[1] ?? m[0]);
    }
    raw = out;
  }
  return all ? raw : raw.slice(0, 1);
}

// ------------------------------------------------------------ fields

type ParseKind = NonNullable<FieldRule["parse"]>;

function defaultParse(field: string): ParseKind | "countryCode" {
  const leaf = field.startsWith("placeOfPerformance.") ? field.slice("placeOfPerformance.".length) : field;
  switch (leaf) {
    case "publicationDate":
      return "date";
    case "submissionDeadline":
      return "datetime";
    case "url":
      return "url";
    case "cpvCodes":
      return "cpv";
    case "procedureType":
      return "procedureType";
    case "contractNature":
      return "contractNature";
    case "postalCode":
      return "postalCode";
    case "countryCode":
      return "countryCode";
    default:
      return "text";
  }
}

function asParseInput(v: unknown): unknown {
  return typeof v === "boolean" ? String(v) : v;
}

function parseOne(kind: ParseKind | "countryCode", v: unknown, rule: FieldRule, recipe: Recipe, base: string): unknown {
  v = asParseInput(v);
  switch (kind) {
    case "text":
      return cleanText(v);
    case "date":
      return parseDate(typeof v === "number" ? String(v) : v, rule.format);
    case "datetime":
      return parseDateTime(v, recipe.timeZone, rule.format);
    case "url":
      return absoluteUrl(typeof v === "string" ? v.trim() : v, base);
    case "procedureType":
      return mapProcedureType(v) ?? null;
    case "contractNature":
      return mapContractNature(v) ?? null;
    case "postalCode":
      return normalizePostalCode(typeof v === "number" ? String(v) : v);
    case "countryCode": {
      const s = cleanText(v)?.toUpperCase() ?? null;
      return s && /^[A-Z]{2}$/.test(s) ? s : null;
    }
    case "cpv":
      return normalizeCpvList(v);
  }
}

function parseField(field: string, rule: FieldRule, raws: unknown[], recipe: Recipe, base: string): unknown {
  // A model may select the right date cell but label its parser as text or date.
  // Normalize the required date fields before Watch sees them, not after publication.
  const kind = field === "publicationDate" || field === "submissionDeadline" ? defaultParse(field) : rule.parse ?? defaultParse(field);
  if (kind === "cpv") {
    const out: string[] = [];
    for (const r of raws) for (const c of normalizeCpvList(r)) if (!out.includes(c)) out.push(c);
    return out;
  }
  const prims = raws.filter((r) => r !== null && typeof r !== "object");
  if (kind === "text" && rule.all) return cleanText(prims.map(String).join(" "));
  for (const r of prims) {
    const v = parseOne(kind, r, rule, recipe, base);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** The `withdrawn` flag rule: only clear yes-values count; anything else leaves the tender as is. */
const WITHDRAWN_FIELD = "withdrawn";

function withdrawnFlag(rule: FieldRule, raws: unknown[]): true | null {
  for (const r of raws) {
    if (r === true || r === 1) return true;
    if (typeof r !== "string") continue;
    const s = r.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    // With a regex, the match itself is the signal (e.g. regex "Aufgehoben" over a status cell).
    if (rule.regex !== undefined && s !== "") return true;
    // A rule over the status text itself ("Widerrufen", "Annulleret") counts without a regex.
    if (isCancellationLabel(r)) return true;
  }
  return null;
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

/** Applies field rules in a scope. Const rules run last so their templates can use the other fields. */
function extractFields(st: ReadState, rules: Record<string, FieldRule>, scope: Scope, base: Values): Values {
  const out: Values = {};
  const entries = Object.entries(rules);
  const ordered = [...entries.filter(([, r]) => r.const === undefined), ...entries.filter(([, r]) => r.const !== undefined)];
  for (const [field, rule] of ordered) {
    try {
      const raws = resolveSelector(st, rule, scope, { ...base, ...out });
      out[field] = field === WITHDRAWN_FIELD ? withdrawnFlag(rule, raws) : parseField(field, rule, raws, st.recipe, scope.url);
    } catch (e) {
      out[field] = null;
      warnOnce(st, `field:${field}`, `Field ${field} could not be read: ${e instanceof Error ? e.message : String(e)}.`);
    }
  }
  return out;
}

// ------------------------------------------------------------ list pages

interface ListItem {
  scope: Scope;
  raw: string;
  values: Values;
}

function itemsOf(st: ReadState, doc: Doc): Scope[] {
  const path = st.recipe.list.item;
  try {
    if (doc.kind === "json") {
      let items = jsonQuery(path, doc.data);
      if (items.length === 1 && Array.isArray(items[0])) items = items[0] as unknown[];
      return items.map((value) => ({ kind: "json", value, url: doc.url }));
    }
    return doc
      .$(path)
      .toArray()
      .map((n) => ({ kind: "markup", $: doc.$, el: doc.$(n), url: doc.url }));
  } catch (e) {
    warnOnce(st, "item", `The item selector could not be applied: ${e instanceof Error ? e.message : String(e)}.`);
    return [];
  }
}

function rawOf(scope: Scope): string {
  return scope.kind === "json" ? JSON.stringify(scope.value) ?? "null" : scope.$.html(scope.el);
}

// ------------------------------------------------------------ skeleton

function tagSig(el: Element): string {
  const cls = (el.attribs?.class ?? "").split(/\s+/).filter(Boolean).sort().join(".");
  return cls ? `${el.name}.${cls}` : el.name;
}

function subtreeSig(el: Element, depth = 0): string {
  if (depth > 30) return tagSig(el);
  const kids: string[] = [];
  for (const c of el.children) {
    if (c.type !== "tag" && c.type !== "script" && c.type !== "style") continue;
    const s = subtreeSig(c as Element, depth + 1);
    // Repeated siblings (rows, list entries) collapse to one, so counts don't change the hash.
    if (kids[kids.length - 1] !== s) kids.push(s);
  }
  return kids.length ? `${tagSig(el)}(${kids.join(",")})` : tagSig(el);
}

function jsonKeyPaths(v: unknown, prefix: string, out: Set<string>, depth = 0): void {
  if (depth > 12) return;
  if (Array.isArray(v)) {
    out.add(`${prefix}[]`);
    if (v.length) jsonKeyPaths(v[0], `${prefix}[]`, out, depth + 1);
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const p = `${prefix}.${k}`;
      out.add(p);
      jsonKeyPaths(x, p, out, depth + 1);
    }
  }
}

/** Structure only (tags, classes, key names), no text: stable when only content changes. */
function skeletonHash(recipe: Recipe, first: Scope | undefined): string | undefined {
  if (!first) return undefined;
  if (first.kind === "json") {
    const paths = new Set<string>();
    jsonKeyPaths(first.value, "$", paths);
    return sha256(`json|${recipe.list.item}|${[...paths].sort().join("\n")}`);
  }
  const node = first.el.get(0);
  if (!node || node.type !== "tag") return undefined;
  const el = node as Element;
  const ancestors = first.el
    .parents()
    .toArray()
    .filter((n): n is Element => n.type === "tag")
    .reverse()
    .map(tagSig)
    .join(">");
  return sha256(`markup|${recipe.list.item}|${ancestors}|${subtreeSig(el)}`);
}

// ------------------------------------------------------------ blocks and empty state

function blockReason(doc: Doc): string | null {
  if (doc.kind !== "markup") return null;
  const $ = doc.$;
  if ($('input[type="password" i]').length) return "The list page shows a login form instead of tenders: reading it needs a login.";
  const widget =
    '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], ' +
    'iframe[src*="turnstile"], iframe[src*="challenges.cloudflare"], script[src*="recaptcha"], script[src*="hcaptcha"], script[src*="turnstile"]';
  const formMentions = $("form")
    .toArray()
    .some((f) => /captcha/i.test($.html(f)));
  if ($(widget).length || formMentions) return "The list page shows a captcha instead of tenders; we do not solve captchas.";
  return null;
}

/** Page chrome: a "no results" text in a search box, menu or footer says nothing about the list. */
const CHROME = "header, nav, footer, [role=banner], [role=navigation], [role=contentinfo], [role=search], script, style, noscript, template";

function findEmptyText(recipe: Recipe, doc: Doc): string | undefined {
  let pageText: string;
  if (doc.kind === "json") pageText = doc.raw.replace(/\s+/g, " ");
  else {
    const $c = cheerio.load(doc.$.html(), recipe.tier === "feed" ? { xml: true } : undefined);
    $c(CHROME).remove();
    pageText = textOf($c.root());
  }
  const lower = pageText.toLowerCase();
  for (const t of recipe.list.emptyText ?? []) {
    const want = t.replace(/\s+/g, " ").trim().toLowerCase();
    if (!want) continue;
    const i = lower.indexOf(want);
    if (i < 0) continue;
    // Return the words as the page shows them when the case mapping kept lengths.
    return lower.length === pageText.length ? pageText.slice(i, i + want.length) : t.trim();
  }
  // An attach learns on a full list, so it rarely sees the portal's own "nothing today" message.
  // For JSON feeds/APIs, an explicitly empty array at the configured item path (while the container
  // key still exists) means "0 tenders today", distinct from a renamed key where the path disappears.
  if (doc.kind === "json") {
    const itemPath = recipe.list.item.trim();
    if (itemPath === "$" || itemPath === "$[*]") {
      if (Array.isArray(doc.data) && doc.data.length === 0) return "Empty list (0 items)";
    } else if (!/\[\?\(/.test(itemPath) && itemPath.endsWith("[*]")) {
      try {
        const containers = jsonQuery(itemPath.slice(0, -3), doc.data);
        if (containers.length === 1 && Array.isArray(containers[0]) && containers[0].length === 0) {
          return "Empty list (0 items)";
        }
      } catch {
        // invalid path: fall through so regular diagnostics handle it
      }
    }
    return undefined;
  }
  // Fall back to common wording, only on a page with no list items, outside the page chrome, and
  // only when the page is short: a long page with 0 items more likely means the list rule broke.
  if (pageText.length <= GENERIC_EMPTY_MAX_PAGE_CHARS) {
    const m = GENERIC_EMPTY.exec(pageText);
    if (m) return m[0].trim();
  }
  return undefined;
}

const GENERIC_EMPTY_MAX_PAGE_CHARS = 3000;

/** "No tenders / no results right now" in the languages of European portals. A sentence-sized match. */
export const GENERIC_EMPTY = new RegExp(
  [
    String.raw`\bbrak (aktualnych |żadnych )?(przetargów|ogłoszeń|postępowań|zamówień|wyników)[^.!\n]{0,40}`,
    String.raw`\b(keine|derzeit keine|zurzeit keine) (aktuellen |laufenden )?(ausschreibungen|vergaben|bekanntmachungen|ergebnisse|einträge|treffer)[^.!\n]{0,40}`,
    String.raw`\b(aucun|aucune) (appel d'offres|appels d'offres|avis|consultation|marché|résultat|annonce)s?[^.!\n]{0,40}`,
    String.raw`\b(geen|er zijn geen) (aanbestedingen|resultaten|opdrachten|publicaties)[^.!\n]{0,40}`,
    String.raw`\bno (hay|existen|se han encontrado) (licitaciones|resultados|anuncios|contratos)[^.!\n]{0,40}`,
    String.raw`\bnessun[oa]? (gara|gare|bando|bandi|risultato|avviso)[^.!\n]{0,40}`,
    String.raw`\b(ingen|inga) (udbud|upphandlingar|anbud|resultater|resultat|träffar)[^.!\n]{0,40}`,
    String.raw`\bnão (há|existem|foram encontrad[oa]s) (concursos|procedimentos|resultados|anúncios)[^.!\n]{0,40}`,
    String.raw`\bžádné (zakázky|výsledky)[^.!\n]{0,40}`,
    String.raw`\bno (open |current |active )?(tenders|notices|opportunities|results|contracts)( found| available| at the moment| right now| to display)[^.!\n]{0,40}`,
    String.raw`\bthere are (currently )?no (open |current |active )?(tenders|notices|opportunities|contracts)[^.!\n]{0,40}`,
  ].join("|"),
  "iu",
);

const STATUS_TEXT: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  410: "Gone",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function statusLabel(p: Page): string {
  return `${p.status} ${p.statusText || STATUS_TEXT[p.status] || ""}`.trim();
}

/** Classifies a failed first list page. */
function firstPageProblem(p: Page): ReadOutcome | null {
  if (p.status >= 200 && p.status < 300) return null;
  if (p.status === 401) return { kind: "blocked", reason: "The portal answers 401 Unauthorized: the list needs a login." };
  if (p.status === 403) return { kind: "blocked", reason: "The portal answers 403 Forbidden: access needs a login or is refused." };
  if ((p.status === 429 || p.status === 503) && /challenge-platform|cf-chl|cf_chl|captcha/i.test(p.text)) {
    return { kind: "blocked", reason: `The portal answers ${statusLabel(p)} with a bot check (captcha); we do not solve captchas.` };
  }
  if (p.status === 429 || p.status >= 500) {
    return { kind: "unreachable", reason: `The portal answers ${statusLabel(p)}; trying again later.`, httpStatus: p.status };
  }
  return { kind: "error", reason: `The list page answers ${statusLabel(p)}; the list address in the recipe may be wrong.` };
}

// ------------------------------------------------------------ list request

function listRequest(recipe: Recipe, ctx: PortalContext, index: number, cursor: string | null = null): { url: string; init: RequestInit } {
  const pg = recipe.list.pagination;
  const vars: Values = {
    page: (pg.type === "pageParam" ? (pg.start ?? 1) : 1) + (pg.type === "pageParam" ? index : 0),
    offset: pg.type === "offsetParam" ? index * pg.pageSize : 0,
    pageSize: pg.type === "offsetParam" ? pg.pageSize : "",
    cursor: cursor ?? "",
  };
  const fill = (s: string, encode: boolean) => s.replace(/\{(page|offset|pageSize|cursor|today|daysAgo:\d{1,4})\}/g, (_, k: string) => {
    const v = datePlaceholder(k, recipe.timeZone) ?? String(vars[k] ?? "");
    return encode ? encodeURIComponent(v) : v;
  });
  const req = recipe.list.request;
  const url = new URL(fill(req.url, true), ctx.url).href;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = fill(v, false);
  const init: RequestInit = { method: req.method ?? "GET", headers };
  if (req.body !== undefined && (req.method ?? "GET") === "POST") {
    // A quoted "{cursor}" in a JSON body is a JSON value: null on the first page, then the cursor as a string.
    init.body = fill(req.body.replace(/"\{cursor\}"/g, () => (cursor === null ? "null" : JSON.stringify(cursor))), false);
  }
  return { url, init };
}

// ------------------------------------------------------------ documents

function looksLikeFileName(s: string): boolean {
  return s.length <= 200 && /\.[a-z0-9]{2,5}$/i.test(s);
}

async function documentRefs(st: ReadState, start: Doc, values: Values, count = true): Promise<DocumentRef[]> {
  const rule = st.recipe.documents!;
  const via = rule.via ?? "http";
  let doc = start;
  for (const hop of rule.hops ?? []) {
    checkAbort(st.ctx);
    const next = resolveSelector(st, hop, rootScope(doc), values, { defaultAttr: "href", all: false })[0];
    const url = typeof next === "string" ? absoluteUrl(next.trim(), doc.url) : null;
    if (!url) return [];
    const page = await fetchPage(st, url);
    if (page.status < 200 || page.status >= 300) throw new Error(`document page answers ${statusLabel(page)}`);
    doc = parseDoc(page, st.recipe.tier);
  }
  const files = rule.files;
  const refs: DocumentRef[] = [];
  const add = (href: unknown, hint?: string | null) => {
    const url = typeof href === "string" ? absoluteUrl(href.trim(), doc.url) : null;
    if (!url || refs.some((r) => r.url === url)) return;
    const ref: DocumentRef = { url, via };
    if (hint) ref.fileNameHint = hint;
    refs.push(ref);
  };
  if (doc.kind === "markup" && files.css !== undefined && files.label === undefined && files.const === undefined) {
    const scope = rootScope(doc) as Extract<Scope, { kind: "markup" }>;
    for (const [index, n] of findCss(scope, files.css).toArray().entries()) {
      checkAbort(st.ctx);
      const el = doc.$(n);
      const attr = files.attr ?? "href";
      let href: string | null = el.attr(attr) ?? el.find(`[${attr}]`).first().attr(attr) ?? null;
      // Browser tier: a file button with no real address (javascript:, "#", none) is clicked on its page.
      if (st.pages && !files.regex && (href === null || /^\s*(#|javascript:|$)/i.test(href))) {
        const clickPath = [`${files.css} >> nth=${index}`];
        if (refs.some((r) => r.url === doc.url && r.clickPath?.[0] === clickPath[0])) continue;
        const ref: DocumentRef = { url: doc.url, via: "browser", clickPath };
        const text = cleanText(textOf(el));
        if (text && looksLikeFileName(text)) ref.fileNameHint = text;
        refs.push(ref);
        continue;
      }
      if (href !== null && files.regex) {
        const m = new RegExp(files.regex).exec(href);
        href = m ? (m[1] ?? m[0]) : null;
      }
      const download = cleanText(el.attr("download") ?? el.find("[download]").first().attr("download"));
      const text = cleanText(textOf(el));
      add(href, download && looksLikeFileName(download) ? download : text && looksLikeFileName(text) ? text : null);
    }
  } else {
    for (const v of resolveSelector(st, files, rootScope(doc), values, { defaultAttr: "href", all: true })) add(v);
  }
  if (!count) return refs;
  st.docChecked = (st.docChecked ?? 0) + 1;
  if (refs.length === 0 && doc.kind === "markup") (st.docMisses ??= []).push(fileLikeLinks(doc));
  return refs;
}

const FILE_HREF = /\.(pdf|zip|7z|rar|docx?|xlsx?|odt|ods|rtf|gaeb|x8[0-9]|d8[0-9])(?:[?#]|$)|\/(download|file|files|attachment|dokument|document)s?\b/i;

/** File-like links on a page outside its chrome (header, menu, footer), as absolute URLs. */
function fileLikeLinks(doc: Extract<Doc, { kind: "markup" }>): string[] {
  const $c = cheerio.load(doc.$.html());
  $c(CHROME).remove();
  const out = new Set<string>();
  $c("a[href]").each((_, el) => {
    const href = $c(el).attr("href") ?? "";
    if (!FILE_HREF.test(href)) return;
    const abs = absoluteUrl(href.trim(), doc.url);
    if (abs) out.add(abs);
  });
  return [...out];
}

/**
 * A documents rule that misses files the tender pages plainly show: an error, so the read is repaired
 * instead of serving tenders without their files. Links that every such page shows (a help PDF, terms)
 * are site-wide and do not count.
 */
function documentsRuleProblem(st: ReadState): string | null {
  const misses = st.docMisses ?? [];
  const checked = st.docChecked ?? 0;
  if (checked < 3 || misses.length < Math.max(3, Math.ceil(checked / 2))) return null;
  const everywhere = misses.reduce<Set<string>>((acc, links, i) => (i === 0 ? new Set(links) : new Set(links.filter((l) => acc.has(l)))), new Set());
  const showing = misses.filter((links) => links.some((l) => !everywhere.has(l))).length;
  if (showing < Math.max(3, Math.ceil(checked / 2))) return null;
  return `Tender pages show file links, but the documents rule found none on ${showing} of ${checked} tenders; the documents rule needs fixing.`;
}

/** Labels of finished procedures (results, not calls for tenders). Short labels only, never long text. */
const AWARD_NOTICE = new RegExp(
  [
    "contract award notice", "award notice", "notice of award",
    "bekanntmachung vergebener auftr", "vergebene auftr", "vergebener auftrag", "ex-post-bekanntmachung",
    "avis d'attribution", "avis d\u2019attribution", "avis d attribution",
    "anuncio de adjudicaci", "anuncio de formalizaci",
    "aankondiging van een gegunde opdracht", "gegunde opdracht",
    "ogłoszenie o udzieleniu zamówienia", "ogłoszenie o wyniku postępowania",
    "avviso di aggiudicazione", "esito di gara",
  ].join("|"),
  "i",
);

/** True when a short label of the list item (≤ 80 characters) says it is an award notice. */
function isAwardNotice(scope: Scope, values: Values): boolean {
  const labels: string[] = [];
  const title = cleanText(templateValue(values.title));
  if (title) labels.push(title);
  if (scope.kind === "json") labels.push(...jsonLeaves(scope.value).filter((t) => t.length <= 80));
  else
    scope.el
      .find("*")
      .addBack()
      .each((_, n) => {
        const t = cleanText(ownText(n as Element));
        if (t && t.length <= 80) labels.push(t);
      });
  return labels.some((l) => AWARD_NOTICE.test(l));
}

// ------------------------------------------------------------ the read

async function run(st: ReadState, started: number): Promise<ReadOutcome> {
  const { recipe, ctx } = st;
  const pg = recipe.list.pagination;
  // Clicking "next" needs the browser: other tiers read the first page only.
  const clicks = pg.type === "clickNext" && st.pages !== undefined;
  const recipeMaxPages = pg.type === "none" ? 1 : pg.type === "clickNext" && !clicks ? 1 : Math.min(MAX_LIST_PAGES, Math.max(1, pg.maxPages ?? MAX_LIST_PAGES));
  const maxPages = Math.min(recipeMaxPages, st.limits?.maxPages ?? recipeMaxPages);
  if (pg.type === "clickNext" && !clicks) ctx.log("This recipe pages by clicking, which needs the browser; reading the first page only.", "warn");
  const itemsKey = (html: string) =>
    itemsOf(st, parseDoc({ url: "", status: 200, statusText: "", contentType: "text/html", text: html }, recipe.tier))
      .map(rawOf)
      .join("\n");

  const items: ListItem[] = [];
  const seenKeys = new Set<string>();
  const visited = new Set<string>();
  let listPages = 0;
  let itemsSeen = 0;
  let listSkeletonHash: string | undefined;
  let emptyStateText: string | undefined;
  let nextUrl: string | null = null;
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  for (let i = 0; i < maxPages; i++) {
    checkAbort(ctx);
    if (pg.type === "cursor" && i > 0 && cursor === null) break;
    let req = listRequest(recipe, ctx, i, cursor);
    if (pg.type === "nextLink" && i > 0) {
      if (!nextUrl) break;
      req = { url: nextUrl, init: { method: "GET", headers: req.init.headers } };
    }
    const clicking = clicks && i > 0;
    if (!clicking) {
      if (visited.has(req.url) && req.init.method === "GET") break;
      visited.add(req.url);
    }

    let page: Page;
    try {
      if (clicking) {
        const next = await st.pages!.clickNext((pg as Extract<typeof pg, { type: "clickNext" }>).selector, itemsKey);
        if (!next) break;
        page = next;
      } else page = await fetchPage(st, req.url, req.init, st.pages ? recipe.list.item : undefined);
    } catch (e) {
      if (e instanceof Cancelled || ctx.signal.aborted) throw new Cancelled();
      if (i > 0) {
        // A list read halfway must not look complete: missing tenders would be closed. Retry later.
        return { kind: "unreachable", reason: `List page ${i + 1} could not be read (${(e as Error).message}), so this read is incomplete.` };
      }
      const f = e as FetchFailure;
      // A recipe step that no longer fits the page is a broken recipe (repair), not a portal that is down.
      if (/list\.before step \d+/.test(f.message ?? "")) return { kind: "error", reason: `The recipe's search steps no longer fit the page: ${f.message}.` };
      if (f.cause === "robots") return { kind: "blocked", reason: "The portal's robots.txt does not allow reading the list page." };
      if (f.cause === "timeout") return { kind: "unreachable", reason: f.message };
      return { kind: "unreachable", reason: `The portal could not be reached: ${f.message}.` };
    }
    if (i === 0) {
      const problem = firstPageProblem(page);
      if (problem) return problem;
    } else if (page.status < 200 || page.status >= 300) {
      if (page.status === 404 || page.status === 410) {
        // Many portals answer 404 past their last page: that is the end of the list.
        ctx.log(`List page ${i + 1} answers ${statusLabel(page)}; taking that as the end of the list.`);
        break;
      }
      const reason = `List page ${i + 1} answers ${statusLabel(page)}, so this read is incomplete.`;
      if (page.status >= 500 || page.status === 429 || page.status === 408) return { kind: "unreachable", reason, httpStatus: page.status };
      return { kind: "error", reason };
    }
    listPages += 1;
    const doc = parseDoc(page, recipe.tier);
    const scopes = itemsOf(st, doc);
    itemsSeen += scopes.length;
    if (i === 0) {
      listSkeletonHash = skeletonHash(recipe, scopes[0]);
      if (scopes.length === 0) {
        const blocked = blockReason(doc);
        if (blocked) return { kind: "blocked", reason: blocked };
        emptyStateText = findEmptyText(recipe, doc);
      }
    }
    if (scopes.length === 0) break;

    let fresh = 0;
    for (const scope of scopes) {
      checkAbort(ctx);
      const raw = rawOf(scope);
      const values = extractFields(st, recipe.listFields, scope, {});
      const key = templateValue(values.id) ?? templateValue(values.url) ?? `raw:${sha256(raw)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      fresh += 1;
      items.push({ scope, raw, values });
    }
    if (fresh === 0) break;

    if (pg.type === "nextLink") {
      const next = resolveSelector(st, pg.selector, rootScope(doc), {}, { defaultAttr: "href", all: false })[0];
      nextUrl = typeof next === "string" ? absoluteUrl(next.trim(), doc.url) : null;
    }
    if (pg.type === "cursor") {
      const next = resolveSelector(st, pg.next, rootScope(doc), {}, { all: false })[0];
      const value = typeof next === "number" && Number.isFinite(next) ? String(next) : typeof next === "string" ? next.trim() : "";
      // No cursor, or one we already sent: the list ends here.
      cursor = value !== "" && !seenCursors.has(value) ? value : null;
      if (cursor !== null) seenCursors.add(cursor);
    }
  }

  // Detail pages and documents, newest first within the per-read budget (see detailBudget).
  const done: { index: number; tender: ExtractedTender; values: Values; deferred: boolean }[] = [];
  const ids = new Set<string>();
  let dropped = 0;
  let missingTenderUrls = 0;
  let awards = 0;
  const recipeKey = sha256(JSON.stringify([recipe.detail, recipe.documents, recipe.timeZone, recipe.withdrawnText, recipe.listFields[WITHDRAWN_FIELD] ?? null]));
  const detailStart = Date.now();
  let fetched = 0; // tenders whose detail work ran in this read
  let enriched = 0; // ... plus those served from the detail cache
  let deferredCount = 0;
  // At least one tender per read gets its detail work, so every read makes progress.
  const budgetLeft = () => st.limits !== undefined || (fetched < detailBudget.tenders && (fetched === 0 || Date.now() - detailStart < detailBudget.ms));
  // Tenders in the list, award notices left out (no request; counted once, for progress lines).
  let listedCount: number | null = null;
  const listed = () => (listedCount ??= items.filter((it) => !isAwardNotice(it.scope, it.values)).length);
  // A dry-run keeps the list order (it stops after maxItems). A regular read spends its budget on
  // the newest tenders first; undated ones keep list order after the dated ones.
  const order = items.map((_, i) => i);
  if (!st.limits) {
    const dateOf = (i: number) => {
      const d = templateValue(items[i]!.values.publicationDate);
      return d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : "";
    };
    order.sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || a - b);
  }

  for (const index of order) {
    const item = items[index]!;
    checkAbort(ctx);
    if (st.limits && done.length >= st.limits.maxItems) break;
    let values: Values = { ...item.values };
    const listId = cleanText(templateValue(values.id));
    if (listId && ids.has(listId)) continue;
    // Award notices are results of finished procedures: skip them before spending any request.
    if (isAwardNotice(item.scope, values)) {
      awards += 1;
      continue;
    }

    let detailWithdrawn = false;
    let refs: DocumentRef[] = [];
    // True when this read could not look at the tender's detail page or documents (cap or failure):
    // empty refs then mean "unknown", not "no documents", and the platform holds the tender back.
    let pending = false;
    const requiresDetailUrl = recipe.detail?.fields.url !== undefined;
    let hasDetailUrl = !requiresDetailUrl;
    // True when only the per-read budget left the tender pending (not a failed page).
    let deferred = false;
    // JSON lists often carry each tender's files in the item itself ("pieces": [{ "lien": … }]). A
    // documents rule with no hops and a JSONPath is tried on the item first: no request at all.
    let itemRefs: DocumentRef[] | null = null;
    const docRule = recipe.documents;
    if (docRule && (docRule.hops ?? []).length === 0 && docRule.files.jsonPath !== undefined && item.scope.kind === "json") {
      const found = await documentRefs(st, { kind: "json", data: item.scope.value, url: item.scope.url, raw: "" }, values, false);
      // The item lists its files when the path's first key is there, even as an empty list: then an
      // empty result means "no files", and fetching the tender page would be a wasted request.
      const key = /^\$\.([^.[\]]+)/.exec(docRule.files.jsonPath)?.[1];
      const value = item.scope.value;
      const listed = key !== undefined && value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key);
      if (found.length > 0 || listed) itemRefs = found;
    }
    if (itemRefs) refs = itemRefs;
    const needsWork = recipe.detail !== null && recipe.detail !== undefined ? true : recipe.documents !== null && recipe.documents !== undefined && !itemRefs;
    if (needsWork) {
      let detailUrl: string | null = null;
      if (recipe.detail) {
        const from = recipe.detail.urlFrom ?? "url";
        const t = from.includes("{") ? fillTemplate(from, values, true, recipe.timeZone) : templateValue(values[from]);
        detailUrl = t ? absoluteUrl(t, item.scope.url) : null;
      }
      const tenderUrl = typeof values.url === "string" ? values.url : null;
      const detailIsSummary = requiresDetailUrl && detailUrl !== null && detailUrl === absoluteUrl(tenderUrl, item.scope.url);
      const cacheKey = `${ctx.portalId}|${detailUrl ?? tenderUrl ?? ""}`;
      const hash = sha256(`${recipeKey}|${item.raw}`);
      const cached = detailUrl || tenderUrl ? detailCache.get(cacheKey) : undefined;
      if (cached && cached.hash === hash) {
        values = merge(values, cached.fields);
        hasDetailUrl = !requiresDetailUrl || typeof cached.fields.url === "string";
        refs = cached.refs ?? [];
        detailWithdrawn = cached.withdrawn;
        enriched += 1;
      } else if ((detailUrl || tenderUrl) && budgetLeft()) {
        fetched += 1;
        enriched += 1;
        if (!st.limits && fetched % PROGRESS_EVERY === 0) ctx.log(`Read the pages of ${fmt(enriched)} of ${fmt(listed())} tenders so far.`);
        let ok = true;
        let detailDoc: Doc | null = null;
        let detailFields: Values = {};
        if (recipe.detail && detailUrl) {
          try {
            const page = await fetchPage(st, detailUrl);
            if (page.status < 200 || page.status >= 300) throw new Error(`it answers ${statusLabel(page)}`);
            detailDoc = parseDoc(page, recipe.tier);
            detailFields = extractFields(st, recipe.detail.fields, rootScope(detailDoc), values);
            if (requiresDetailUrl) {
              const candidate = typeof detailFields.url === "string" ? absoluteUrl(detailFields.url, detailDoc.url) : null;
              if (!candidate || (detailIsSummary && candidate === detailUrl)) {
                throw new Error("the link to the tender's own page is missing or still points to the summary");
              }
              detailFields.url = candidate;
              hasDetailUrl = true;
            }
            values = merge(values, detailFields);
            detailWithdrawn = hasWithdrawnText(recipe, scopeText(rootScope(detailDoc))) || pageStatusCancelled(rootScope(detailDoc));
          } catch (e) {
            if (e instanceof Cancelled) throw e;
            ok = false;
            ctx.log(`Detail page ${detailUrl} could not be read (${(e as Error).message}); keeping the list values.`, "warn");
          }
        }
        if (recipe.documents && !itemRefs && hasDetailUrl) {
          try {
            // If the detail request opened the list's intermediate link, look for files on the
            // actual tender. Keep a separate detail API as the source for recipes that use one.
            let start = detailIsSummary ? null : detailDoc;
            const url = typeof values.url === "string" ? values.url : null;
            const firstStep = recipe.documents.hops?.[0] ?? recipe.documents.files;
            if (!start && url && firstStep.const !== undefined) {
              // A URL template needs no page to start from.
              start = { kind: "json", data: null, url, raw: "" };
            } else if (!start && url) {
              const page = await fetchPage(st, url);
              if (page.status < 200 || page.status >= 300) throw new Error(`the tender page answers ${statusLabel(page)}`);
              start = parseDoc(page, recipe.tier);
            }
            if (start) refs = await documentRefs(st, start, values);
            // The tender's own page is a login form and shows no files: hand that page on as the
            // document, so the platform reports "documents need a login" instead of "no documents".
            if (start && refs.length === 0 && start.kind === "markup" && start.$('input[type="password" i]').length > 0) refs = [{ url: start.url, via: "http" }];
          } catch (e) {
            if (e instanceof Cancelled) throw e;
            ok = false;
            refs = [];
            ctx.log(`Documents for ${templateValue(values.id) ?? "a tender"} could not be listed (${(e as Error).message}).`, "warn");
          }
        }
        if (!ok) pending = true;
        if (ok) detailCache.set(cacheKey, { hash, fields: detailFields, refs: recipe.documents ? refs : null, withdrawn: detailWithdrawn });
      } else if (detailUrl || tenderUrl) {
        // Over this read's budget: list values now, details in a later read.
        pending = true;
        deferred = true;
      }
    }

    const id = cleanText(templateValue(values.id));
    const url = typeof values.url === "string" ? absoluteUrl(values.url, item.scope.url) : null;
    if (!hasDetailUrl && !deferred) {
      missingTenderUrls += 1;
      continue;
    }
    if (!id || !url) {
      dropped += 1;
      continue;
    }
    if (ids.has(id)) continue;
    ids.add(id);
    const tender = toTender(recipe, id, url, values, refs);
    if (pending) tender.documentRefsPending = true;
    if (
      values[WITHDRAWN_FIELD] === true ||
      detailWithdrawn ||
      hasWithdrawnText(recipe, scopeText(item.scope)) ||
      rowHasCancellationLabel(item.scope) ||
      hasCancelledTitlePrefix(tender.title)
    )
      tender.withdrawn = true;
    if (deferred) deferredCount += 1;
    done.push({ index, tender, values: { ...values, id, url }, deferred });
  }
  // Back to list order: the order the portal shows is the order we hand on.
  done.sort((a, b) => a.index - b.index);
  const tenders = done.map((d) => d.tender);
  if (!st.limits && (fetched > 0 || deferredCount > 0)) {
    const thisRead = `${fmt(fetched)} in this read`;
    ctx.log(
      deferredCount > 0
        ? `Read the pages of ${fmt(enriched)} of ${fmt(tenders.length)} tenders (${thisRead}); the other ${fmt(deferredCount)} follow in the next reads.`
        : `Read the pages of all ${fmt(tenders.length)} tenders (${thisRead}).`,
    );
  }
  if (dropped > 0) ctx.log(`${dropped} list entries had no id or address and were left out.`, "warn");
  if (awards > 0) ctx.log(`Left out ${awards} award notices: results of finished procedures, not open tenders.`);
  // A partial list is unsafe: Platform might otherwise close existing tenders whose links broke.
  if (missingTenderUrls > 0) return {
    kind: "error",
    reason: `Could not find the tender's own page for ${missingTenderUrls} list entries. The summary is not a substitute.`,
    diagnostics: { requests: st.requests, listPages, itemsSeen },
  };
  // Regular reads only: during a dry-run the Cartographer checks the documents rule itself, against
  // the tender page it shows the model.
  const docsProblem = st.limits ? null : documentsRuleProblem(st);
  if (docsProblem) return { kind: "error", reason: docsProblem, diagnostics: { requests: st.requests, listPages, itemsSeen } };

  // fieldFill counts only tenders whose detail work is done (this read or cached) or not needed:
  // tenders deferred by the per-read budget lack their detail-only fields by design, and counting
  // them would look like a fill collapse to C's checks. Tenders whose detail page failed still
  // count, so a broken detail rule shows. If every tender was deferred, all are counted.
  const counted = done.some((d) => !d.deferred) ? done.filter((d) => !d.deferred) : done;
  const fieldNames = new Set<string>([...REQUIRED_FIELDS, ...Object.keys(recipe.listFields), ...Object.keys(recipe.detail?.fields ?? {})]);
  const fieldFill: Record<string, FieldFill> = {};
  fieldNames.delete(WITHDRAWN_FIELD);
  for (const f of fieldNames) {
    fieldFill[f] = { filled: counted.filter((d) => hasValue(d.values[f])).length, total: counted.length };
  }

  return {
    kind: "ok",
    tenders,
    diagnostics: {
      requests: st.requests,
      listPages,
      itemsSeen,
      fieldFill,
      ...(listSkeletonHash ? { listSkeletonHash } : {}),
      ...(emptyStateText && tenders.length === 0 ? { emptyStateText } : {}),
      durationMs: Date.now() - started,
    },
  };
}

function merge(list: Values, detail: Values): Values {
  const out = { ...list };
  for (const [k, v] of Object.entries(detail)) if (hasValue(v)) out[k] = v;
  return out;
}

function hasWithdrawnText(recipe: Recipe, text: string): boolean {
  const lower = text.toLowerCase();
  return (recipe.withdrawnText ?? []).some((w) => w.trim() !== "" && lower.includes(w.trim().toLowerCase()));
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function toTender(recipe: Recipe, id: string, url: string, v: Values, refs: DocumentRef[]): ExtractedTender {
  const t: ExtractedTender = {
    id,
    url,
    title: str(v.title),
    buyerName: str(v.buyerName),
    publicationDate: str(v.publicationDate),
    submissionDeadline: str(v.submissionDeadline),
    documentRefs: refs,
  };
  const ref = str(v.referenceNumber);
  if (ref) t.referenceNumber = ref;
  const desc = str(v.description);
  if (desc) t.description = desc;
  const pt = str(v.procedureType);
  if (pt) t.procedureType = pt as ExtractedTender["procedureType"];
  const cn = str(v.contractNature);
  if (cn) t.contractNature = cn as ExtractedTender["contractNature"];
  if (Array.isArray(v.cpvCodes) && v.cpvCodes.length) t.cpvCodes = v.cpvCodes as string[];

  const postalCode = str(v.postalCode) ?? str(v["placeOfPerformance.postalCode"]);
  const city = str(v.city) ?? str(v["placeOfPerformance.city"]);
  const explicitCountry = str(v.countryCode) ?? str(v["placeOfPerformance.countryCode"]);
  const countryCode = explicitCountry ?? (postalCode || city ? (recipe.countryCode?.toUpperCase() ?? null) : null);
  if (postalCode || city || explicitCountry) t.placeOfPerformance = { postalCode, city, countryCode };
  return t;
}

export const extractor: Extractor = {
  read(recipe, ctx) {
    return readWith(recipe, ctx);
  },
};

/** A dry-run read of the first page(s) and a few tenders, for checking a draft recipe cheaply. */
export function readSample(recipe: Recipe, ctx: PortalContext, limits: SampleLimits = { maxPages: 1, maxItems: 3 }): Promise<ReadOutcome> {
  return readWith(recipe, ctx, limits);
}

/** Runs `fn` with st.pages set to one browser page when the recipe is browser tier. */
function withPages<T>(st: ReadState, fn: () => Promise<T>): Promise<T> {
  if (st.recipe.tier !== "browser") return fn();
  const zone = st.recipe.timeZone;
  const dates = (v: string) => v.replace(/\{(today|daysAgo:\d{1,4})\}/g, (_, k: string) => datePlaceholder(k, zone) ?? "");
  const before = (st.recipe.list.before ?? []).map((step): BrowserStep =>
    "fill" in step ? { fill: { ...step.fill, value: dates(step.fill.value) } } : "select" in step ? { select: { ...step.select, value: dates(step.select.value) } } : step,
  );
  return st.ctx.browser.withPage((page) => {
    st.pages = browserPages(page, st.ctx, () => void (st.requests += 1), before);
    return fn();
  });
}

async function readWith(recipe: Recipe, ctx: PortalContext, limits?: SampleLimits): Promise<ReadOutcome> {
  {
    const started = Date.now();
    const st: ReadState = { recipe, ctx, requests: 0, warned: new Set(), ...(limits ? { limits } : {}) };
    try {
      return await withPages(st, () => run(st, started));
    } catch (e) {
      const diagnostics = { requests: st.requests, durationMs: Date.now() - started };
      if (e instanceof Cancelled || ctx.signal.aborted) return { kind: "error", reason: "The read was cancelled before it finished.", diagnostics };
      return { kind: "error", reason: `The Extractor failed: ${e instanceof Error ? e.message : String(e)}`, diagnostics };
    }
  }
}

/**
 * The raw markup (or JSON) of the first items the recipe's list selector matches on page 1, for the
 * Cartographer's feedback: the model sees what its field rules ran against. One request; no model call.
 */
export async function sampleItems(recipe: Recipe, ctx: PortalContext, n = 2): Promise<{ status: number; items: string[]; pageStart: string }> {
  const st: ReadState = { recipe, ctx, requests: 0, warned: new Set() };
  const { url, init } = listRequest(recipe, ctx, 0);
  return withPages(st, async () => {
    const page = await fetchPage(st, url, init, st.pages ? recipe.list.item : undefined);
    const doc = parseDoc(page, recipe.tier);
    return { status: page.status, items: itemsOf(st, doc).slice(0, n).map(rawOf), pageStart: page.text.slice(0, 400) };
  });
}
