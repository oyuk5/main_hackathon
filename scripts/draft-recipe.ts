/**
 * Dev tool (person A): draft a recipe for a real portal with the model, then check it without the model.
 *
 *   npx tsx --env-file=.env scripts/draft-recipe.ts <portal list URL> [more URLs...]
 *
 * For each URL: loads the page in the polite browser (1 request/s, robots.txt), captures the JSON
 * the page fetches and a trimmed copy of its HTML, asks MODEL_SMART for a recipe (validated against
 * src/shared/recipe.ts), then re-fetches the list with plain HTTP and applies every rule by hand.
 * Writes scripts/recipes/<host>.draft.json and prints a fill report. Not used by the app: the real
 * Cartographer is person B's (src/attach/). Model calls land in DATA_DIR's ledger like any other.
 */
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { JSONPath } from "jsonpath-plus";
import { politeBrowser, politeHttp, robotsAllows, closeSharedBrowser } from "../src/platform/polite.js";
import { llmFor } from "../src/llm/client.js";
import { Recipe, type FieldRule } from "../src/shared/recipe.js";
import { store } from "../src/platform/store.js";
import { ZodError } from "zod";

const OUT = path.join(import.meta.dirname, "recipes");
const MAX_JSON = 6_000; // characters of each captured JSON answer shown to the model
const MAX_HTML = 24_000;

type Captured = { url: string; body: string };

const SYSTEM = `You write recipes for Watchtower, which reads public tender portals with plain code: no model call at runtime.
A recipe is declarative JSON matching the given schema. Choose the most stable tier the portal offers: "feed" (RSS/Atom), then "jsonApi" (a JSON endpoint the page calls), then "html" (server-rendered list), then "browser" (needs JavaScript and no usable JSON).
For jsonApi, list.item and every field use jsonPath ($ = the item for listFields). For html, list.item is a CSS selector and fields use css (+ attr for links), relative to the item.
Use parse "date" for dates, "datetime" for date-times, "url" for links (relative links are resolved against the page), "procedureType" and "contractNature" for those fields, "cpv" for CPV codes.
timeZone is the IANA zone of the portal's country. Target fields: id (the portal's own stable id), url (the tender's human page), title, buyerName, publicationDate, submissionDeadline, referenceNumber, description, procedureType, contractNature, cpvCodes.
Never invent: only map a field when the data you were shown contains it. A wrong value is worse than a missing one. Put list.request.url as the exact endpoint you saw, with {page} or {offset} placeholders when it pages.`;

function trimHtml(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, link, meta, iframe").remove();
  $("*").each((_, el) => {
    for (const a of Object.keys((el as { attribs?: Record<string, string> }).attribs ?? {})) {
      if (!["id", "class", "href", "data-id"].includes(a)) $(el).removeAttr(a);
    }
  });
  return ($("body").html() ?? "").replace(/\s+/g, " ").slice(0, MAX_HTML);
}

async function explore(url: string, signal: AbortSignal): Promise<{ html: string; json: Captured[]; finalUrl: string }> {
  const json: Captured[] = [];
  return politeBrowser(signal).withPage(async (page) => {
    page.on("response", async (res) => {
      const type = res.headers()["content-type"] ?? "";
      if (!/json/.test(type) || res.status() !== 200) return;
      try {
        const body = await res.text();
        if (body.length > 200 && body.length < 3_000_000) json.push({ url: res.url(), body });
      } catch {
        /* body gone after navigation */
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // JavaScript apps fetch their lists after load; every request waits for the 1/s gate.
    await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
    return { html: await page.content(), json, finalUrl: page.url() };
  });
}

function fill(template: string, pagination: Recipe["list"]["pagination"]): string {
  const start = pagination.type === "pageParam" ? pagination.start : 0;
  const size = pagination.type === "offsetParam" ? pagination.pageSize : 20;
  return template.replace("{page}", String(start)).replace("{offset}", "0").replace("{pageSize}", String(size));
}

function applyJson(rule: FieldRule, item: unknown): unknown {
  if (rule.const !== undefined) return rule.const;
  if (!rule.jsonPath) return undefined;
  let v = JSONPath({ path: rule.jsonPath, json: item as object, wrap: rule.all ?? false });
  if (rule.regex && typeof v === "string") v = new RegExp(rule.regex).exec(v)?.[1] ?? null;
  return v;
}

function applyCss($: cheerio.CheerioAPI, rule: FieldRule, item: cheerio.Cheerio<never>): unknown {
  if (rule.const !== undefined) return rule.const;
  if (!rule.css) return undefined;
  const el = item.find(rule.css).first();
  let v: string | undefined = rule.attr ? el.attr(rule.attr) : el.text().replace(/\s+/g, " ").trim();
  if (rule.regex && v) v = new RegExp(rule.regex).exec(v)?.[1];
  return v || null;
}

type Check = { items: number; note: string; rows: string[][] };

function rowsFor(values: unknown[][], fields: string[]): string[][] {
  return fields.map((f, i) => {
    const vals = values.map((v) => v[i]);
    const filled = vals.filter((v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)).length;
    return [f, `${filled}/${vals.length}`, JSON.stringify(vals[0] ?? null).slice(0, 70)];
  });
}

/**
 * Re-reads the list without the model and applies every list rule: plain HTTP for jsonApi and
 * html, the polite browser for browser-tier recipes. Feeds are not checked by this tool.
 */
async function handCheck(recipe: Recipe, signal: AbortSignal): Promise<Check> {
  if (recipe.tier === "feed") return { items: -1, note: "feed tier: not checked by this tool", rows: [] };
  const url = fill(recipe.list.request.url, recipe.list.pagination);
  const fields = Object.keys(recipe.listFields);
  const rules = Object.values(recipe.listFields);
  if (recipe.tier === "browser") {
    const html = await politeBrowser(signal).withPage(async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector(recipe.list.item, { timeout: 25_000 }).catch(() => {});
      return page.content();
    });
    const $ = cheerio.load(html);
    const items = $(recipe.list.item).toArray().map((el) => $(el) as cheerio.Cheerio<never>);
    return { items: items.length, note: `${items.length} items in the browser`, rows: rowsFor(items.slice(0, 5).map((it) => rules.map((r) => applyCss($, r, it))), fields) };
  }
  const res = await politeHttp(signal).fetch(url, {
    method: recipe.list.request.method,
    headers: { accept: recipe.tier === "jsonApi" ? "application/json" : "text/html", ...recipe.list.request.headers },
    body: recipe.list.request.body,
  });
  if (!res.ok) return { items: 0, note: `list answered HTTP ${res.status} at ${url}`, rows: [] };
  if (recipe.tier === "jsonApi") {
    const items = JSONPath({ path: recipe.list.item, json: await res.json() }) as unknown[];
    return { items: items.length, note: `${items.length} items on the first page`, rows: rowsFor(items.slice(0, 5).map((it) => rules.map((r) => applyJson(r, it))), fields) };
  }
  const $ = cheerio.load(await res.text());
  const items = $(recipe.list.item).toArray().map((el) => $(el) as cheerio.Cheerio<never>);
  return { items: items.length, note: `${items.length} items on the first page`, rows: rowsFor(items.slice(0, 5).map((it) => rules.map((r) => applyCss($, r, it))), fields) };
}

async function draft(url: string) {
  const signal = new AbortController().signal;
  const host = new URL(url).host.replace(/^www\./, "");
  console.log(`\n=== ${host}  ${url}`);
  if (!(await robotsAllows(url, signal))) return console.log("robots.txt disallows this page; skipped.");

  const t0 = Date.now();
  const seen = await explore(url, signal);
  // The longest JSON answers are usually the tender list; show the model up to 4.
  const json = seen.json.sort((a, b) => b.body.length - a.body.length).slice(0, 4);
  console.log(`explored in ${Math.round((Date.now() - t0) / 1000)} s: ${seen.json.length} JSON answers captured`);
  for (const j of json) console.log(`  json ${String(j.body.length).padStart(8)} chars  ${j.url.slice(0, 110)}`);

  const user = [
    `Portal list page: ${seen.finalUrl}`,
    ...json.map((j, i) => `JSON ANSWER ${i + 1} from ${j.url} (trimmed):\n${j.body.slice(0, MAX_JSON)}`),
    `PAGE HTML (scripts removed, trimmed):\n${trimHtml(seen.html)}`,
  ].join("\n\n");

  const t1 = Date.now();
  const before = store.ledger().reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  let feedback = "";
  let calls = 0;
  let accepted: { recipe: Recipe; check: Check } | null = null;
  // Up to 3 calls. A schema error, or a list rule that finds nothing on the live page, goes back as a correction.
  while (calls < 3 && !accepted) {
    calls++;
    let recipe: Recipe;
    try {
      recipe = await llmFor(null, null).json({ purpose: "attach", model: "smart", system: SYSTEM, user: user + feedback, schema: Recipe });
    } catch (e) {
      const issues = e instanceof ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message.split("\n")[0]!;
      console.log(`  call ${calls} rejected (schema): ${issues.slice(0, 200)}`);
      feedback = `\n\nYour previous answer did not match the schema: ${issues}. Answer again with a recipe that matches it exactly.`;
      continue;
    }
    const check = await handCheck(recipe, signal).catch((e): Check => ({ items: 0, note: `check failed: ${(e as Error).message.split("\n")[0]}`, rows: [] }));
    if (check.items === 0) {
      console.log(`  call ${calls} rejected (live check): tier ${recipe.tier}, item ${recipe.list.item}: ${check.note}`);
      feedback = `\n\nYour previous recipe (tier ${recipe.tier}, list.request.url ${recipe.list.request.url}, list.item ${recipe.list.item}) found no tenders on the live portal: ${check.note}. Use an endpoint and item selector that appear in the data above.`;
      continue;
    }
    accepted = { recipe, check };
  }
  const cost = store.ledger().reduce((s, r) => s + (r.cost_usd ?? 0), 0) - before;
  if (!accepted) return console.log(`no working recipe after ${calls} calls ($${cost.toFixed(4)}).`);
  const { recipe, check } = accepted;
  console.log(`drafted in ${Math.round((Date.now() - t1) / 1000)} s, ${calls} call(s), $${cost.toFixed(4)}: tier ${recipe.tier}, item ${recipe.list.item}`);
  console.log(`  list ${recipe.list.request.url}`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${host}.draft.json`), JSON.stringify(recipe, null, 2) + "\n");
  console.log(`hand-check: ${check.note}`);
  for (const [f, rate, sample] of check.rows) console.log(`  ${f!.padEnd(20)} ${rate!.padEnd(5)} ${sample}`);
}

for (const url of process.argv.slice(2)) {
  try {
    await draft(url);
  } catch (e) {
    console.log(`failed: ${(e as Error).message.split("\n")[0]}`);
  }
}
await closeSharedBrowser();
