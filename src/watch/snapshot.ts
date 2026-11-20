import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { PortalContext } from "../shared/modules.js";
import type { Recipe } from "../shared/recipe.js";
import type { SnapshotOutcome } from "./types.js";

const DEFAULT_MAX_CHARS = 8000;
const MAX_REPEATED_SIBLINGS = 2;
const MAX_JSON_ARRAY_ITEMS = 2;
const MAX_CAPTURED_API_URLS = 6;
const HEAD_TRUNCATION_RATIO = 0.65;

const CHALLENGE_TITLE_PATTERN =
  /<title[^>]*>[^<]*(just a moment|attention required|captcha|verify you are human)[^<]*<\/title>/i;

const PASSIVE_CAPTCHA_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bg-recaptcha\b|recaptcha\/api\.js/i, reason: "Portal is blocked by a reCAPTCHA check." },
  { pattern: /\bh-captcha\b|hcaptcha\.com\/1\/api\.js/i, reason: "Portal is blocked by an hCaptcha check." },
  { pattern: /\bcf-turnstile\b|challenges\.cloudflare\.com/i, reason: "Portal is blocked by a Cloudflare security check." },
];

const LOGIN_URL_PATTERN = /\/(login|signin|sign-in|anmelden|connexion|inloggen|auth)(\/|\?|$)/i;
const PASSWORD_INPUT_PATTERN = /<input\b[^>]*\btype\s*=\s*["']?password["']?/i;
const LOGIN_FORM_PATTERN =
  /<form\b[^>]*(?:action|id|class|name)\s*=\s*["'][^"']*(?:login|signin|sign-in|anmelden|connexion|auth)[^"']*["'][^>]*>/i;

function isLoginUrl(url: string | undefined): boolean {
  return Boolean(url && LOGIN_URL_PATTERN.test(url));
}

function hasSubstantialListContent(html: string): boolean {
  const $ = cheerio.load(html);
  $('header, nav, footer, script, style, svg, noscript, form[action*="login" i], form[action*="signin" i]').remove();

  if ($("tr").length >= 3) return true;
  if ($("main, section, ul, ol").find("li").length >= 3) return true;
  if ($("article").length >= 3) return true;

  let longLinks = 0;
  $("a[href]").each((_idx, node) => {
    if ($(node).text().trim().length >= 8) longLinks += 1;
  });
  return longLinks >= 5;
}

function findPassiveBlockReason(htmlOrText: string): string | null {
  for (const { pattern, reason } of PASSIVE_CAPTCHA_PATTERNS) {
    if (pattern.test(htmlOrText)) return reason;
  }
  if (PASSWORD_INPUT_PATTERN.test(htmlOrText) || LOGIN_FORM_PATTERN.test(htmlOrText)) {
    return "Portal requires a login.";
  }
  return null;
}

export function detectBlockInContent(
  htmlOrText: string,
  status: number,
  finalUrl?: string,
): string | null {
  if (status === 401) {
    return "Portal requires a login (HTTP 401).";
  }
  if (status === 403) {
    return "Portal blocked access (HTTP 403).";
  }
  if (CHALLENGE_TITLE_PATTERN.test(htmlOrText)) {
    return "Portal is blocked by a captcha or anti-bot check.";
  }

  const candidateReason = findPassiveBlockReason(htmlOrText);
  if (!candidateReason) return null;

  if (!isLoginUrl(finalUrl) && hasSubstantialListContent(htmlOrText)) {
    return null;
  }
  return candidateReason;
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
  const compressed = capHtmlHeadAndTail(normalized, maxChars);
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

function capHtmlHeadAndTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = "\n<!-- ...middle truncated -->\n";
  if (maxChars <= marker.length) {
    return text.slice(0, Math.max(0, maxChars));
  }
  const available = maxChars - marker.length;
  const headLen = Math.floor(available * HEAD_TRUNCATION_RATIO);
  const tailLen = available - headLen;
  return `${text.slice(0, headLen)}${marker}${text.slice(text.length - tailLen)}`;
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

async function probeJsonEndpoints(ctx: PortalContext): Promise<string[]> {
  try {
    return await ctx.browser.withPage(async (page) => {
      const urls = new Set<string>();
      page.on("response", (response) => {
        if (urls.size >= MAX_CAPTURED_API_URLS) return;
        const ct = (response.headers()["content-type"] ?? "").toLowerCase();
        if (response.status() < 400 && ct.includes("json")) {
          urls.add(response.url());
        }
      });
      await page.goto(ctx.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
      return [...urls];
    });
  } catch {
    return [];
  }
}

function extractErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.name, err.message];
  const withCode = err as Error & { code?: unknown; cause?: unknown };
  if (typeof withCode.code === "string") parts.push(withCode.code);
  if (withCode.cause && typeof withCode.cause === "object") {
    const cause = withCode.cause as { name?: unknown; message?: unknown; code?: unknown };
    if (typeof cause.name === "string") parts.push(cause.name);
    if (typeof cause.code === "string") parts.push(cause.code);
    if (typeof cause.message === "string") parts.push(cause.message);
  }
  return parts.join(" ");
}

function classifyNetworkErrorReason(err: unknown): string {
  const details = extractErrorText(err);
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  ) {
    return "The portal timed out while loading.";
  }
  if (/timeout|timed[\s_]*out|etimedout|und_err_.*timeout/i.test(details)) {
    return "The portal timed out while loading.";
  }
  if (
    /econnrefused|enotfound|eai_again|econnreset|ehostunreach|enetunreach|err_name_not_resolved|err_connection_|err_address_unreachable|err_internet_disconnected|getaddrinfo|connect\s+e/i.test(
      details,
    )
  ) {
    return "Could not connect to the portal.";
  }
  return "Could not reach the portal due to a network problem.";
}

export async function capturePortalSnapshot(
  recipe: Recipe,
  ctx: PortalContext,
): Promise<SnapshotOutcome> {
  if (ctx.signal.aborted) {
    return { kind: "unreachable", reason: "Repair stopped before checking the portal." };
  }

  const targetUrl = resolvePlaceholders(recipe.list.request.url);
  let result: RawFetchResult;
  try {
    result =
      recipe.tier === "browser"
        ? await fetchViaBrowser(targetUrl, ctx)
        : await fetchViaHttp(recipe, targetUrl, ctx);
  } catch (err) {
    // Aborting closes the browser context mid-call; treat post-abort throws as normal cancellation.
    if (ctx.signal.aborted) {
      return {
        kind: "unreachable",
        reason: "Repair stopped because the portal was removed or cancelled.",
      };
    }
    const rawMessage = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
    ctx.log(
      rawMessage ? `Could not load portal snapshot: ${rawMessage}` : "Could not load portal snapshot.",
      "warn",
    );
    return { kind: "unreachable", reason: classifyNetworkErrorReason(err) };
  }

  if (ctx.signal.aborted) {
    return {
      kind: "unreachable",
      reason: "Repair stopped because the portal was removed or cancelled.",
    };
  }

  const classified = classifyRawSnapshot(recipe, result);
  if (
    classified.kind === "ok" &&
    recipe.tier === "jsonApi" &&
    result.httpStatus === 404 &&
    !ctx.signal.aborted
  ) {
    const capturedApiUrls = await probeJsonEndpoints(ctx);
    if (ctx.signal.aborted) {
      return {
        kind: "unreachable",
        reason: "Repair stopped because the portal was removed or cancelled.",
      };
    }
    if (capturedApiUrls.length > 0) {
      return { ...classified, capturedApiUrls };
    }
  }
  return classified;
}

function classifyRawSnapshot(recipe: Recipe, result: RawFetchResult): SnapshotOutcome {
  if (result.httpStatus >= 500) {
    return {
      kind: "unreachable",
      reason: `Portal returned a server error (HTTP ${result.httpStatus}).`,
      httpStatus: result.httpStatus,
    };
  }

  const blockReason = detectBlockInContent(result.body, result.httpStatus, result.finalUrl);
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
