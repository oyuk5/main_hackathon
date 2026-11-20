/**
 * Eval (person D): the scoreboard. Talks only to the public API and /internal/ledger, like Patterno.
 * Needs the lab (npm run lab) and Watchtower (npm run dev or the container) running.
 *
 *   npm run eval                                  every portal, every change
 *   npm run eval -- --portal gmina                one portal
 *   npm run eval -- --portal gmina --change empty-day
 *   npm run eval -- --attach-only                 attach accuracy only, no changes
 *
 * Each scenario starts from a fresh attach (DELETE, then POST /portals), so one failed repair
 * (and its cooldown) never spoils the next scenario. Results go to lab/results/ (gitignored).
 * LAB (default http://localhost:4100) and WATCHTOWER (default http://localhost:8080) set the addresses.
 * Model cost comes from /internal/ledger deltas; other portals repairing at the same time would add to it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HARMLESS, type Truth, type TruthTender } from "./portals/common.js";
import { labState, mutate } from "./mutate.js";

const LAB = process.env.LAB ?? "http://localhost:4100";
const API = process.env.WATCHTOWER ?? "http://localhost:8080";
/** Longest we wait for one attach or one scenario to settle. */
const SETTLE_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 5 * 60_000);

// ---------------------------------------------------------------- API

interface PortalEntry { id: string; url: string; state: string; reason: string; tenderCount: number; lastSuccessAt: string | null }
interface Run { id: string; kind: "read" | "repair"; startedAt: string; finishedAt: string | null; result: "ok" | "failed" | null }
interface LedgerRow { purpose: string; calls: number; cost_usd: number }
type Tender = Record<string, unknown> & { url: string; documents?: Array<{ sha256: string }> };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, init);
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${r.status}`);
  return (await r.json()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (u: string) => u.replace(/\/+$/, "");

async function ledger(): Promise<{ calls: number; cost: number; byPurpose: Record<string, { calls: number; cost: number }> }> {
  const rows = await api<LedgerRow[]>("/internal/ledger");
  const byPurpose: Record<string, { calls: number; cost: number }> = {};
  for (const r of rows) byPurpose[r.purpose] = { calls: r.calls, cost: r.cost_usd };
  return { calls: rows.reduce((s, r) => s + r.calls, 0), cost: rows.reduce((s, r) => s + r.cost_usd, 0), byPurpose };
}

type Ledger = Awaited<ReturnType<typeof ledger>>;
function spent(before: Ledger, after: Ledger) {
  const purposes = new Set([...Object.keys(before.byPurpose), ...Object.keys(after.byPurpose)]);
  const byPurpose: Record<string, { calls: number; cost: number }> = {};
  for (const p of purposes) {
    const calls = (after.byPurpose[p]?.calls ?? 0) - (before.byPurpose[p]?.calls ?? 0);
    const cost = (after.byPurpose[p]?.cost ?? 0) - (before.byPurpose[p]?.cost ?? 0);
    if (calls) byPurpose[p] = { calls, cost: round(cost, 4) };
  }
  return { calls: after.calls - before.calls, cost: round(after.cost - before.cost, 4), byPurpose };
}

/** Removes any portal already watching this lab address, then adds it fresh. */
async function freshPortal(url: string): Promise<string> {
  for (const p of await api<PortalEntry[]>("/portals")) {
    if (norm(p.url) === norm(url)) await fetch(`${API}/portals/${p.id}`, { method: "DELETE" });
  }
  return (await api<{ id: string }>("/portals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) })).id;
}

/**
 * Polls until the portal is serving or failed with no run in progress, three polls in a row
 * (a repair can start right after the read that noticed the change). Returns every state seen.
 */
async function settle(id: string, since: number): Promise<{ entry: PortalEntry; states: string[]; runs: Run[]; timedOut: boolean }> {
  const states: string[] = [];
  let calm = 0;
  const end = Date.now() + SETTLE_MS;
  for (;;) {
    const entry = await api<PortalEntry>(`/portals/${id}`);
    const runs = (await api<Run[]>(`/portals/${id}/runs`)).filter((r) => Date.parse(r.startedAt) >= since - 1000);
    if (states.at(-1) !== entry.state) states.push(entry.state);
    const busy = entry.state === "integrating" || entry.state === "healing" || runs.some((r) => !r.finishedAt);
    calm = busy || runs.length === 0 ? 0 : calm + 1;
    if (calm >= 3) return { entry, states, runs, timedOut: false };
    if (Date.now() > end) return { entry, states, runs, timedOut: true };
    await sleep(1000);
  }
}

// ---------------------------------------------------------------- comparing with the truth

const REQUIRED = ["title", "buyerName", "publicationDate", "submissionDeadline", "status"] as const;
const OPTIONAL = ["referenceNumber", "description", "procedureType", "contractNature", "cpvCodes", "placeOfPerformance"] as const;

type Verdict = "correct" | "missing" | "wrong";

const text = (v: unknown) => String(v).replace(/\s+/g, " ").trim();

function judge(field: string, got: unknown, want: unknown): Verdict {
  if (got === undefined || got === null) return "missing";
  if (field === "submissionDeadline") return Date.parse(String(got)) === Date.parse(String(want)) ? "correct" : "wrong";
  if (field === "cpvCodes") return JSON.stringify([...(got as string[])].sort()) === JSON.stringify([...(want as string[])].sort()) ? "correct" : "wrong";
  if (field === "placeOfPerformance") {
    const g = got as Record<string, unknown>, w = want as Record<string, unknown>;
    const parts = Object.keys(w).map((k) => (g[k] == null ? "missing" : text(g[k]).toLowerCase() === text(w[k]).toLowerCase() ? "correct" : "wrong"));
    return parts.includes("wrong") ? "wrong" : parts.includes("missing") ? "missing" : "correct";
  }
  return text(got) === text(want) ? "correct" : "wrong";
}

export interface Accuracy {
  truthTenders: number;
  delivered: number;
  found: number;
  /** Delivered tenders that are not in the truth (e.g. invented or duplicated). */
  extra: number;
  required: { correct: number; missing: number; wrong: number };
  optional: { correct: number; missing: number; wrong: number };
  documentsExact: number;
  /** correct required + optional fields / all fields of the truth (missing tenders count as all missing). */
  score: number;
  wrongExamples: string[];
  missingByField: Record<string, number>;
}

export function compare(truth: TruthTender[], got: Tender[]): Accuracy {
  const byUrl = new Map(got.map((t) => [norm(t.url), t]));
  const req = { correct: 0, missing: 0, wrong: 0 };
  const opt = { correct: 0, missing: 0, wrong: 0 };
  const wrongExamples: string[] = [];
  const missingByField: Record<string, number> = {};
  let found = 0, documentsExact = 0;
  for (const t of truth) {
    const g = byUrl.get(norm(t.url));
    if (!g) {
      req.missing += REQUIRED.length;
      opt.missing += OPTIONAL.length;
      missingByField.tender = (missingByField.tender ?? 0) + 1;
      continue;
    }
    found++;
    for (const [fields, tally] of [[REQUIRED, req], [OPTIONAL, opt]] as const) {
      for (const f of fields) {
        const v = judge(f, g[f], t[f]);
        tally[v]++;
        if (v === "missing") missingByField[f] = (missingByField[f] ?? 0) + 1;
        if (v === "wrong" && wrongExamples.length < 8) wrongExamples.push(`${t.id} ${f}: got ${JSON.stringify(g[f])}, want ${JSON.stringify(t[f])}`);
      }
    }
    const shas = new Set((g.documents ?? []).map((d) => d.sha256));
    if (shas.size === t.documents.length && t.documents.every((d) => shas.has(d.sha256))) documentsExact++;
    else missingByField.documents = (missingByField.documents ?? 0) + 1;
  }
  const truthUrls = new Set(truth.map((t) => norm(t.url)));
  const all = truth.length * (REQUIRED.length + OPTIONAL.length);
  return {
    truthTenders: truth.length,
    delivered: got.length,
    found,
    extra: got.filter((g) => !truthUrls.has(norm(g.url))).length,
    required: req,
    optional: opt,
    documentsExact,
    score: all ? round((req.correct + opt.correct) / all, 3) : 1,
    wrongExamples,
    missingByField,
  };
}

async function measure(slug: string, id: string): Promise<Accuracy> {
  const truth = (await (await fetch(`${LAB}/_truth/${slug}.json`)).json()) as Truth;
  const got = await api<Tender[]>(`/portals/${id}/tenders`);
  return compare(truth.tenders, got);
}

// ---------------------------------------------------------------- scenarios

interface AttachResult {
  portal: string;
  /** What the lab says Watchtower should end in: "failed" for portals that block us on purpose. */
  expect: "serving" | "failed";
  /** Ended in the expected state. */
  asExpected: boolean;
  state: string;
  reason: string;
  seconds: number;
  cost: ReturnType<typeof spent>;
  accuracy: Accuracy;
  timedOut: boolean;
}

/** repaired / unaffected (no repair needed, fresh data still right) are good for a breaking change;
 *  quiet (no repair) is good for a harmless one. */
type Outcome = "repaired" | "unaffected" | "quiet" | "false-repair" | "missed" | "repair-failed" | "failed" | "timed-out";

interface ScenarioResult {
  portal: string;
  change: string;
  harmless: boolean;
  outcome: Outcome;
  good: boolean;
  /** Did Watchtower see that something was wrong (repair started, or healing/failed state)? */
  noticed: boolean;
  repairs: number;
  secondsToHeal: number | null;
  states: string[];
  state: string;
  reason: string;
  cost: ReturnType<typeof spent>;
  accuracy: Accuracy;
  attachScore: number;
  /** Model cost of the fresh attach this scenario started from (not part of the repair cost). */
  setupCost: number;
}

async function expectOf(slug: string): Promise<"serving" | "failed"> {
  const truth = (await (await fetch(`${LAB}/_truth/${slug}.json`)).json()) as Truth;
  return truth.expect ?? "serving";
}

async function attach(slug: string, url: string): Promise<{ id: string; result: AttachResult }> {
  const expect = await expectOf(slug);
  const before = await ledger();
  const t0 = Date.now();
  const id = await freshPortal(url);
  const s = await settle(id, t0);
  const result: AttachResult = {
    portal: slug,
    expect,
    asExpected: s.entry.state === expect,
    state: s.entry.state,
    reason: s.entry.reason,
    seconds: round((Date.now() - t0) / 1000, 1),
    cost: spent(before, await ledger()),
    accuracy: await measure(slug, id),
    timedOut: s.timedOut,
  };
  return { id, result };
}

async function scenario(slug: string, url: string, change: string): Promise<ScenarioResult> {
  await mutate(slug, "v1");
  const { id, result: base } = await attach(slug, url);
  const before = await ledger();
  await mutate(slug, change);
  const t0 = Date.now();
  await api(`/portals/${id}/refresh`, { method: "POST" });
  const s = await settle(id, t0);
  const accuracy = await measure(slug, id);
  const cost = spent(before, await ledger());
  const repairs = s.runs.filter((r) => r.kind === "repair");
  const repairedOk = repairs.some((r) => r.result === "ok");
  const lastRepair = repairs.filter((r) => r.finishedAt).sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))[0];
  const harmless = HARMLESS.has(change);
  const noticed = repairs.length > 0 || s.states.some((x) => x === "healing" || x === "failed");
  const fresh = !!s.entry.lastSuccessAt && Date.parse(s.entry.lastSuccessAt) >= t0 - 1000;
  // Data is "right" when it is as complete as after attach and has no more wrong values.
  const wrong = (a: Accuracy) => a.required.wrong + a.optional.wrong;
  const right = accuracy.score >= base.accuracy.score - 0.02 && wrong(accuracy) <= wrong(base.accuracy) && accuracy.extra <= base.accuracy.extra;

  let outcome: Outcome;
  if (s.timedOut) outcome = "timed-out";
  else if (harmless) outcome = noticed ? "false-repair" : s.entry.state === "serving" ? "quiet" : "failed";
  else if (s.entry.state === "failed") outcome = repairs.length ? "repair-failed" : "failed";
  else if (repairedOk && s.entry.state === "serving") outcome = right ? "repaired" : "repair-failed";
  else if (!noticed && fresh && right) outcome = "unaffected";
  else outcome = noticed ? "repair-failed" : "missed";

  const result: ScenarioResult = {
    portal: slug,
    change,
    harmless,
    outcome,
    good: outcome === "repaired" || outcome === "unaffected" || outcome === "quiet",
    noticed,
    repairs: repairs.length,
    secondsToHeal: outcome === "repaired" && lastRepair ? round((Date.parse(lastRepair.finishedAt!) - t0) / 1000, 1) : null,
    states: s.states,
    state: s.entry.state,
    reason: s.entry.reason,
    cost,
    accuracy,
    attachScore: base.accuracy.score,
    setupCost: base.cost.cost,
  };
  await mutate(slug, "v1");
  return result;
}

// ---------------------------------------------------------------- report

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
const pct = (n: number) => `${Math.round(n * 100)}%`;
const usd = (n: number) => `$${n.toFixed(3)}`;

function summarize(all: AttachResult[], scenarios: ScenarioResult[]) {
  const blocked = all.filter((a) => a.expect === "failed");
  const attaches = all.filter((a) => a.expect !== "failed");
  const breaking = scenarios.filter((s) => !s.harmless);
  const harmless = scenarios.filter((s) => s.harmless);
  const healed = breaking.filter((s) => s.good);
  const times = scenarios.map((s) => s.secondsToHeal).filter((x): x is number => x != null).sort((a, b) => a - b);
  const repairCosts = scenarios.filter((s) => s.repairs > 0).map((s) => s.cost.cost);
  return {
    attachAccuracy: attaches.length ? round(attaches.reduce((a, r) => a + r.accuracy.score, 0) / attaches.length, 3) : null,
    wrongValuesAfterAttach: attaches.reduce((a, r) => a + r.accuracy.required.wrong + r.accuracy.optional.wrong, 0),
    noticeAccuracy: scenarios.length ? round(scenarios.filter((s) => (s.harmless ? !s.noticed : s.good || s.noticed)).length / scenarios.length, 3) : null,
    healRate: breaking.length ? round(healed.length / breaking.length, 3) : null,
    medianSecondsToHeal: times.length ? times[Math.floor(times.length / 2)]! : null,
    falseRepairs: harmless.filter((s) => s.noticed).length,
    harmlessScenarios: harmless.length,
    attachCostPerPortal: attaches.length ? round(attaches.reduce((a, r) => a + r.cost.cost, 0) / attaches.length, 4) : null,
    costPerRepair: repairCosts.length ? round(repairCosts.reduce((a, b) => a + b, 0) / repairCosts.length, 4) : null,
    blockedReportedFailed: blocked.filter((a) => a.asExpected).length,
    blockedPortals: blocked.length,
    totalCost: round(all.reduce((a, r) => a + r.cost.cost, 0) + scenarios.reduce((a, s) => a + s.cost.cost + s.setupCost, 0), 4),
  };
}

function markdown(when: string, attaches: AttachResult[], scenarios: ScenarioResult[], sum: ReturnType<typeof summarize>): string {
  const lines = [
    `# Watchtower eval · ${when}`,
    "",
    "| Measure | Result |",
    "|---|---|",
    `| Attach accuracy (correct fields / all fields) | ${sum.attachAccuracy == null ? "–" : pct(sum.attachAccuracy)} |`,
    `| Wrong values after attach | ${sum.wrongValuesAfterAttach} |`,
    ...(sum.blockedPortals ? [`| Blocked portals reported as failed (as they should be) | ${sum.blockedReportedFailed} of ${sum.blockedPortals} |`] : []),
    `| Notice accuracy | ${sum.noticeAccuracy == null ? "–" : pct(sum.noticeAccuracy)} |`,
    `| Heal rate (breaking changes handled) | ${sum.healRate == null ? "–" : pct(sum.healRate)} |`,
    `| Median time to heal | ${sum.medianSecondsToHeal == null ? "–" : `${sum.medianSecondsToHeal} s`} |`,
    `| False repairs (harmless changes that started a repair) | ${sum.falseRepairs} of ${sum.harmlessScenarios} |`,
    `| Model cost per attach | ${sum.attachCostPerPortal == null ? "–" : usd(sum.attachCostPerPortal)} |`,
    `| Model cost per repair | ${sum.costPerRepair == null ? "–" : usd(sum.costPerRepair)} |`,
    `| Total model cost of this eval | ${usd(sum.totalCost)} |`,
    "",
    "## Attach",
    "",
    "| Portal | State | Found | Score | Wrong | Docs exact | Missing most | Cost | Time |",
    "|---|---|---|---|---|---|---|---|---|",
    ...attaches.map((a) => {
      const top = Object.entries(a.accuracy.missingByField).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([f, n]) => `${f} ${n}`).join(", ");
      if (a.expect === "failed") return `| ${a.portal} | ${a.asExpected ? "✅" : "❌"} ${a.state} (should be failed) | – | – | – | – | ${a.reason.slice(0, 80)} | ${usd(a.cost.cost)} | ${a.seconds} s |`;
      return `| ${a.portal} | ${a.state} | ${a.accuracy.found}/${a.accuracy.truthTenders} | ${pct(a.accuracy.score)} | ${a.accuracy.required.wrong + a.accuracy.optional.wrong} | ${a.accuracy.documentsExact}/${a.accuracy.found} | ${top || "–"} | ${usd(a.cost.cost)} | ${a.seconds} s |`;
    }),
    "",
    "## Changes",
    "",
    "| Portal | Change | Outcome | States | Heal time | Score after | Cost |",
    "|---|---|---|---|---|---|---|",
    ...scenarios.map((s) =>
      `| ${s.portal} | ${s.change}${s.harmless ? " (harmless)" : ""} | ${s.good ? "✅" : "❌"} ${s.outcome} | ${s.states.join(" → ")} | ${s.secondsToHeal == null ? "–" : `${s.secondsToHeal} s`} | ${pct(s.accuracy.score)} (attach ${pct(s.attachScore)}) | ${usd(s.cost.cost)} |`),
  ];
  const wrongs = [...attaches.map((a) => [`attach ${a.portal}`, a.accuracy.wrongExamples] as const), ...scenarios.map((s) => [`${s.portal} ${s.change}`, s.accuracy.wrongExamples] as const)].filter(([, w]) => w.length);
  if (wrongs.length) {
    lines.push("", "## Wrong values (worse than missing)", "");
    for (const [where, w] of wrongs) lines.push(`- **${where}**: ${w.slice(0, 3).join("; ")}`);
  }
  const bad = scenarios.filter((s) => !s.good);
  if (bad.length) {
    lines.push("", "## Why the failed changes failed", "");
    for (const s of bad) lines.push(`- **${s.portal} ${s.change}** (${s.outcome}): ${s.reason}`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- main

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  await api("/portals").catch(() => {
    throw new Error(`Watchtower is not running at ${API}. Start it with: npm run dev`);
  });
  const state = await labState(LAB);
  const portals = state.portals.filter((p) => !arg("portal") || p.slug === arg("portal"));
  if (!portals.length) throw new Error(`No lab portal called ${arg("portal")}`);
  const attachOnly = process.argv.includes("--attach-only");

  const attaches: AttachResult[] = [];
  const scenarios: ScenarioResult[] = [];
  for (const p of portals) {
    const url = `${LAB}/${p.slug}/`;
    await mutate(p.slug, "v1");
    console.log(`\n${p.slug}: attaching…`);
    const { result } = await attach(p.slug, url);
    attaches.push(result);
    if (result.expect === "failed") {
      console.log(`  ${result.asExpected ? "✅" : "❌"} ${result.state} (should be failed): ${result.reason.slice(0, 100)}`);
      continue; // a blocked portal has nothing to repair
    }
    console.log(`  ${result.state}, ${result.accuracy.found}/${result.accuracy.truthTenders} tenders, score ${pct(result.accuracy.score)}, ${usd(result.cost.cost)}, ${result.seconds} s`);
    if (attachOnly) continue;
    const changes = Object.keys(p.variants).filter((v) => v !== "v1" && (!arg("change") || v === arg("change")));
    for (const change of changes) {
      process.stdout.write(`  ${change.padEnd(18)} `);
      const s = await scenario(p.slug, url, change);
      scenarios.push(s);
      console.log(`${s.good ? "✅" : "❌"} ${s.outcome.padEnd(14)} ${s.states.join("→").padEnd(28)} ${s.secondsToHeal == null ? "" : `${s.secondsToHeal}s `}${usd(s.cost.cost)}`);
    }
  }

  const sum = summarize(attaches, scenarios);
  const when = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = fileURLToPath(new URL("./results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const md = markdown(new Date().toLocaleString("sv-SE"), attaches, scenarios, sum);
  writeFileSync(`${dir}eval-${when}.json`, JSON.stringify({ summary: sum, attaches, scenarios }, null, 2));
  writeFileSync(`${dir}eval-${when}.md`, md);
  writeFileSync(`${dir}latest.md`, md);
  console.log("\n" + md.split("\n## Attach")[0]);
  console.log(`Saved lab/results/eval-${when}.md (and .json, latest.md)`);
}

const self = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
if ((process.argv[1] ?? "").replace(/\\/g, "/").toLowerCase() === self) {
  main().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
