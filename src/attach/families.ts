/**
 * Families: portals that run the same software read the same way. Owned by B.
 *
 * When the model Cartographer learns a portal whose software we recognise, its recipe is kept as a
 * template for that software, with the portal's own address replaced by {origin}. The next portal on
 * the same software gets the template re-based to its own address, dry-run with the Extractor and
 * judged like a model draft. Only a clean dry-run is used, and then the attach costs no model call.
 *
 * Precision over recall: a wrong family only costs a failed dry-run, but we still recognise software
 * only by signs that are specific to it (its own host, its own application paths), never by generic
 * ones such as a CMS generator tag or a "Java servlet" look.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "../platform/config.js";
import type { AttachOutcome, PortalContext, ReadOutcome } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";
import { nowWithOffset } from "../shared/time.js";
import { decode } from "./extractor.js";
import { judgeSample } from "./cartographer.js";
import { pickGolden } from "./golden.js";

// ------------------------------------------------------------ fingerprint

export interface FamilyPage {
  /** Address of the page after redirects. */
  url: string;
  /** The page as served (may be empty when it could not be fetched). */
  html: string;
}

export interface Family {
  /** Stable id, used as file name and as `recipe.family`. */
  id: string;
  name: string;
}

interface Signature extends Family {
  /** Why this signature is safe; kept next to the rule so it can be reviewed. */
  why: string;
  match(p: { url: URL; html: string; links: string[] }): boolean;
}

const hostIs = (u: URL, ...domains: string[]) => {
  const h = u.hostname.toLowerCase();
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
};

/** href/src/action values of the page, for path signatures. Cheap regex, no DOM needed. */
function attrLinks(html: string): string[] {
  const out: string[] = [];
  const re = /\b(?:href|src|action)\s*=\s*["']([^"']{1,500})["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 2000) out.push(m[1]!);
  return out;
}

const count = (links: string[], re: RegExp) => links.filter((l) => re.test(l)).length;

const COSINEX_PATH = /\/(?:VMP)?(?:Center|Satellite)\/[^?#]*\.do\b/i;

export const SIGNATURES: readonly Signature[] = [
  // Single-host SaaS or national platforms: the host itself is the signature.
  { id: "open-nexus", name: "Open Nexus platformazakupowa", why: "the platformazakupowa.pl host is Open Nexus' own SaaS", match: ({ url, html, links }) => hostIs(url, "platformazakupowa.pl") || (/open-?nexus/i.test(links.join(" ")) && count(links, /\/transakcja\/\d+/) >= 2) },
  { id: "mercell", name: "Mercell", why: "mercell.com and negometrix.com are Mercell's own hosts", match: ({ url }) => hostIs(url, "mercell.com", "negometrix.com") },
  { id: "placsp", name: "PLACSP", why: "contrataciondelestado.es is the Spanish state platform's own host", match: ({ url }) => hostIs(url, "contrataciondelestado.es") },
  { id: "deutsche-evergabe", name: "Deutsche eVergabe", why: "deutsche-evergabe.de is the SaaS' own host", match: ({ url }) => hostIs(url, "deutsche-evergabe.de") },
  { id: "achatpublic", name: "achatpublic.com", why: "achatpublic.com is the SaaS' own host", match: ({ url }) => hostIs(url, "achatpublic.com") },
  { id: "vortal", name: "Vortal", why: "vortal.biz is Vortal's own host", match: ({ url }) => hostIs(url, "vortal.biz") },
  // Installed software on many hosts: application paths that only that software uses.
  {
    id: "cosinex-vmp",
    name: "cosinex Vergabemarktplatz",
    why: "Struts *.do actions under /Center/ or /VMPCenter/ (and /Satellite/) are cosinex' application layout; a link to cosinex.de is its footer",
    match: ({ url, links }) => COSINEX_PATH.test(url.pathname) || count(links, COSINEX_PATH) >= 2 || links.some((l) => /^https?:\/\/(www\.)?cosinex\.de\b/i.test(l)),
  },
  {
    id: "healy-hudson",
    name: "Healy Hudson e-Vergabe",
    why: "the /NetServer/ servlet root is Healy Hudson's; a link to healy-hudson.com is its footer",
    match: ({ url, links }) => /^\/NetServer\//i.test(url.pathname) || count(links, /\/NetServer\/[A-Za-z]/) >= 2 || links.some((l) => /^https?:\/\/(www\.)?healy-hudson\.(com|de)\b/i.test(l)),
  },
  {
    id: "atexo-mpe",
    name: "Atexo LOCAL TRUST MPE",
    why: "PRADO pages named ?page=Entreprise.Entreprise… are Atexo MPE's public consultation pages",
    match: ({ url, links }) => /[?&]page=Entreprise\.Entreprise/i.test(url.search) || count(links, /[?&]page=Entreprise\.Entreprise/i) >= 2,
  },
];

/** The software family of a portal's first page, or null when not sure. */
export function fingerprint(page: FamilyPage): Family | null {
  let url: URL;
  try {
    url = new URL(page.url);
  } catch {
    return null;
  }
  const links = attrLinks(page.html ?? "");
  for (const s of SIGNATURES) if (s.match({ url, html: page.html ?? "", links })) return { id: s.id, name: s.name };
  return null;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** Fetches the operator's address once (through ctx.http) for the fingerprint. Never throws but on abort. */
export async function firstPage(ctx: PortalContext): Promise<FamilyPage> {
  try {
    const res = await ctx.http.fetch(ctx.url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { url: res.url || ctx.url, html: decode(bytes, res.headers.get("content-type") ?? "") };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    return { url: ctx.url, html: "" };
  }
}

// ------------------------------------------------------------ templates

export const ORIGIN = "{origin}";

export interface FamilyTemplate {
  family: string;
  savedAt: string;
  /** The portal the template was learned on (for the log and for path re-basing). */
  sourceUrl: string;
  /** The recipe with the source portal's origin replaced by {origin}. Not parsed: it is not a valid address yet. */
  recipe: unknown;
}

function originVariants(url: string): string[] {
  try {
    const u = new URL(url);
    const bare = u.host.replace(/^www\./i, "");
    return [`${u.protocol}//${bare}`, `${u.protocol}//www.${bare}`];
  } catch {
    return [];
  }
}

function mapStrings(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The recipe as a family template: every absolute address on the portal's own origin (with or without
 * www.) becomes {origin}. Null when the list itself is on another host: then it does not transfer.
 */
export function toTemplate(recipe: Recipe, portalUrls: string[], family: string): FamilyTemplate | null {
  const origins = [...new Set(portalUrls.flatMap(originVariants))].sort((a, b) => b.length - a.length);
  if (!origins.length) return null;
  const re = new RegExp(`(?:${origins.map(escapeRe).join("|")})(?=[/?#:]|$)`, "gi");
  const templ = mapStrings({ ...recipe, family }, (s) => s.replace(re, ORIGIN)) as Recipe;
  if (!templ.list.request.url.startsWith(ORIGIN)) return null;
  return { family, savedAt: nowWithOffset(), sourceUrl: portalUrls[0]!, recipe: templ };
}

/**
 * When the same software is mounted under another first path segment (e.g. /Center/… on one host and
 * /VMPCenter/… on another), the operator's two addresses end the same way and differ only at the start.
 * Returns that start on both sides, or null.
 */
export function pathPrefixShift(sourcePath: string, targetPath: string): [string, string] | null {
  const a = sourcePath.split("/").filter(Boolean);
  const b = targetPath.split("/").filter(Boolean);
  let k = 0;
  while (k < a.length && k < b.length && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
  const pa = a.slice(0, a.length - k);
  const pb = b.slice(0, b.length - k);
  if (k < 2 || pa.length > 2 || pb.length > 2 || pa.join("/") === pb.join("/") || pa.length === 0 || pb.length === 0) return null;
  return [`/${pa.join("/")}`, `/${pb.join("/")}`];
}

/** The template re-based onto another portal's origin (and app path, if it is mounted elsewhere). */
export function rebase(t: FamilyTemplate, targetUrl: string): Recipe {
  const target = new URL(targetUrl);
  let shift: [string, string] | null = null;
  try {
    shift = pathPrefixShift(new URL(t.sourceUrl).pathname, target.pathname);
  } catch {
    shift = null;
  }
  const shiftRe = shift ? new RegExp(`^${escapeRe(ORIGIN + shift[0])}(?=[/?#]|$)`, "i") : null;
  const out = mapStrings(t.recipe, (s) => {
    let r = s;
    if (shiftRe && shift) r = r.replace(shiftRe, ORIGIN + shift[1]);
    return r.split(ORIGIN).join(target.origin);
  });
  return Recipe.parse(out);
}

// ------------------------------------------------------------ store

/** Templates on disk: `<dir>/<family>.json`, one per family, the latest successful attach wins. */
export class FamilyStore {
  constructor(readonly dir: string = path.join(config.dataDir, "families")) {}

  private file(family: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(family)) throw new Error(`bad family id ${family}`);
    return path.join(this.dir, `${family}.json`);
  }

  load(family: string): FamilyTemplate | null {
    try {
      const t = JSON.parse(readFileSync(this.file(family), "utf8")) as FamilyTemplate;
      return t && t.family === family && t.recipe && typeof t.sourceUrl === "string" ? t : null;
    } catch {
      return null;
    }
  }

  save(t: FamilyTemplate): void {
    const file = this.file(t.family);
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(t, null, 2));
    renameSync(tmp, file);
  }
}

let defaultStore: FamilyStore | null = null;
/** Created lazily so importing this module never reads config paths. */
export function familyStore(): FamilyStore {
  return (defaultStore ??= new FamilyStore());
}

// ------------------------------------------------------------ attaching from a family

export interface FamilyAttachDeps {
  sample: (recipe: Recipe, ctx: PortalContext) => Promise<ReadOutcome>;
  read: (recipe: Recipe, ctx: PortalContext) => Promise<ReadOutcome>;
}

/**
 * Tries the family template on this portal. `ok` or `blocked` are final; `miss` means "ask the model",
 * with one plain sentence why. Never calls the model.
 */
export async function attachFromFamily(
  ctx: PortalContext,
  family: Family,
  template: FamilyTemplate,
  targetUrl: string,
  deps: FamilyAttachDeps,
): Promise<AttachOutcome | { kind: "miss"; reason: string }> {
  let recipe: Recipe;
  try {
    recipe = rebase(template, targetUrl);
  } catch (e) {
    return { kind: "miss", reason: `the ${family.name} template does not fit this address (${(e as Error).message.slice(0, 120)})` };
  }
  recipe.family = family.id;
  ctx.log(`This portal runs ${family.name}; trying the family recipe learned on ${new URL(template.sourceUrl).host}.`);
  const sample = await deps.sample(recipe, ctx);
  if (ctx.signal.aborted) return { kind: "failed", reason: "The attach was cancelled." };
  if (sample.kind === "blocked" && !/robots\.txt/i.test(sample.reason)) return { kind: "blocked", reason: sample.reason.charAt(0).toUpperCase() + sample.reason.slice(1) };
  if (sample.kind !== "ok" || sample.tenders.length === 0) {
    return { kind: "miss", reason: sample.kind === "ok" ? "the family recipe read no tenders here" : `the family recipe did not read here: ${sample.reason}` };
  }
  const judged = judgeSample(recipe, sample, recipe.list.request.url);
  if (judged.errors.length) return { kind: "miss", reason: `the family recipe's dry-run had problems: ${judged.errors[0]}` };
  const full = await deps.read(recipe, ctx);
  if (full.kind === "blocked") return { kind: "blocked", reason: full.reason.charAt(0).toUpperCase() + full.reason.slice(1) };
  if (full.kind !== "ok" || full.tenders.length === 0) return { kind: "miss", reason: full.kind === "ok" ? "the family recipe's full read found no tenders" : `the family recipe's full read failed: ${full.reason}` };
  const golden = pickGolden(full.tenders);
  ctx.log(`Read ${full.tenders.length} tenders with the ${family.name} family recipe; kept ${golden.length} as golden records.`);
  return { kind: "ok", recipe, golden, read: full, note: `Reused the ${family.name} family recipe; no model call.` };
}

/** Keeps a model-learned recipe as the family's template. Never stores anything for an unknown family. */
export function rememberFamily(store: FamilyStore, family: Family | null, recipe: Recipe, portalUrls: string[], log: PortalContext["log"]): void {
  if (!family) return;
  const t = toTemplate(recipe, portalUrls, family.id);
  if (!t) {
    log(`Not keeping this recipe for the ${family.name} family: its list is on another host.`);
    return;
  }
  try {
    store.save(t);
    log(`Kept this recipe as the ${family.name} family recipe for the next portal on the same software.`);
  } catch (e) {
    log(`Could not keep the ${family.name} family recipe: ${(e as Error).message}`, "warn");
  }
}
