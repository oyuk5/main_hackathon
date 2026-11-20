import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { PortalContext } from "../shared/modules.js";
import type { Recipe } from "../shared/recipe.js";
import type { SnapshotOutcome } from "./types.js";

const DEFAULT_MAX_CHARS = 8000;
const MAX_REPEATED_SIBLINGS = 2;
const MAX_JSON_ARRAY_ITEMS = 2;

const CAPTCHA_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bg-recaptcha\b|recaptcha\/api\.js/i, reason: "Portal presents a Google reCAPTCHA challenge." },
  { pattern: /\bh-captcha\b|hcaptcha\.com\/1\/api\.js/i, reason: "Portal presents an hCaptcha challenge." },
  { pattern: /\bcf-turnstile\b|challenges\.cloudflare\.com/i, reason: "Portal presents a Cloudflare Turnstile challenge." },
  {
    pattern: /<title[^>]*>[^<]*(just a moment|attention required|captcha|verify you are human)[^<]*<\/title>/i,
    reason: "Portal presents an anti-bot or CAPTCHA challenge page.",
  },
];

const PASSWORD_INPUT_PATTERN = /<input\b[^>]*\btype\s*=\s*["']?password["']?/i;
const LOGIN_FORM_PATTERN =
  /<form\b[^>]*(?:action|id|class|name)\s*=\s*["'][^"']*(?:login|signin|sign-in|anmelden|connexion|auth)[^"']*["'][^>]*>/i;

export function detectBlockInContent(htmlOrText: string, status: number): string | null {
  if (status === 401) {
    return "HTTP 401 Unauthorized: portal requires authentication.";
  }
  if (status === 403) {
    return "HTTP 403 Forbidden: access denied by portal.";
  }

  for (const { pattern, reason } of CAPTCHA_PATTERNS) {
    if (pattern.test(htmlOrText)) {
      return reason;
    }
  }

  if (PASSWORD_INPUT_PATTERN.test(htmlOrText)) {
    return "Portal requires login (password form detected).";
  }

  if (LOGIN_FORM_PATTERN.test(htmlOrText)) {
    return "Portal requires login (authentication form detected).";
  }

  return null;
}

export function compressHtml(
  html: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): { compressed: string; structureSummary: string } {
  const $ = cheerio.load(html);
  stripNoiseNodes($);

  const structureSummary = buildHtmlStructureSummary($);
  collapseRepeatedSiblings($);

  const normalized = normalizeWhitespace($.html());
  const compressed = capText(normalized, maxChars, "\n<!-- ...truncated -->");
  return { compressed, structureSummary };
}

function stripNoiseNodes($: cheerio.CheerioAPI): void {
  $("script, style, svg, noscript").remove();
  removeHtmlComments($, $.root()[0]);
}

function removeHtmlComments($: cheerio.CheerioAPI, node: AnyNode | undefined): void {
  if (!node || !("children" in node) || !Array.isArray(node.children)) {
    return;
  }
  for (const child of [...node.children]) {
    if (child.type === "comment") {
      $(child).remove();
    } else {
      removeHtmlComments($, child);
    }
  }
}

function elementSignature(el: Element): string {
  const rawClass = el.attribs?.class ?? "";
  const classes = rawClass
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0 && token !== "odd" && token !== "even")
    .sort()
    .join(".");
  return classes ? `${el.tagName}.${classes}` : el.tagName;
}

function collapseRepeatedSiblings($: cheerio.CheerioAPI): void {
  const root = $.root()[0];
  if (root) {
    collapseChildrenOf($, root);
  }
}

function collapseChildrenOf($: cheerio.CheerioAPI, parent: AnyNode): void {
  if (!("children" in parent) || !Array.isArray(parent.children)) {
    return;
  }

  const elements = parent.children.filter((child): child is Element => child.type === "tag");
  collapseElementRuns($, elements);

  for (const child of parent.children) {
    if (child.type === "tag") {
      collapseChildrenOf($, child);
    }
  }
}

function collapseElementRuns($: cheerio.CheerioAPI, elements: Element[]): void {
  let index = 0;
  while (index < elements.length) {
    const first = elements[index];
    if (!first) {
      break;
    }
    const sig = elementSignature(first);
    let end = index + 1;
    while (end < elements.length) {
      const next = elements[end];
      if (!next || elementSignature(next) !== sig) {
        break;
      }
      end += 1;
    }

    const runLength = end - index;
    if (runLength > MAX_REPEATED_SIBLINGS) {
      const omitted = runLength - MAX_REPEATED_SIBLINGS;
      const keepLast = elements[index + MAX_REPEATED_SIBLINGS - 1];
      if (keepLast) {
        $(keepLast).after(`<!-- ...${omitted} more similar items -->`);
      }
      for (let i = index + MAX_REPEATED_SIBLINGS; i < end; i += 1) {
        const toRemove = elements[i];
        if (toRemove) {
          $(toRemove).remove();
        }
      }
    }
    index = end;
  }
}

function buildHtmlStructureSummary($: cheerio.CheerioAPI): string {
  const parts: string[] = [];
  const tableCount = $("table").length;
  const rowCount = $("tr").length;
  const listCount = $("ul, ol").length;
  const listItemCount = $("li").length;

  if (tableCount > 0) {
    parts.push(`tables=${tableCount} (rows=${rowCount})`);
  }
  if (listCount > 0) {
    parts.push(`lists=${listCount} (items=${listItemCount})`);
  }

  const repeatedGroups = findTopRepeatedGroups($);
  if (repeatedGroups.length > 0) {
    parts.push(`repeated=[${repeatedGroups.join(", ")}]`);
  }

  const paginationHints = findPaginationHints($);
  if (paginationHints.length > 0) {
    parts.push(`pagination=[${paginationHints.join(", ")}]`);
  }

  return parts.length > 0 ? parts.join("; ") : "minimal HTML structure";
}

function findTopRepeatedGroups($: cheerio.CheerioAPI): string[] {
  const counts = new Map<string, number>();
  $("*").each((_idx, node) => {
    if (node.type !== "tag") {
      return;
    }
    const sig = elementSignature(node);
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  });

  return [...counts.entries()]
    .filter(([sig, count]) => count >= 3 && !/^(td|th|span|a|p|b|i|strong|em)$/.test(sig))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([sig, count]) => `${sig}x${count}`);
}

function findPaginationHints($: cheerio.CheerioAPI): string[] {
  const hints = new Set<string>();
  $('a[rel="next"], nav[aria-label*="pag" i], .pagination, .pager').each((_idx, node) => {
    if (node.type === "tag") {
      hints.add(elementSignature(node));
    }
  });
  $("a[href]").each((_idx, node) => {
    const href = $(node).attr("href") ?? "";
    const text = $(node).text().trim().toLowerCase();
    if (/[?&](page|p|offset)=/i.test(href) || /^(next|weiter|suivant|»|›)$/.test(text)) {
      hints.add(`a(${text || href.slice(0, 24)})`);
    }
  });
  return [...hints].slice(0, 4);
}

export function compressJson(
  raw: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): { compressed: string; structureSummary: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      compressed: capText(normalizeWhitespace(raw), maxChars, "\n...truncated"),
      structureSummary: "Invalid JSON payload",
    };
  }

  const structureSummary = buildJsonStructureSummary(parsed);
  const truncated = truncateJsonValue(parsed);
  const serialized = JSON.stringify(truncated, null, 2) ?? "";
  const compressed = capText(serialized, maxChars, "\n...truncated");
  return { compressed, structureSummary };
}

function truncateJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_JSON_ARRAY_ITEMS).map(truncateJsonValue);
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      kept.push(`... (${value.length - MAX_JSON_ARRAY_ITEMS} more items, total ${value.length})`);
    }
    return kept;
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = truncateJsonValue(entry);
    }
    return out;
  }

  return value;
}

function buildJsonStructureSummary(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    const itemKeys = extractObjectKeys(parsed[0]);
    return itemKeys.length > 0
      ? `root=Array(${parsed.length}); itemKeys=[${itemKeys.join(", ")}]`
      : `root=Array(${parsed.length})`;
  }

  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const topKeys = Object.keys(record).slice(0, 12);
    const arraySummaries = Object.entries(record)
      .filter(([, val]) => Array.isArray(val))
      .slice(0, 4)
      .map(([key, val]) => {
        const arr = val as unknown[];
        const itemKeys = extractObjectKeys(arr[0]);
        return itemKeys.length > 0
          ? `${key}=Array(${arr.length})[${itemKeys.join(", ")}]`
          : `${key}=Array(${arr.length})`;
      });

    const parts = [`rootKeys=[${topKeys.join(", ")}]`];
    if (arraySummaries.length > 0) {
      parts.push(...arraySummaries);
    }
    return parts.join("; ");
  }

  return `root=${typeof parsed}`;
}

function extractObjectKeys(sample: unknown): string[] {
  if (sample !== null && typeof sample === "object" && !Array.isArray(sample)) {
    return Object.keys(sample as Record<string, unknown>).slice(0, 12);
  }
  return [];
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function capText(text: string, maxChars: number, suffix: string): string {
  if (text.length <= maxChars) {
    return text;
  }
  const budget = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, budget)}${suffix}`;
}

function resolvePlaceholders(template: string): string {
  return template
    .replace(/\{page\}/g, "1")
    .replace(/\{offset\}/g, "0")
    .replace(/\{pageSize\}/g, "20");
}

interface RawFetchResult {
  url: string;
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  body: string;
}

async function fetchViaBrowser(url: string, ctx: PortalContext): Promise<RawFetchResult> {
  return ctx.browser.withPage(async (page) => {
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    const httpStatus = response?.status() ?? 200;
    const contentType = response?.headers()["content-type"] ?? "text/html";
    const finalUrl = page.url() || url;
    const body = await page.content();
    return { url, finalUrl, httpStatus, contentType, body };
  });
}

async function fetchViaHttp(recipe: Recipe, url: string, ctx: PortalContext): Promise<RawFetchResult> {
  const { method, headers, body } = recipe.list.request;
  const resolvedBody = body ? resolvePlaceholders(body) : undefined;
  const response = await ctx.http.fetch(url, {
    method,
    headers,
    body: resolvedBody,
    signal: ctx.signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const finalUrl = response.url || url;
  const text = await response.text();
  return { url, finalUrl, httpStatus: response.status, contentType, body: text };
}

export async function capturePortalSnapshot(
  recipe: Recipe,
  ctx: PortalContext,
): Promise<SnapshotOutcome> {
  if (ctx.signal.aborted) {
    return { kind: "unreachable", reason: "Snapshot aborted before request." };
  }

  const targetUrl = resolvePlaceholders(recipe.list.request.url);
  let result: RawFetchResult;
  try {
    result =
      recipe.tier === "browser"
        ? await fetchViaBrowser(targetUrl, ctx)
        : await fetchViaHttp(recipe, targetUrl, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "unreachable", reason: `Network error fetching portal: ${message}` };
  }

  return classifyRawSnapshot(recipe, result);
}

function classifyRawSnapshot(recipe: Recipe, result: RawFetchResult): SnapshotOutcome {
  if (result.httpStatus >= 500) {
    return {
      kind: "unreachable",
      reason: `Portal returned HTTP ${result.httpStatus}.`,
      httpStatus: result.httpStatus,
    };
  }

  const blockReason = detectBlockInContent(result.body, result.httpStatus);
  if (blockReason) {
    return {
      kind: "blocked",
      reason: blockReason,
      httpStatus: result.httpStatus,
    };
  }

  const isJson =
    recipe.tier === "jsonApi" || result.contentType.toLowerCase().includes("json");
  const { compressed, structureSummary } = isJson
    ? compressJson(result.body)
    : compressHtml(result.body);

  return {
    kind: "ok",
    url: result.url,
    finalUrl: result.finalUrl,
    httpStatus: result.httpStatus,
    contentType: result.contentType,
    compressedContent: compressed,
    structureSummary,
  };
}
