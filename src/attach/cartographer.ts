/**
 * The Cartographer: learns how to read a portal it has never seen. Owned by B.
 *
 * The model proposes a recipe (JSON data); code decides. Every draft is dry-run with the Extractor on
 * one list page and a few tenders, and the exact problems go back to the model, at most 3 times.
 * Only a recipe that passes is kept, and from then on reads run with no model call at all.
 *
 *   look ──► (block? stop) ──► model: recipe | navigate | give up ──► dry-run ──► problems? ──► model …
 *                                                                        └─ clean ──► full read ──► golden
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { z } from "zod";
import type { AttachOutcome, ExtractedTender, PortalContext, ReadOutcome } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";
import { decode, extractor, readSample, sampleItems } from "./extractor.js";
import { pickGolden } from "./golden.js";

/** First draft plus at most 3 correction rounds, as the area rules say. */
export const MAX_RECIPE_ROUNDS = 4;
/** Hops from the given address to the real list (landing page, summary page). */
export const MAX_NAVIGATIONS = 2;
const PAGE_CHARS = 14_000;
const JSON_SAMPLE_CHARS = 3_500;
const LINKS_MAX = 80;
const REQUEST_TIMEOUT_MS = 30_000;
const BROWSER_LOAD_MS = 45_000;

// ------------------------------------------------------------ what the model answers

export const CartographerStep = z.object({
  action: z.enum(["recipe", "navigate", "give_up"]),
  /** For navigate: the absolute address of the page that lists the tenders. */
  // Defaults, because the model often leaves out the fields its action does not use (the response
  // format is not strict), and a whole round was lost to that.
  navigateTo: z.string().nullable().default(null),
  /** One plain sentence: why this step. Shown in the run log. */
  reason: z.string().default(""),
  recipe: Recipe.nullable().default(null),
});
export type CartographerStep = z.infer<typeof CartographerStep>;

// ------------------------------------------------------------ looking at a page

export interface Look {
  url: string;
  status: number;
  /** Raw HTML (or body) as the server sent it. */
  raw: string;
  /** HTML after JavaScript ran, when the browser could load the page. */
  rendered: string | null;
  json: CapturedJson[];
  feeds: string[];
}

export interface CapturedJson {
  url: string;
  method: string;
  postData?: string;
  data: unknown;
}

async function fetchText(ctx: PortalContext, url: string): Promise<{ url: string; status: number; text: string; contentType: string }> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const res = await ctx.http.fetch(url, { signal });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") ?? "";
  return { url: res.url || url, status: res.status, text: decode(bytes, contentType), contentType };
}

/** Loads the page in the browser and keeps the JSON the page itself fetched: often a clean API. */
async function sniff(ctx: PortalContext, url: string): Promise<{ rendered: string | null; json: CapturedJson[] }> {
  try {
    return await ctx.browser.withPage(async (page) => {
      const json: CapturedJson[] = [];
      page.on("response", (res) => {
        void (async () => {
          try {
            const req = res.request();
            if (!["xhr", "fetch"].includes(req.resourceType())) return;
            if (!/json/i.test(res.headers()["content-type"] ?? "")) return;
            const body = await res.text();
            if (body.length > 2_000_000) return;
            const postData = req.postData() ?? undefined;
            json.push({ url: res.url(), method: req.method(), ...(postData ? { postData } : {}), data: JSON.parse(body) });
          } catch {
            // A response we cannot read is simply not a candidate.
          }
        })();
      });
      // Every request the page makes waits its turn at 1 per second, so a heavy page may not finish
      // loading in time. Whatever rendered by then is still worth showing.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: BROWSER_LOAD_MS }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      const rendered = await page.content().catch(() => null);
      return { rendered: rendered && rendered.length > 200 ? rendered : null, json };
    });
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log(`The browser could not load ${url}; working from the plain page.`, "warn");
    return { rendered: null, json: [] };
  }
}

export async function look(ctx: PortalContext, url: string): Promise<Look> {
  const first = await fetchText(ctx, url);
  const feeds = findFeeds(first.text, first.url);
  const blockedHard = first.status === 401 || first.status === 403;
  const { rendered, json } = blockedHard ? { rendered: null, json: [] } : await sniff(ctx, first.url);
  return { url: first.url, status: first.status, raw: first.text, rendered, json: rankJson(json), feeds };
}

function findFeeds(html: string, base: string): string[] {
  const $ = cheerio.load(html);
  const out: string[] = [];
  $('link[rel="alternate"]').each((_, el) => {
    const type = $(el).attr("type") ?? "";
    const href = $(el).attr("href");
    if (href && /rss|atom|xml/i.test(type)) {
      try {
        out.push(new URL(href, base).toString());
      } catch {
        // ignore bad links
      }
    }
  });
  return [...new Set(out)].slice(0, 3);
}

/** Largest array of objects anywhere in a value: a JSON response that lists things. */
export function largestObjectArray(v: unknown, depth = 0): number {
  if (depth > 6 || v === null || typeof v !== "object") return 0;
  if (Array.isArray(v)) {
    const own = v.filter((x) => x !== null && typeof x === "object" && !Array.isArray(x)).length;
    return Math.max(own, ...v.slice(0, 3).map((x) => largestObjectArray(x, depth + 1)));
  }
  return Math.max(0, ...Object.values(v as Record<string, unknown>).map((x) => largestObjectArray(x, depth + 1)));
}

function rankJson(all: CapturedJson[]): CapturedJson[] {
  return all
    .map((j) => ({ j, n: largestObjectArray(j.data) }))
    .filter((x) => x.n >= 3)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((x) => x.j);
}

// ------------------------------------------------------------ blocks

const CAPTCHA_MARKERS = /g-recaptcha|grecaptcha|h-captcha|hcaptcha|cf-turnstile|challenge-platform|cf-chl|friendlycaptcha/i;

/** A login or captcha in the way, in plain words, or null. */
export function blockHint(html: string, status: number): string | null {
  if (status === 401) return "the portal answers 401 and asks for a login";
  if (status === 403) return "the portal answers 403 Forbidden: access needs a login or is refused";
  if (/<input\b[^>]*type\s*=\s*["']?password/i.test(html)) return "the page shows a login form";
  if (CAPTCHA_MARKERS.test(html)) return "the page shows a captcha";
  return null;
}

// ------------------------------------------------------------ compressing for the model

const KEEP_ATTRS = new Set(["id", "class", "href", "name", "role", "datetime", "title", "type", "value", "action", "method", "rel", "lang"]);
const DROP_TAGS = "script,style,noscript,svg,iframe,canvas,template,link,meta,img,picture,video,audio,source,br,hr";

function signature($: cheerio.CheerioAPI, el: Element): string {
  return `${el.tagName}.${($(el).attr("class") ?? "").trim().split(/\s+/).sort().join(".")}`;
}

/**
 * A small view of the page for the model: noise removed, only selector-relevant attributes, long texts
 * cut, and runs of similar siblings collapsed to 2 with a count. Never raw HTML.
 */
export function compressHtml(html: string, maxChars = PAGE_CHARS): string {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim();
  $(DROP_TAGS).remove();
  $("*")
    .contents()
    .filter((_, n) => n.type === "comment")
    .remove();
  $("*").each((_, n) => {
    const el = n as Element;
    for (const name of Object.keys(el.attribs ?? {})) {
      if (!KEEP_ATTRS.has(name) && !name.startsWith("data-") && !name.startsWith("aria-label")) delete el.attribs[name];
      else if ((el.attribs[name] ?? "").length > 160) el.attribs[name] = el.attribs[name]!.slice(0, 160) + "…";
    }
  });
  // Find the list region before collapsing: the parent with the longest run of similar children.
  let best: { el: Element; run: number } | null = null;
  for (const p of $("body *").toArray() as Element[]) {
    const kids = $(p).children().toArray() as Element[];
    let i = 0;
    while (i < kids.length) {
      const sig = signature($, kids[i]!);
      let j = i + 1;
      while (j < kids.length && signature($, kids[j]!) === sig) j++;
      const textual = $(kids[i]!).text().trim().length > 20;
      if (j - i >= 3 && textual && (!best || j - i > best.run)) best = { el: p, run: j - i };
      i = j;
    }
  }
  if (best) $(best.el).attr("data-wt-list", String(best.run));
  // Collapse repeated siblings, deepest first so inner runs are counted before outer ones.
  const parents = $("*").toArray().reverse();
  for (const p of parents) {
    const kids = $(p).children().toArray() as Element[];
    let i = 0;
    while (i < kids.length) {
      const sig = signature($, kids[i]!);
      let j = i + 1;
      while (j < kids.length && signature($, kids[j]!) === sig) j++;
      const run = j - i;
      if (run > 2) {
        for (const extra of kids.slice(i + 2, j)) $(extra).remove();
        $(kids[i + 1]!).after(`<!-- ${run - 2} more ${kids[i]!.tagName} like these -->`);
      }
      i = j;
    }
  }
  // Shorten long texts.
  $("*")
    .contents()
    .each((_, n: AnyNode) => {
      if (n.type === "text") {
        const t = (n as unknown as { data: string }).data.replace(/\s+/g, " ");
        (n as unknown as { data: string }).data = t.length > 120 ? t.slice(0, 120) + "…" : t;
      }
    });
  const tidy = (h: string) => h.replace(/\n\s*\n+/g, "\n").replace(/>\s+</g, ">\n<");
  const marked = $("[data-wt-list]").first();
  let region = "";
  if (marked.length) {
    const path = marked
      .parents()
      .toArray()
      .reverse()
      .map((e) => describe($, e as Element))
      .concat(describe($, marked.get(0) as Element))
      .join(" > ");
    region = `<!-- the longest repeated list on the page (${marked.attr("data-wt-list")} similar items) is inside: ${path} -->\n${tidy($.html(marked))}`;
    marked.removeAttr("data-wt-list");
    region = region.replace(/ data-wt-list="\d+"/, "");
  }
  const body = tidy($("body").html() ?? $.root().html() ?? "");
  const whole = `<!-- title: ${title} -->\n${body}`;
  if (whole.length <= maxChars) return whole;
  // Too long: the list region first (it is what the recipe needs), then as much of the page as fits.
  if (region) {
    const head = `<!-- title: ${title} -->\n${region.slice(0, Math.floor(maxChars * 0.6))}\n<!-- whole page from the top: -->\n`;
    return head + body.slice(0, Math.max(0, maxChars - head.length)) + "\n<!-- …page cut here -->";
  }
  return whole.slice(0, maxChars) + "\n<!-- …page cut here -->";
}

function describe($: cheerio.CheerioAPI, el: Element): string {
  const id = $(el).attr("id");
  const cls = ($(el).attr("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
  return `${el.tagName}${id ? `#${id}` : ""}${cls.map((c) => `.${c}`).join("")}`;
}

/** JSON with arrays cut to 2 items and long strings shortened. */
export function compressJson(v: unknown, maxChars = JSON_SAMPLE_CHARS): string {
  const walk = (x: unknown, depth: number): unknown => {
    if (typeof x === "string") return x.length > 140 ? x.slice(0, 140) + "…" : x;
    if (x === null || typeof x !== "object") return x;
    if (depth > 7) return "…";
    if (Array.isArray(x)) {
      const head = x.slice(0, 2).map((y) => walk(y, depth + 1));
      return x.length > 2 ? [...head, `…${x.length - 2} more items`] : head;
    }
    return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [k, walk(y, depth + 1)]));
  };
  const s = JSON.stringify(walk(v, 0), null, 1);
  return s.length > maxChars ? s.slice(0, maxChars) + "\n…cut" : s;
}

/** Same-site links with their text, for finding the real list page and pagination. */
export function linkList(html: string, base: string, max = LINKS_MAX): string[] {
  const $ = cheerio.load(html);
  const host = (() => {
    try {
      return new URL(base).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const seen = new Set<string>();
  const out: string[] = [];
  $("a[href]").each((_, el) => {
    if (out.length >= max) return;
    const text = $(el).text().replace(/\s+/g, " ").trim().slice(0, 70);
    let href: string;
    try {
      href = new URL($(el).attr("href")!, base).toString();
    } catch {
      return;
    }
    if (!/^https?:/.test(href) || seen.has(href)) return;
    if (!new URL(href).hostname.replace(/^www\./, "").endsWith(host)) return;
    seen.add(href);
    out.push(`${text || "(no text)"} -> ${href}`);
  });
  return out;
}

const ZONES: Record<string, [string, string]> = {
  de: ["DE", "Europe/Berlin"], nl: ["NL", "Europe/Amsterdam"], fr: ["FR", "Europe/Paris"], es: ["ES", "Europe/Madrid"],
  pl: ["PL", "Europe/Warsaw"], it: ["IT", "Europe/Rome"], at: ["AT", "Europe/Vienna"], be: ["BE", "Europe/Brussels"],
  ie: ["IE", "Europe/Dublin"], pt: ["PT", "Europe/Lisbon"], se: ["SE", "Europe/Stockholm"], no: ["NO", "Europe/Oslo"],
  dk: ["DK", "Europe/Copenhagen"], fi: ["FI", "Europe/Helsinki"], cz: ["CZ", "Europe/Prague"], ch: ["CH", "Europe/Zurich"],
  lu: ["LU", "Europe/Luxembourg"], gr: ["GR", "Europe/Athens"], ro: ["RO", "Europe/Bucharest"], hu: ["HU", "Europe/Budapest"],
  sk: ["SK", "Europe/Bratislava"], si: ["SI", "Europe/Ljubljana"], hr: ["HR", "Europe/Zagreb"], bg: ["BG", "Europe/Sofia"],
  lt: ["LT", "Europe/Vilnius"], lv: ["LV", "Europe/Riga"], ee: ["EE", "Europe/Tallinn"], uk: ["GB", "Europe/London"],
};

/** Country and zone guessed from the domain, as a hint only; the model may know better. */
export function zoneHint(url: string): string {
  try {
    const tld = new URL(url).hostname.split(".").pop() ?? "";
    const z = ZONES[tld];
    return z ? `Domain suggests country ${z[0]}, time zone ${z[1]}.` : "The domain does not tell the country; read it from the page.";
  } catch {
    return "";
  }
}

// ------------------------------------------------------------ prompts

export const SYSTEM_PROMPT = `You write RECIPES: JSON data that tells a deterministic extractor how to read the list of OPEN public tenders on a procurement portal. You never write code. The extractor runs your recipe with no model, so every selector must work on the real page you are shown.

Answer with one step:
- "recipe": a full recipe in "recipe".
- "navigate": the shown page is not the tender list (a landing page, a summary page, a search form whose results are on another address). Put the absolute address of the list in "navigateTo". Only use addresses you saw in the links, the page or the JSON calls.
- "give_up": the list cannot be read without a login, a captcha, or a browser click flow. Say why in "reason".

Recipe rules (schemaVersion is 1):
- tier: prefer "jsonApi" when a JSON call the page made lists the tenders (use its exact url, method and POST body), then "feed" (RSS/Atom), then "html". Never "browser": it is not supported.
- timeZone: the IANA zone of the portal's country (times on pages are local). countryCode: two letters or null.
- list.request.url may contain {page}, {offset}, {pageSize}, {today} (YYYY-MM-DD in timeZone) and {daysAgo:N}. Pagination: none | pageParam (start, maxPages) | offsetParam (pageSize, maxPages) | nextLink (selector to the next page link). maxPages at most 40.
- list.item: CSS selector (html/feed) or JSONPath (jsonApi, e.g. "$.content[*]") that matches ONE element per tender.
- list.emptyText: words the portal shows when there are no tenders (e.g. "Keine Ergebnisse").
- listFields and detail.fields map field names to a selector, evaluated INSIDE one item (CSS relative to the item; JSONPath relative to the item, "$.x" means item.x). A selector uses one of: css (+ attr to read an attribute, e.g. "href"), jsonPath, label (the label text next to the value, e.g. "Vergabestelle"), const (a template like "https://site/t/{id}"). regex refines the text (first capture group wins). all:true collects every match.
- Field names: id (the portal's own stable identifier, never a row number), url (the tender's OWN page, not a summary or search page), title, buyerName (the public body that buys), publicationDate, submissionDeadline, referenceNumber (the buyer's file number), description, procedureType, contractNature, cpvCodes (all:true), postalCode, city, countryCode, withdrawn (a value that is true when cancelled).
- parse: date | datetime | cpv | url | procedureType | contractNature | postalCode | text. Dates in any European format are fine; add "format" (e.g. "dd.MM.yyyy HH:mm") only if unusual. The deadline needs a time; if the page shows only a date, still map it (it will become null, never a guess).
- detail: { urlFrom: "url" (a field name) or a template like "https://site/api/{id}", fields: {...} } for values only on the tender's own page. Use it when the list lacks buyer, deadline, reference or CPV.
- documents: { hops: [selectors leading to the page that lists files], files: selector with all:true for the file links, via: "http" }. It starts on the detail page if there is one, else on the tender's own page (url); the extractor follows HTTP redirects and keeps cookies. files.css matches the download links (attr defaults to "href"); pick the tender's own file list (e.g. a table of attachments), never links that every page has (help, terms, manuals). Use hops only when the files are on another page (a "documents" tab). Tenders without files are fine. After your first draft you are shown one tender's own page with the links that look like files; use it. Use null only when the tender pages list no files at all.
- withdrawnText: words that mean the buyer cancelled the tender.
- A WRONG VALUE IS WORSE THAN A MISSING ONE. Leave a field out rather than guess; never map a field to something that only looks similar.
- Only open tenders: if the portal lists awards or past notices too, use a filter in the request or a JSONPath filter like "$.items[?(@.status=='open')]". If its default list shows current tenders, use it as is: closed ones are recognised later by their deadline.
- Do not give up because the page view is cut: the repeated list is shown first, with its location. Write the best recipe you can; the dry-run will tell you exactly what to fix.`;

function describeLook(l: Look): string {
  const parts = [`Address: ${l.url} (HTTP ${l.status})`, zoneHint(l.url)];
  if (l.feeds.length) parts.push(`Feeds linked from the page:\n${l.feeds.join("\n")}`);
  if (l.json.length) {
    parts.push(
      "JSON calls the page made (most list-like first):\n" +
        l.json.map((j, i) => `#${i + 1} ${j.method} ${j.url}${j.postData ? `\nPOST body: ${j.postData.slice(0, 600)}` : ""}\n${compressJson(j.data)}`).join("\n\n"),
    );
  }
  const html = l.rendered && l.rendered.length > l.raw.length * 0.8 ? l.rendered : l.raw;
  parts.push(`Links on the page:\n${linkList(html, l.url).join("\n")}`);
  parts.push(`Page (${l.rendered ? "after JavaScript" : "as served"}, compressed: similar rows collapsed to 2):\n${compressHtml(html)}`);
  if (l.rendered && html !== l.raw) parts.push(`Note: the page as served has ${l.raw.length} characters; the extractor does NOT run JavaScript, so an html recipe only works if the list is in the served HTML. Otherwise use the JSON call.`);
  return parts.filter(Boolean).join("\n\n");
}

// ------------------------------------------------------------ judging a dry-run

const REQUIRED = ["id", "url", "title", "buyerName", "publicationDate", "submissionDeadline"] as const;

export interface Judgement {
  /** Problems that must be fixed before the recipe is used. */
  errors: string[];
  /** Missing values worth a second look; they block only the first draft. */
  warnings: string[];
  /**
   * Documents not mapped, or mapped to the wrong files. They block the first draft, and the second too
   * when the tender's own page shows links that look like files.
   */
  docs: string[];
}

/** Turns a dry-run into exact, actionable problems for the model. Pure; no network. */
export function judgeSample(recipe: Recipe, read: ReadOutcome, listUrl: string): Judgement {
  const errors: string[] = [];
  const warnings: string[] = [];
  const docs: string[] = [];
  if (read.kind !== "ok") return { errors: [`The dry-run did not read: ${read.reason}`], warnings, docs };
  const t = read.tenders;
  const d = read.diagnostics;
  if (t.length === 0) {
    if (d.emptyStateText) return { errors, warnings: [`The portal says "${d.emptyStateText}": no tenders right now, so fields could not be checked.`], docs };
    errors.push(
      d.itemsSeen === 0
        ? `list.item "${recipe.list.item}" matched nothing on ${d.listPages} list page(s) (${d.requests} requests). Check the selector against the page and the request address.`
        : `list.item matched ${d.itemsSeen} elements, but none had both an id and an absolute url. Check the id and url rules.`,
    );
    return { errors, warnings, docs };
  }
  for (const f of REQUIRED) {
    const fill = d.fieldFill[f] ?? { filled: 0, total: t.length };
    const hasRule = f in recipe.listFields || f in (recipe.detail?.fields ?? {});
    if ((f === "id" || f === "url") && fill.filled < fill.total) errors.push(`${f} is missing on ${fill.total - fill.filled} of ${fill.total} tenders.`);
    else if (f === "title" && fill.filled < Math.ceil(fill.total * 0.8)) errors.push(`title found on only ${fill.filled} of ${fill.total} tenders.`);
    // buyerName, publicationDate and submissionDeadline may be null when a portal does not show them
    // (the watch checks accept that). A missing rule is a hint for the first draft; a rule that matches
    // nothing is wrong and must be fixed or removed.
    else if (!hasRule)
      warnings.push(`There is no rule for ${f}. If the list or the tender's own page shows it, add one (detail.fields for the tender page); if the portal does not show it, leave it out.`);
    else if (fill.filled === 0)
      errors.push(`The ${f} rule matched on none of ${fill.total} tenders. Fix it (the tender's own page may show it: detail.fields), or remove it if the portal does not show ${f}.`);
    else if (fill.filled < fill.total / 2) warnings.push(`${f} found on only ${fill.filled} of ${fill.total} tenders.`);
  }
  if (!recipe.documents) {
    docs.push("There is no documents rule, so every tender would be served without its files. Find where the tender's own page lists its documents (links to PDF/ZIP or a 'documents' tab) and add documents.hops/files.");
  } else if (t.every((x) => x.documentRefs.length === 0 && !x.documentRefsPending)) {
    docs.push(`The documents rule found no file on any of ${t.length} tenders. Check documents.hops and documents.files against the tender's own page.`);
  } else {
    const withRefs = t.filter((x) => x.documentRefs.length > 0);
    if (withRefs.length >= 3) {
      const shared = withRefs[0]!.documentRefs.map((r) => r.url).filter((u) => withRefs.every((x) => x.documentRefs.some((r) => r.url === u)));
      if (shared.length)
        docs.push(
          `The documents rule returns ${shared.slice(0, 2).join(" and ")} on every tender: that is a file of the site (help, terms, manual), not of one tender. Narrow documents.files to the tender's own file list so it is left out.`,
        );
    }
  }
  const ids = t.map((x) => x.id);
  if (new Set(ids).size < ids.length) errors.push("Some tenders share an id; the id must be the portal's own unique identifier.");
  const urls = t.map((x) => x.url);
  if (t.length > 1 && new Set(urls).size === 1) errors.push(`Every tender has the same url (${urls[0]}): the url must be each tender's own page.`);
  const norm = (u: string) => u.replace(/[#?].*$/, "").replace(/\/$/, "");
  if (urls.some((u) => norm(u) === norm(listUrl))) errors.push("A tender url points back to the list page; it must be the tender's own page.");
  if (/^\d{1,3}$/.test(ids[0] ?? "") && ids.every((id, i) => id === String(Number(ids[0]) + i))) errors.push("The ids look like row numbers (1, 2, 3 …); use the portal's own identifier.");
  const year = new Date().getFullYear();
  const odd = t.filter((x) => x.submissionDeadline && (Number(x.submissionDeadline.slice(0, 4)) < year - 1 || Number(x.submissionDeadline.slice(0, 4)) > year + 6));
  if (odd.length) errors.push(`${odd.length} deadlines are implausible (e.g. ${odd[0]!.submissionDeadline}); the deadline rule reads the wrong value.`);
  const inverted = t.filter((x) => x.publicationDate && x.submissionDeadline && x.submissionDeadline.slice(0, 10) < x.publicationDate);
  if (inverted.length) errors.push(`${inverted.length} tenders have a deadline before their publication date; one of the two rules reads the wrong value.`);
  // A deadline on the publication day is rare; on most tenders it means the rule reads the publication date.
  const both = t.filter((x) => x.publicationDate && x.submissionDeadline);
  const sameDay = both.filter((x) => x.submissionDeadline!.slice(0, 10) === x.publicationDate);
  if (both.length >= 2 && sameDay.length >= Math.ceil(both.length * 0.8))
    errors.push(`The deadline equals the publication date on ${sameDay.length} of ${both.length} tenders: the submissionDeadline rule reads the publication date. Point it at the deadline (Angebotsfrist, date limite, plazo, termin składania, sluitingsdatum …).`);
  return { errors, warnings, docs };
}

// ------------------------------------------------------------ one tender's own page, for documents

const FILE_EXT = /\.(pdf|zip|rar|7z|gz|tar|docx?|xlsx?|odt|ods|odg|rtf|txt|xml|csv|p7s|p7m|xades|asice|dwg|dxf|jpe?g|png|tiff?)(?:$|[?#])/i;
const FILE_WORDS =
  /download|herunterlad|t[ée]l[ée]charg|descarg|scaric|pobierz|st[aá]hn|let[öo]lt|ladda|lataa|\bfiles?\b|\/file|datei|fichier|plik|attach|anlage|unterlage|dokument|document|bijlage|allegat|anexo|anhang|za[łl][aą]cznik|piece|pièce/i;

export interface TenderPageView {
  /** Text for the model. */
  text: string;
  /** How many links on the page look like files or downloads. */
  fileLinks: number;
  /** The page itself, kept to check later drafts' documents.files against it without another request. */
  page?: { url: string; body: string };
}

/**
 * How a draft's documents.files selector fares on the tender page the model was shown: the exact
 * number of matches and what the first one links to. Null when it cannot be checked (hops, JSON). Pure.
 */
export function checkFilesRule(recipe: Recipe, page: { url: string; body: string }): string | null {
  const rule = recipe.documents;
  if (!rule || (rule.hops ?? []).length > 0 || !rule.files.css || rule.files.label !== undefined || rule.files.const !== undefined) return null;
  const t = page.body.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return null;
  const $ = cheerio.load(page.body);
  let n = 0;
  let first = "";
  try {
    const found = $(rule.files.css);
    n = found.length;
    const attr = rule.files.attr ?? "href";
    first = found.first().attr(attr) ?? found.first().find(`[${attr}]`).first().attr(attr) ?? "";
  } catch (e) {
    return `documents.files.css "${rule.files.css}" is not a valid selector: ${(e as Error).message.slice(0, 120)}.`;
  }
  return n === 0
    ? `On the tender page you were shown (${page.url}), documents.files.css "${rule.files.css}" matches no element. Compare it with the file links listed there (href exactly as written).`
    : `On the tender page you were shown (${page.url}), documents.files.css "${rule.files.css}" matches ${n} element(s); the first gives ${first ? `"${first.slice(0, 120)}"` : `no ${rule.files.attr ?? "href"}`}.`;
}

/** Where the Extractor starts looking for documents: the detail page if the recipe has one, else the tender's url. */
export function documentsStart(recipe: Recipe, t: ExtractedTender): string | null {
  const from = recipe.detail?.urlFrom;
  if (!from || from === "url") return t.url || null;
  const rec = t as unknown as Record<string, unknown>;
  if (!from.includes("{")) return typeof rec[from] === "string" ? (rec[from] as string) : t.url || null;
  let missing = false;
  const url = from.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = rec[k];
    if (typeof v !== "string" && typeof v !== "number") missing = true;
    return encodeURIComponent(String(v ?? ""));
  });
  return missing ? null : url;
}

/**
 * One tender's own page for the model, focused on what the documents rule needs: links that look like
 * files or downloads, grouped by where they sit, and the markup around the biggest group. Pure.
 */
export function tenderPageView(body: string, url: string, status: number, contentType = ""): TenderPageView {
  const head = `The page where documents start for the first tender: ${url} (HTTP ${status}).`;
  const trimmed = body.trimStart();
  if (/json/i.test(contentType) || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { text: `${head} It is JSON (use jsonPath in documents.files, or hops to an HTML page):\n${compressJson(JSON.parse(body), 3000)}`, fileLinks: 0 };
    } catch {
      // not JSON after all
    }
  }
  const $ = cheerio.load(body);
  $("script,style,noscript,svg,template").remove();
  type Hit = { el: Element; href: string; raw: string; chain: string; label: string };
  const hits: Hit[] = [];
  $("a[href], [data-href], [data-url], [download]").each((_, n) => {
    const el = n as Element;
    const raw = $(el).attr("href") ?? $(el).attr("data-href") ?? $(el).attr("data-url") ?? "";
    if (!raw || /^(#|mailto:|tel:|javascript:)/i.test(raw.trim())) return;
    let href: string;
    try {
      href = new URL(raw.trim(), url).toString();
    } catch {
      return;
    }
    if (!/^https?:/.test(href)) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const attrs = [$(el).attr("class"), $(el).attr("title"), $(el).attr("aria-label"), $(el).attr("download")].filter(Boolean).join(" ");
    let path = href;
    try {
      path = new URL(href).pathname;
    } catch {
      // keep the whole address
    }
    if (!FILE_EXT.test(path) && !FILE_EXT.test(text) && !FILE_WORDS.test(`${path} ${attrs} ${text}`) && $(el).attr("download") === undefined) return;
    // Ancestors in short; the link itself with every class, since its own class is usually the best selector.
    const own = `${el.tagName}${$(el).attr("id") ? `#${$(el).attr("id")}` : ""}${($(el).attr("class") ?? "").trim().split(/\s+/).filter(Boolean).map((c) => `.${c}`).join("")}`;
    const chain = [...$(el).parents().toArray().slice(0, 3).reverse().map((e) => describe($, e as Element)), own].join(" > ");
    const extra = ["title", "aria-label", "download"].map((a) => ($(el).attr(a) ? `${a}="${$(el).attr(a)!.slice(0, 50)}"` : "")).filter(Boolean).join(" ");
    hits.push({ el, href, raw: raw.trim(), chain, label: `"${text.slice(0, 60) || "(no text)"}"${extra ? ` [${extra}]` : ""}` });
  });
  if (hits.length === 0) {
    const links = linkList(body, url, 40);
    return {
      text: `${head} No link on it looks like a file. If the files are on another page (a "documents" tab), add documents.hops to reach it; if this page needs JavaScript or a login for its files, set documents to null.\nLinks on the page:\n${links.join("\n")}\nPage (compressed):\n${compressHtml(body, 4000)}`,
      fileLinks: 0,
    };
  }
  const groups = new Map<string, Hit[]>();
  for (const h of hits) groups.set(h.chain, [...(groups.get(h.chain) ?? []), h]);
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
  // The address as written in the page matters: an attribute selector like a[href^='/x'] sees only that.
  const shown = (h: Hit) => `${h.label} href="${h.raw.slice(0, 120)}"${h.raw !== h.href ? ` (resolves to ${h.href.slice(0, 120)})` : ""}`;
  const lines = sorted.slice(0, 15).map((g) => `- ${g.length}× ${g[0]!.chain}: ${g.slice(0, 2).map(shown).join(" | ")}`);
  // The markup around the biggest group: the nearest ancestor that holds all of its links.
  const big = sorted[0]!;
  let around: Element = big[0]!.el;
  for (let i = 0; i < 10; i++) {
    const p = $(around).parent().get(0) as Element | undefined;
    if (!p || p.type !== "tag" || p.tagName === "body" || p.tagName === "html") break;
    around = p;
    if (["table", "ul", "ol", "dl", "section", "article"].includes(p.tagName) && big.every((h) => $.contains(p, h.el))) break;
  }
  const context = compressHtml(`<html><body>${$.html(around)}</body></html>`, 3000).replace(/^<!-- title:  -->\n/, "");
  return {
    text: `${head}\nLinks on it that look like files or downloads, grouped by where they sit (count × element path: examples, with href exactly as written in the page). Prefer the links' own classes or their container for documents.files.css; an attribute selector must match the href as written, not as resolved. A file that every tender page shows (help, terms, manual) is not a tender document:\n${lines.join("\n")}\nMarkup around the largest group (compressed):\n${context}`,
    fileLinks: hits.length,
  };
}

function showSample(read: ReadOutcome): string {
  if (read.kind !== "ok" || read.tenders.length === 0) return "";
  const pick = (x: ExtractedTender) => {
    const { documentRefs, ...rest } = x;
    return { ...rest, documentRefs: documentRefs.slice(0, 3).map((r) => r.url) };
  };
  return `What your recipe extracted (first 2 of ${read.tenders.length}):\n${JSON.stringify(read.tenders.slice(0, 2).map(pick), null, 1).slice(0, 3000)}`;
}

// ------------------------------------------------------------ the loop

export interface ModelAttachDeps {
  look: (ctx: PortalContext, url: string) => Promise<Look>;
  sample: (recipe: Recipe, ctx: PortalContext) => Promise<ReadOutcome>;
  read: (recipe: Recipe, ctx: PortalContext) => Promise<ReadOutcome>;
  /** The first items the list selector matches, raw: what the field rules ran against. */
  items: (recipe: Recipe, ctx: PortalContext) => Promise<{ status: number; items: string[]; pageStart: string }>;
  /** One page as served (the tender's own page, for documents). Defaults to one `ctx.http` request. */
  page?: (ctx: PortalContext, url: string) => Promise<{ url: string; status: number; text: string; contentType: string }>;
}

const defaultDeps: ModelAttachDeps = {
  look,
  sample: (r, c) => readSample(r, c),
  read: (r, c) => extractor.read(r, c),
  items: (r, c) => sampleItems(r, c),
  page: fetchText,
};

/** One tender's own page for the documents rule, fetched once per attach. Never throws (except on abort). */
async function showTenderPage(deps: ModelAttachDeps, recipe: Recipe, read: ReadOutcome, ctx: PortalContext): Promise<TenderPageView | null> {
  if (read.kind !== "ok" || read.tenders.length === 0) return null;
  const start = documentsStart(recipe, read.tenders[0]!);
  if (!start) return null;
  try {
    const got = await (deps.page ?? fetchText)(ctx, start);
    return { ...tenderPageView(got.text, got.url, got.status, got.contentType), page: { url: got.url, body: got.text } };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    return { text: `Opening the first tender's page ${start} failed: ${(e as Error).message}.`, fileLinks: 0 };
  }
}

/** Shows the model the item its rules ran against, compressed. Never throws. */
async function showItems(deps: ModelAttachDeps, recipe: Recipe, ctx: PortalContext): Promise<string> {
  try {
    const got = await deps.items(recipe, ctx);
    if (got.items.length === 0) return `On the list page (HTTP ${got.status}) list.item matched no element. The page starts with:\n${got.pageStart}`;
    const first = got.items[0]!;
    const shown = recipe.tier === "jsonApi" ? compressJson(JSON.parse(first), 2500) : compressHtml(first, 2500).replace(/^<!-- title:  -->\n/, "");
    return `The first item list.item matched, exactly as your field rules see it (compressed):\n${shown}`;
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    return "";
  }
}

const isRobots = (e: unknown) => e instanceof Error && /robots\.txt/i.test(e.message);

function modelFailure(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/OPENAI_API_KEY|MODEL_(SMART|FAST)/.test(m)) return `No model is configured (${m}), so an unknown portal cannot be learned.`;
  return `The model call failed: ${m.slice(0, 200)}`;
}

/** Learns an unknown portal with the model. Returns ok only for a recipe that passed a dry-run and a full read. */
export async function attachWithModel(ctx: PortalContext, deps: ModelAttachDeps = defaultDeps): Promise<AttachOutcome> {
  let current: Look;
  const history: string[] = [];
  try {
    current = await deps.look(ctx, ctx.url);
  } catch (e) {
    if (ctx.signal.aborted) return { kind: "failed", reason: "The attach was cancelled." };
    if (!isRobots(e)) return { kind: "failed", reason: `The portal could not be reached: ${(e as Error).message}.` };
    // robots.txt keeps us off this address; the site's home page may link an allowed list or feed.
    const home = new URL("/", ctx.url).toString();
    ctx.log(`robots.txt does not allow ${ctx.url}; looking at the home page for an allowed list or feed.`, "warn");
    try {
      current = await deps.look(ctx, home);
    } catch (e2) {
      if (ctx.signal.aborted) return { kind: "failed", reason: "The attach was cancelled." };
      return { kind: "failed", reason: "The portal's robots.txt does not allow reading its tender list, so we stay away." };
    }
    history.push(`Note: robots.txt forbids the address the operator gave (${ctx.url}); never use it. You are looking at the home page: find an allowed tender list, search result address or feed (RSS/Atom, open data).`);
  }
  if (current.status >= 500) return { kind: "failed", reason: `The portal answers HTTP ${current.status}; it is not reachable right now.` };
  let hint = blockHint(current.raw, current.status);
  if (current.status === 401 || current.status === 403) return { kind: "blocked", reason: `${capital(hint!)}.` };

  let navigations = 0;
  /** True once any draft read at least one tender: then a login box on the page is not what stops us. */
  let everRead = false;
  let rounds = 0;
  /** The first tender's own page goes to the model once per list page, for the documents rule. */
  let tenderPageShown = false;
  let fileLinksSeen = false;
  let tenderPage: { url: string; body: string } | null = null;
  /** Drafts that were dry-run (rounds also count malformed answers and refused navigations). */
  let drafts = 0;
  let lastProblem = "the model did not propose a usable recipe";

  while (rounds < MAX_RECIPE_ROUNDS) {
    if (ctx.signal.aborted) return { kind: "failed", reason: "The attach was cancelled." };
    const user = [describeLook(current), ...history].join("\n\n---\n\n");
    let step: CartographerStep;
    try {
      step = await ctx.llm.json({ purpose: "attach", model: "smart", system: SYSTEM_PROMPT, user, schema: CartographerStep });
    } catch (e) {
      if (ctx.signal.aborted) return { kind: "failed", reason: "The attach was cancelled." };
      const msg = modelFailure(e);
      // Only a malformed answer is worth another round (the exact error goes back); a missing key,
      // a network or provider error would fail the same way again.
      const malformed = e instanceof SyntaxError || (e instanceof Error && e.name === "ZodError");
      if (!malformed) return { kind: "failed", reason: msg };
      rounds += 1;
      lastProblem = msg;
      ctx.log(`The model's answer was not a valid step (round ${rounds} of ${MAX_RECIPE_ROUNDS}): ${msg.slice(0, 160)}`, "warn");
      history.push(`Your previous answer was not a valid step: ${msg}. Answer again with the exact JSON shape.`);
      continue;
    }

    if (step.action === "give_up") {
      ctx.log(`The model gave up: ${step.reason}`, "warn");
      const namesBlock = /log ?in|sign(ed)? ?in|password|account|registr|captcha|anmeld|zaloguj|iniciar sesi/i.test(step.reason);
      if (hint && !everRead && namesBlock) return { kind: "blocked", reason: `${capital(hint)}; ${lower(step.reason)}` };
      return { kind: "failed", reason: `Could not learn this portal: ${lower(step.reason)}` };
    }

    if (step.action === "navigate") {
      if (navigations >= MAX_NAVIGATIONS || !step.navigateTo) {
        rounds += 1;
        history.push(`Navigation is not possible any more (${navigations} hops used). Write a recipe for the page you have, or give up.`);
        continue;
      }
      navigations += 1;
      let target: string;
      try {
        target = new URL(step.navigateTo, current.url).toString();
      } catch {
        history.push(`"${step.navigateTo}" is not an address.`);
        rounds += 1;
        continue;
      }
      ctx.log(`Following to the tender list: ${target} (${step.reason})`);
      try {
        current = await deps.look(ctx, target);
      } catch (e) {
        if (ctx.signal.aborted) return { kind: "failed", reason: "The attach was cancelled." };
        history.push(`Opening ${target} failed: ${(e as Error).message}.`);
        continue;
      }
      hint = blockHint(current.raw, current.status) ?? hint;
      if (current.status === 401 || current.status === 403) return { kind: "blocked", reason: `${capital(blockHint(current.raw, current.status)!)}.` };
      history.length = 0; // a new page: earlier feedback was about the old one
      tenderPageShown = false;
      fileLinksSeen = false;
      tenderPage = null;
      continue;
    }

    // action === "recipe"
    rounds += 1;
    if (!step.recipe) {
      ctx.log(`The model chose a recipe but sent none (round ${rounds} of ${MAX_RECIPE_ROUNDS}).`, "warn");
      history.push("You chose recipe but sent no recipe.");
      continue;
    }
    const recipe = Recipe.parse(step.recipe);
    if (recipe.tier === "browser") {
      lastProblem = "the portal seems to need the browser tier, which the extractor does not support yet";
      ctx.log(`The model proposed a browser-tier recipe, which is not supported (round ${rounds} of ${MAX_RECIPE_ROUNDS}).`, "warn");
      history.push(`Round ${rounds}: tier "browser" is not supported. Use the JSON call the page makes, a feed, or the served HTML.`);
      continue;
    }
    ctx.log(`Trying a ${recipe.tier} recipe (draft ${rounds} of ${MAX_RECIPE_ROUNDS}).`);
    const sample = await deps.sample(recipe, ctx);
    if (sample.kind === "blocked" && !/robots\.txt/i.test(sample.reason)) return { kind: "blocked", reason: `${capital(sample.reason)}` };
    if (sample.kind === "ok" && sample.tenders.length > 0) everRead = true;
    const judged = judgeSample(recipe, sample, current.url);
    // Documents are easy to forget and invisible on the list page: the model sees one tender's own
    // page once, and when it shows links that look like files, a missing or wrong documents rule
    // blocks the second draft too. After that a recipe without documents is accepted.
    let docsView = "";
    drafts += 1;
    if (judged.docs.length && !tenderPageShown && (drafts <= 2 || judged.errors.length > 0) && sample.kind === "ok" && sample.tenders.length > 0) {
      const view = await showTenderPage(deps, recipe, sample, ctx);
      if (view) {
        tenderPageShown = true;
        fileLinksSeen = view.fileLinks > 0;
        docsView = view.text;
        tenderPage = view.page ?? null;
      }
    }
    // Later drafts: check the files selector against the page already shown, exactly, at no cost.
    const filesCheck = judged.docs.length && tenderPage ? checkFilesRule(recipe, tenderPage) : null;
    if (filesCheck) judged.docs.push(filesCheck);
    // Counted by drafts that were dry-run, so a malformed answer does not use up the hints.
    const docsBlock = drafts === 1 || (drafts === 2 && fileLinksSeen) ? judged.docs : [];
    const blocking = drafts === 1 ? [...judged.errors, ...judged.warnings, ...docsBlock] : [...judged.errors, ...docsBlock];
    if (blocking.length === 0) {
      if (judged.docs.length) ctx.log(`The recipe has no working documents rule: ${judged.docs[0]}`, "warn");
      ctx.log("The draft read cleanly; reading the whole list once.");
      const full = await deps.read(recipe, ctx);
      if (full.kind === "ok" && full.tenders.length > 0) {
        const golden = pickGolden(full.tenders);
        return {
          kind: "ok",
          recipe,
          golden,
          read: full,
          note: `Learned a ${recipe.tier} recipe in ${rounds} draft(s); ${full.tenders.length} tenders, ${golden.length} kept as golden records.`,
        };
      }
      if (full.kind === "blocked") return { kind: "blocked", reason: capital(full.reason) };
      lastProblem = full.kind === "ok" ? "the full read found no tenders" : full.reason;
      history.push(`Round ${rounds}: the dry-run passed but the full read failed: ${lastProblem}. Fix the pagination or request.`);
      continue;
    }
    lastProblem = blocking[0]!;
    ctx.log(`Draft ${rounds} needs fixes: ${blocking.slice(0, 2).join(" ")}`, "warn");
    const itemView = sample.kind === "ok" || sample.kind === "error" ? await showItems(deps, recipe, ctx) : "";
    history.push(
      `Round ${rounds}: your recipe was dry-run on the first list page.\nRecipe:\n${JSON.stringify(recipe)}\nProblems to fix:\n- ${blocking.join("\n- ")}\n${showSample(sample)}\n${itemView}${docsView ? `\n${docsView}` : ""}\nAnswer with a corrected full recipe.`,
    );
  }

  if (hint && !everRead) return { kind: "blocked", reason: `${capital(hint)}, and no tender list could be read without it.` };
  return { kind: "failed", reason: `Could not learn this portal in ${MAX_RECIPE_ROUNDS} drafts: ${lower(lastProblem)}` };
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function lower(s: string): string {
  const t = s.trim().replace(/\.$/, "");
  return (t.charAt(0).toLowerCase() + t.slice(1)) + ".";
}
