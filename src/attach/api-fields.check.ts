/**
 * Field check against a RUNNING Watchtower (not a unit test).
 *   npx tsx src/attach/api-fields.check.ts        BASE=http://localhost:8080 by default
 *
 * Uses only the public, read-only calls from the track description:
 *   GET /portals, GET /portals/{id}, GET /portals/{id}/runs, GET /portals/{id}/tenders[?changedSince=…],
 *   and GET of one document `path`.
 * For lab portals (localhost:4100/<name>) it also compares every field with /_truth/<name>.json.
 * Exit 0 only when no serving portal has a problem.
 */
import { createHash } from "node:crypto";

const BASE = (process.env.BASE ?? "http://localhost:8080").replace(/\/+$/, "");
const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?[+-]\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const REQUIRED = ["id", "url", "title", "buyerName", "publicationDate", "submissionDeadline", "status", "documents", "lastChangedAt"] as const;
const OPTIONAL = ["referenceNumber", "description", "procedureType", "contractNature", "cpvCodes", "placeOfPerformance"] as const;
const FIELDS = [...REQUIRED, ...OPTIONAL];
const NULLABLE = new Set(["title", "buyerName", "publicationDate", "submissionDeadline"]);
const ENUMS: Record<string, string[]> = {
  status: ["open", "closed", "withdrawn"],
  procedureType: ["open", "restricted", "negotiated", "other"],
  contractNature: ["works", "services", "supplies"],
};

type Obj = Record<string, any>;
interface Tally { fmt: number; missing: number; wrong: number; present: number; examples: string[] }

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(path.startsWith("http") ? path : BASE + path);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body };
}

const isUrl = (v: unknown) => { try { return /^https?:$/.test(new URL(String(v)).protocol); } catch { return false; } };
const text = (v: unknown) => String(v).replace(/\s+/g, " ").trim();
const norm = (u: string) => String(u).replace(/\/+$/, "");

/** Format problem of one field value, or "" when it is fine. `undefined` means the key is absent. */
function formatProblem(f: string, v: any): string {
  const isReq = (REQUIRED as readonly string[]).includes(f);
  if (v === undefined) return isReq ? "absent" : "";
  if (v === null) return NULLABLE.has(f) ? "" : "null not allowed";
  if (!isReq && (v === "" || (Array.isArray(v) && v.length === 0))) return "empty (leave out instead)";
  switch (f) {
    case "id": case "title": case "buyerName": case "referenceNumber": case "description":
      return typeof v === "string" && v.trim() ? "" : "not a non-empty string";
    case "url": return isUrl(v) ? "" : "not an absolute URL";
    case "publicationDate": return DATE.test(v) ? "" : "not YYYY-MM-DD";
    case "submissionDeadline": case "lastChangedAt": return OFFSET_TIME.test(v) ? "" : "no offset";
    case "status": case "procedureType": case "contractNature": return ENUMS[f]!.includes(v) ? "" : `not ${ENUMS[f]!.join("|")}`;
    case "cpvCodes": return Array.isArray(v) && v.every((c) => typeof c === "string" && /^\d{8}$/.test(c)) ? "" : "not 8-digit strings";
    case "placeOfPerformance": {
      if (typeof v !== "object" || Array.isArray(v)) return "not an object";
      const keys = Object.keys(v).sort().join(",");
      if (keys !== "city,countryCode,postalCode") return `keys ${keys}`;
      if (v.countryCode !== null && !/^[A-Z]{2}$/.test(v.countryCode)) return "countryCode not 2 letters";
      return "";
    }
    case "documents": {
      if (!Array.isArray(v)) return "not a list";
      for (const d of v) {
        if (Object.keys(d).sort().join(",") !== "fileName,path,sha256,sizeBytes") return `doc keys ${Object.keys(d).join(",")}`;
        if (typeof d.fileName !== "string" || !d.fileName) return "doc fileName";
        if (!Number.isInteger(d.sizeBytes) || d.sizeBytes < 0) return "doc sizeBytes";
        if (!/^[a-f0-9]{64}$/.test(d.sha256)) return "doc sha256";
        if (typeof d.path !== "string" || !d.path.startsWith("/files/")) return "doc path not /files/";
      }
      return "";
    }
  }
  return "";
}

/** Compare a delivered value with the lab truth, like lab/eval.ts does. */
function judge(f: string, got: any, want: any): "ok" | "missing" | "wrong" {
  if (got === undefined || got === null) return "missing";
  if (f === "submissionDeadline") return Date.parse(got) === Date.parse(want) ? "ok" : "wrong";
  if (f === "url") return norm(got) === norm(want) ? "ok" : "wrong";
  if (f === "cpvCodes") return JSON.stringify([...got].sort()) === JSON.stringify([...want].sort()) ? "ok" : "wrong";
  if (f === "placeOfPerformance") {
    const parts = Object.keys(want).map((k) => (got[k] == null ? "missing" : text(got[k]).toLowerCase() === text(want[k]).toLowerCase() ? "ok" : "wrong"));
    return parts.includes("wrong") ? "wrong" : parts.includes("missing") ? "missing" : "ok";
  }
  if (f === "documents") {
    const shas = new Set(got.map((d: Obj) => d.sha256));
    const names = new Set(got.map((d: Obj) => d.fileName));
    if (shas.size === want.length && want.every((d: Obj) => shas.has(d.sha256) && names.has(d.fileName))) return "ok";
    return got.length === 0 && want.length > 0 ? "missing" : "wrong";
  }
  return text(got) === text(want) ? "ok" : "wrong";
}

function checkRun(r: Obj): string {
  if (Object.keys(r).sort().join(",") !== "finishedAt,id,kind,result,startedAt") return `run keys ${Object.keys(r).join(",")}`;
  if (typeof r.id !== "string" || !r.id) return "run id";
  if (!["read", "repair"].includes(r.kind)) return `run kind ${r.kind}`;
  if (!OFFSET_TIME.test(r.startedAt)) return `run startedAt ${r.startedAt}`;
  if (r.finishedAt !== null && !OFFSET_TIME.test(r.finishedAt)) return `run finishedAt ${r.finishedAt}`;
  if (![null, "ok", "failed"].includes(r.result)) return `run result ${r.result}`;
  if ((r.finishedAt === null) !== (r.result === null)) return "run finishedAt/result disagree";
  return "";
}

function checkEntry(p: Obj): string {
  if (Object.keys(p).sort().join(",") !== "id,lastSuccessAt,reason,state,tenderCount,url") return `entry keys ${Object.keys(p).join(",")}`;
  if (!["integrating", "serving", "healing", "failed"].includes(p.state)) return `state ${p.state}`;
  if (typeof p.reason !== "string" || !p.reason) return "reason empty";
  if (!Number.isInteger(p.tenderCount) || p.tenderCount < 0) return "tenderCount";
  if (p.lastSuccessAt !== null && !OFFSET_TIME.test(p.lastSuccessAt)) return `lastSuccessAt ${p.lastSuccessAt}`;
  return isUrl(p.url) ? "" : "url";
}

async function checkPortal(p: Obj): Promise<string[]> {
  const problems: string[] = [];
  const add = (s: string) => s && problems.push(s);

  const one = await get(`/portals/${encodeURIComponent(p.id)}`);
  if (one.status !== 200) add(`GET /portals/{id} ${one.status}`);
  else { add(checkEntry(one.body)); if (one.body.id !== p.id) add("GET /portals/{id} returns another id"); }

  const runs = await get(`/portals/${encodeURIComponent(p.id)}/runs`);
  if (runs.status !== 200 || !Array.isArray(runs.body)) add(`GET runs ${runs.status}`);
  else { for (const r of runs.body) add(checkRun(r)); if (!runs.body.some((r: Obj) => r.kind === "read")) add("no read run"); }

  const res = await get(`/portals/${encodeURIComponent(p.id)}/tenders`);
  if (res.status !== 200 || !Array.isArray(res.body)) { add(`GET tenders ${res.status}`); return problems; }
  const tenders: Obj[] = res.body;
  if (tenders.length !== p.tenderCount) add(`tenderCount ${p.tenderCount} but ${tenders.length} tenders`);
  const ids = new Set(tenders.map((t) => t.id));
  if (ids.size !== tenders.length) add(`${tenders.length - ids.size} duplicate tender ids`);

  // changedSince: a cut in the middle of the lastChangedAt values, written with a +01:00 offset.
  const times = tenders.map((t) => Date.parse(t.lastChangedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length) {
    const cut = times[Math.floor(times.length / 2)]! - 1;
    const iso = new Date(cut + 3600_000).toISOString().replace(/Z$/, "+01:00");
    const later = await get(`/portals/${encodeURIComponent(p.id)}/tenders?changedSince=${encodeURIComponent(iso)}`);
    const want = times.filter((t) => t > cut).length;
    if (later.status !== 200 || !Array.isArray(later.body)) add(`changedSince ${later.status}`);
    else if (later.body.length !== want || later.body.some((t: Obj) => !(Date.parse(t.lastChangedAt) > cut)))
      add(`changedSince=${iso}: got ${later.body.length}, want ${want}`);
  }

  // One document's bytes.
  const doc = tenders.flatMap((t) => (Array.isArray(t.documents) ? t.documents : []))[0];
  if (doc?.path) {
    const r = await fetch(BASE + doc.path);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (r.status !== 200) add(`GET ${doc.path} ${r.status}`);
    else if (bytes.length !== doc.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== doc.sha256)
      add(`${doc.path}: bytes do not match sizeBytes/sha256`);
  }

  // Every field: format, and against the lab truth when there is one.
  const slug = /^https?:\/\/(?:localhost|127\.0\.0\.1):4100\/([^/?#]+)/.exec(p.url)?.[1];
  let truth: Obj[] | undefined;
  if (slug) {
    const t = await get(`http://localhost:4100/_truth/${slug}.json`);
    if (t.status === 200 && Array.isArray(t.body?.tenders)) truth = t.body.tenders;
    else add(`no lab truth for ${slug}`);
  }
  const tally: Record<string, Tally> = Object.fromEntries(FIELDS.map((f) => [f, { fmt: 0, missing: 0, wrong: 0, present: 0, examples: [] }]));
  const extraKeys = new Set<string>();
  for (const t of tenders) {
    for (const k of Object.keys(t)) if (!(FIELDS as string[]).includes(k)) extraKeys.add(k);
    for (const f of FIELDS) {
      let why = formatProblem(f, t[f]);
      if (t[f] !== undefined && t[f] !== null) tally[f]!.present++;
      if (!why && f === "status" && t.status === "open" && t.submissionDeadline && Date.parse(t.submissionDeadline) < Date.now()) why = "open after its deadline";
      if (why) { tally[f]!.fmt++; if (tally[f]!.examples.length < 2) tally[f]!.examples.push(`${t.id}: ${why} (${JSON.stringify(t[f])?.slice(0, 60)})`); }
    }
  }
  if (extraKeys.size) add(`extra tender keys: ${[...extraKeys].join(", ")}`);
  if (truth) {
    const byId = new Map(tenders.map((t) => [String(t.id), t]));
    const byUrl = new Map(tenders.map((t) => [norm(t.url), t]));
    let notFound = 0;
    for (const w of truth) {
      const g = byId.get(String(w.id)) ?? byUrl.get(norm(w.url));
      if (!g) { notFound++; continue; }
      for (const f of FIELDS) {
        if (f === "lastChangedAt") continue;
        const v = w[f] === undefined || w[f] === null ? (g[f] === undefined || g[f] === null ? "ok" : "wrong") : judge(f, g[f], w[f]);
        if (v === "ok") continue;
        tally[f]![v]++;
        if (tally[f]!.examples.length < 2) tally[f]!.examples.push(`${w.id}: ${v} got ${JSON.stringify(g[f])?.slice(0, 60)} want ${JSON.stringify(w[f])?.slice(0, 60)}`);
      }
    }
    if (notFound) add(`${notFound} of ${truth.length} truth tenders not delivered`);
    const known = new Set(truth.flatMap((w) => [String(w.id), norm(w.url)]));
    const extra = tenders.filter((t) => t.status === "open" && !known.has(String(t.id)) && !known.has(norm(t.url))).length;
    if (extra) add(`${extra} open tenders not in the truth`);
  }

  console.log(`\n${p.id}  ${p.state}  ${p.url}  (${tenders.length} tenders${truth ? `, truth ${truth.length}` : ", formats only"})`);
  for (const f of FIELDS) {
    const c = tally[f]!;
    const cell = [c.fmt && `bad format on ${c.fmt}`, c.missing && `missing on ${c.missing}`, c.wrong && `wrong on ${c.wrong}`].filter(Boolean).join(", ");
    console.log(`  ${f.padEnd(19)} ${cell || (c.present ? "OK" : "not shown")}${c.examples.length ? `   e.g. ${c.examples.join(" | ")}` : ""}`);
    if (cell) problems.push(`${f}: ${cell}`);
  }
  for (const s of problems.filter((s) => !FIELDS.some((f) => s.startsWith(f + ":")))) console.log(`  ! ${s}`);
  return problems;
}

const list = await get("/portals");
if (list.status !== 200 || !Array.isArray(list.body)) { console.error(`GET /portals answered ${list.status}`); process.exit(1); }
const bad: string[] = [];
for (const p of list.body as Obj[]) {
  const entry = checkEntry(p);
  if (entry) console.log(`entry ${p.id}: ${entry}`);
  const problems = [...(entry ? [entry] : []), ...(await checkPortal(p))];
  if (p.state !== "serving") { console.log(`  (not serving: ${p.state}, ignored for the exit code)`); continue; }
  for (const s of problems) bad.push(`${p.url.replace(/^https?:\/\//, "")} ${s}`);
}
console.log(bad.length ? `\nFIELD PROBLEMS: ${bad.join("; ")}` : "\nALL FIELDS OK");
process.exit(bad.length ? 1 : 0);
