/**
 * The orchestrator: the state machine behind the four portal states. Owned by A.
 *
 *   POST /portals ─► integrating ─attach ok + healthy─► serving ◄──────────────┐
 *                        │                                │ read broken         │ repair ok
 *                        └─blocked / cannot attach─► failed ◄─repair failed─ healing
 *
 * Rules from the brief this file enforces:
 * - The first attach is a run of kind "read". Repairs are runs of kind "repair".
 * - While healing, keep serving the last correct tenders (we never overwrite them on a bad read).
 * - Login or captcha => failed, and the reason says so.
 * - Refresh while a read runs returns that run's id.
 * - DELETE stops all calls to the portal (we abort its job immediately).
 * - Nobody steers it: every transition below is automatic.
 */
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "./config.js";
import { INTERRUPTED, store } from "./store.js";
import { politeBrowser, politeHttp } from "./polite.js";
import { documentFetcher, removeOrphanFiles } from "./documents.js";
import { count, join, labelled, sentence } from "./reason.js";
import { mayClose, maybeFirstPageOnly, sawWholeList } from "./listing.js";
import { ModelBudgetError, planDocuments, type Need } from "./budget.js";
import { dateTimeEpoch, isCalendarDate } from "./calendar.js";
import { llmFor } from "../llm/client.js";
import { cartographer, evictDetailCacheSample, extractor } from "../attach/index.js";
import { medic, verifyGoldenRecords, watch } from "../watch/index.js";
import { formatWithOffset, nowWithOffset, toEpoch } from "../shared/time.js";
import { Tender, TenderDocument as TenderDocumentSchema } from "../shared/contract.js";
import type { Tender as TenderT, TenderDocument } from "../shared/contract.js";
import type { Baseline, ExtractedTender, PortalContext, ReadOutcome, Verdict } from "../shared/modules.js";
import type { Recipe } from "../shared/recipe.js";

type OkRead = Extract<ReadOutcome, { kind: "ok" }>;

interface ActiveJob {
  runId: string;
  kind: "read" | "repair";
  controller: AbortController;
}
const active = new Map<string, ActiveJob>();

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const minutes = (m: number) => m * 60_000;

// ------------------------------------------------------------ identity

/** Same address twice must give the same id, so we normalize before hashing. */
export function normalizeUrl(input: string): string {
  const u = new URL(input.trim());
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function portalIdFor(url: string): string {
  return "p_" + sha(normalizeUrl(url)).slice(0, 12);
}

// ------------------------------------------------------------ context

function contextFor(portalId: string, url: string, runId: string, controller: AbortController): PortalContext {
  const counter = () => {};
  const llm = llmFor(portalId, runId);
  return {
    portalId,
    url,
    http: politeHttp(controller.signal, counter),
    browser: politeBrowser(controller.signal, counter),
    llm: { async json(options) {
      try { return await llm.json(options); }
      catch (error) {
        if (error instanceof ModelBudgetError) {
          finishRun(runId, "failed", error.message);
          store.setState(portalId, "failed", error.message);
          scheduleNext(portalId, config.failedRetryMinutes);
          controller.abort();
        }
        throw error;
      }
    } },
    signal: controller.signal,
    log: (message, level = "info") => store.addEvent(portalId, runId, nowWithOffset(), level, message),
  };
}

// ------------------------------------------------------------ public API

export const orchestrator = {
  addPortal(rawUrl: string): { id: string; created: boolean } {
    const url = normalizeUrl(rawUrl);
    const existing = store.getPortalByUrl(url);
    if (existing) return { id: existing.id, created: false };
    const id = portalIdFor(url);
    store.insertPortal({ id, url, state: "integrating", reason: "Attaching: learning how to read this portal.", createdAt: nowWithOffset() });
    startJob(id);
    return { id, created: true };
  },

  /** Returns the running run's id, or starts a read. */
  refresh(portalId: string): string {
    const job = active.get(portalId);
    if (job) return job.runId;
    return startJob(portalId);
  },

  remove(portalId: string) {
    active.get(portalId)?.controller.abort();
    active.delete(portalId);
    const files = store.documentShas(portalId);
    store.deletePortal(portalId);
    // Its documents go too, unless another portal's tenders still list the same file.
    removeOrphanFiles(portalId, files, (sha) => store.isShaReferenced(sha));
  },

  isBusy(portalId: string) {
    return active.get(portalId) ?? null;
  },

  start() {
    store.failInterruptedRuns(nowWithOffset());
    setInterval(tick, 15_000).unref();
    tick();
  },
};

// ------------------------------------------------------------ scheduling

function tick() {
  const now = Date.now();
  for (const p of store.listPortals()) {
    if (active.has(p.id)) continue;
    if (p.next_due_at <= now) startJob(p.id);
  }
  closeExpired();
}

/** Tenders whose deadline passed become closed even between reads. */
function closeExpired() {
  const now = Date.now();
  for (const p of store.listPortals()) {
    for (const t of store.listTenders(p.id)) {
      if (t.status === "open" && t.submissionDeadline && dateTimeEpoch(t.submissionDeadline) < now) {
        const updated: TenderT = { ...t, status: "closed", lastChangedAt: nowWithOffset() };
        const row = store.getTenderRow(p.id, t.id);
        store.upsertTender(p.id, updated, hashTender(updated), row?.refs_hash ?? "", nowWithOffset());
      }
    }
  }
}

function startJob(portalId: string): string {
  const portal = store.getPortal(portalId);
  if (!portal) throw new Error("unknown portal");
  const runId = "r_" + crypto.randomUUID().slice(0, 12);
  const controller = new AbortController();
  store.insertRun({ id: runId, portalId, kind: "read", startedAt: nowWithOffset() });
  active.set(portalId, { runId, kind: "read", controller });
  void runFlow(portalId, portal.url, runId, controller)
    .catch((e) => {
      if (!controller.signal.aborted) {
        // Full message stays in the run log; the operator sees one plain sentence.
        store.addEvent(portalId, runId, nowWithOffset(), "error", `Unexpected error: ${(e as Error).stack ?? (e as Error).message}`);
        finishRun(runId, "failed", labelled("Unexpected error", (e as Error).message));
        failPortal(portalId, "Watchtower hit an internal error while reading this portal; details are in the run log.");
      }
    })
    .finally(() => {
      if (active.get(portalId)?.controller === controller) active.delete(portalId);
    });
  return runId;
}

function finishRun(runId: string, result: "ok" | "failed", summary: string) {
  store.finishRun(runId, result, nowWithOffset(), summary);
}

function scheduleNext(portalId: string, inMinutes: number) {
  if (store.getPortal(portalId)) store.setNextDue(portalId, Date.now() + minutes(inMinutes));
}

function failPortal(portalId: string, reason: string, retryMinutes = config.failedRetryMinutes) {
  if (!store.getPortal(portalId)) return;
  const kept = store.countTenders(portalId);
  // The contract needs a non-empty reason even when B or C gave none.
  const why = sentence(reason) || "Stopped without a reason from the reader; details are in the run log.";
  store.setState(portalId, "failed", kept ? join(why, `Keeping the last ${count(kept, "correct tender")}`) : why);
  scheduleNext(portalId, retryMinutes);
}

function repairCoolingDown(portalId: string): boolean {
  // A repair cut off by a restart did not fail: it gets another try straight away.
  const last = store.listRuns(portalId).find((run) => (run.kind === "repair" && run.summary !== INTERRUPTED) || run.result === "ok");
  return last?.kind === "repair" && last.result === "failed" && !!last.finished_at &&
    Date.now() - toEpoch(last.finished_at) < minutes(config.failedRetryMinutes);
}

// ------------------------------------------------------------ the flow

async function runFlow(portalId: string, url: string, runId: string, controller: AbortController) {
  const ctx = contextFor(portalId, url, runId, controller);
  const recipe = store.currentRecipe(portalId);

  // 1. Attach (first time, or after a restart during attach)
  if (!recipe) {
    store.setState(portalId, "integrating", "Attaching: learning how to read this portal.");
    const out = await cartographer.attach(ctx);
    if (controller.signal.aborted) return;
    if (out.kind !== "ok") {
      const reason = out.kind === "blocked" ? labelled("Blocked", out.reason) : sentence(out.reason);
      finishRun(runId, "failed", reason);
      return failPortal(portalId, reason);
    }
    // "family": learned from a recognised software's template with no model call; a model-learned
    // recipe on recognised software (which becomes the template) is still an "attach".
    const usedModel = runId in store.costByRun(portalId);
    store.saveRecipe(portalId, out.recipe, out.recipe.family && !usedModel ? "family" : "attach", out.note, nowWithOffset());
    store.setGolden(portalId, out.golden);
    return judgeAndDeliver(portalId, runId, ctx, out.read);
  }

  // 2. Regular read: no model call
  evictDetailCacheSample(portalId, 3);
  let read = await extractor.read(recipe, ctx);
  for (const waitMs of [5_000, 20_000]) {
    if (read.kind !== "unreachable" || controller.signal.aborted) break;
    ctx.log(`Portal not reachable (${read.reason}). Trying again in ${waitMs / 1000} s.`, "warn");
    try {
      await delay(waitMs, undefined, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    }
    if (controller.signal.aborted) return;
    read = await extractor.read(recipe, ctx);
  }
  if (controller.signal.aborted) return;
  return judgeAndDeliver(portalId, runId, ctx, read);
}

async function judgeAndDeliver(portalId: string, runId: string, ctx: PortalContext, input: ReadOutcome) {
  const baseline = store.getBaseline(portalId);
  // A few tenders with impossible dates are held back, so one bad record does not stop the rest.
  const { read, heldBack } = holdBackImpossibleTenders(input);
  if (heldBack.size > 0) ctx.log(`${count(heldBack.size, "tender")} held back from this delivery: submission deadline earlier than publication date (${[...heldBack].slice(0, 3).join(", ")}).`, "warn");
  const verdict = watch.evaluate(read, baseline);

  if (verdict.kind === "healthy" && read.kind === "ok") {
    const delivered = await deliver(portalId, read, ctx, undefined, heldBack);
    const { documentsPending, documentFailures, documentsFetched } = delivered;
    const summary = heldBack.size > 0
      ? `${delivered.summary} ${count(heldBack.size, "tender")} held back: ${heldBack.size === 1 ? "its" : "their"} submission deadline is earlier than ${heldBack.size === 1 ? "its" : "their"} publication date.`
      : delivered.summary;
    // Deleted meanwhile: write nothing, the same address may already be a new portal with this id.
    if (ctx.signal.aborted) return;
    const docState = classifyDocumentFailures(documentFailures, documentsFetched);
    if (docState?.kind === "blocked") {
      finishRun(runId, "failed", docState.reason);
      return failPortal(portalId, docState.reason);
    }
    if (docState?.kind === "broken") {
      finishRun(runId, "failed", docState.reason);
      return beginRepair(portalId, runId, ctx, { kind: "broken", reason: docState.reason, checks: [] }, baseline);
    }
    finishRun(runId, "ok", summary);
    store.setState(portalId, "serving", summary, nowWithOffset());
    return scheduleNext(portalId, documentsPending ? config.pendingReadMinutes : config.readIntervalMinutes);
  }
  if (verdict.kind === "blocked") {
    finishRun(runId, "failed", sentence(verdict.reason));
    return failPortal(portalId, labelled("Blocked", verdict.reason));
  }
  if (verdict.kind === "unreachable") {
    finishRun(runId, "failed", verdict.reason);
    return failPortal(portalId, join(labelled("Portal not reachable", verdict.reason), `Trying again every ${config.failedRetryMinutes} min`));
  }

  // broken: repair, keep serving the last correct tenders meanwhile
  finishRun(runId, "failed", verdict.reason);
  return beginRepair(portalId, runId, ctx, verdict, baseline);
}

/** At most this share of a read may be held back; more points at a broken rule, which goes to repair. */
export const MAX_HELD_BACK_SHARE = 0.1;

/**
 * Removes tenders whose submission deadline falls before their publication date, when they are few
 * (at most MAX_HELD_BACK_SHARE of the read, and at least one tender stays). Many such tenders mean the
 * recipe reads the wrong value, so the read is returned whole and Watch sends it to repair.
 */
export function holdBackImpossibleTenders(read: ReadOutcome): { read: ReadOutcome; heldBack: Set<string> } {
  const heldBack = new Set<string>();
  if (read.kind !== "ok") return { read, heldBack };
  const bad = read.tenders.filter((t) =>
    t.publicationDate && t.submissionDeadline && isCalendarDate(t.publicationDate) &&
    t.submissionDeadline.slice(0, 10) < t.publicationDate);
  if (bad.length === 0 || bad.length > read.tenders.length * MAX_HELD_BACK_SHARE || bad.length === read.tenders.length) return { read, heldBack };
  for (const t of bad) heldBack.add(t.id);
  return { read: { ...read, tenders: read.tenders.filter((t) => !heldBack.has(t.id)) }, heldBack };
}

async function beginRepair(portalId: string, runId: string, ctx: PortalContext, verdict: Verdict, baseline: Baseline) {
  const reason = verdict.reason;
  const recipe = store.currentRecipe(portalId);
  if (!recipe) return failPortal(portalId, labelled("Could not learn this portal", reason));
  if (repairCoolingDown(portalId)) {
    ctx.log("The last repair failed; waiting before spending model calls on another attempt.", "warn");
    return failPortal(portalId, join(reason, "A previous repair failed; waiting before trying another"), config.pendingReadMinutes);
  }
  // `healing` means "still serving the last correct tenders". A portal that never served stays
  // `integrating` while its first recipe is repaired, so the state never promises tenders it lacks.
  const neverServed = !store.getPortal(portalId)?.last_success_at;
  store.setState(portalId, neverServed ? "integrating" : "healing", neverServed ? join("Attaching: repairing the first recipe", labelled("The first read looked wrong", reason)) : labelled("Repairing", reason));
  ctx.log(join(labelled("Read looks wrong", reason), "Starting a repair"), "warn");

  const repairId = "r_" + crypto.randomUUID().slice(0, 12);
  store.insertRun({ id: repairId, portalId, kind: "repair", startedAt: nowWithOffset() });
  const job = active.get(portalId);
  if (!job) return;
  Object.assign(job, { runId: repairId, kind: "repair" });
  const rctx = contextFor(portalId, ctx.url, repairId, job.controller);

  const publishedDocumentCounts = Object.fromEntries(store.listTenders(portalId)
    .filter((tender) => tender.documents.length > 0)
    .map((tender) => [tender.id, tender.documents.length]));
  // Extra field for the Medic; it joins Baseline in modules.ts once C agrees (status/A.md).
  const withdrawnIds = store.listTenders(portalId).filter((tender) => tender.status === "withdrawn").map((tender) => tender.id);
  const repairBaseline: Baseline & { publishedDocumentCounts: Record<string, number>; withdrawnIds: string[] } = { ...baseline, publishedDocumentCounts, withdrawnIds };
  const fixed = await medic.repair({ recipe, verdict, baseline: repairBaseline }, rctx);
  if (ctx.signal.aborted) return;
  if (fixed.kind !== "ok") {
    finishRun(repairId, "failed", fixed.reason);
    return failPortal(portalId, join(labelled("Could not repair", fixed.reason), "A person is needed"));
  }
  const recheck = watch.evaluate(fixed.read, baseline);
  if (recheck.kind !== "healthy") {
    finishRun(repairId, "failed", labelled("Repair did not pass the checks", recheck.reason));
    return failPortal(portalId, join(labelled("Could not repair", recheck.reason), "A person is needed"));
  }
  const golden = verifyGoldenRecords(fixed.read.tenders, baseline.golden);
  if (fixed.read.tenders.length > 0 && baseline.golden.length > 0 && golden.matched === 0) {
    const reason = "Could not verify the repair against any previously checked tender.";
    finishRun(repairId, "failed", reason);
    return failPortal(portalId, reason);
  }
  const previous = store.listTenders(portalId);
  const withDocuments = new Set(previous.filter((tender) => tender.documents.length > 0).map((tender) => tender.id));
  const dropped = fixed.read.tenders.filter((tender) => withDocuments.has(tender.id) && tender.documentRefs.length === 0 && !tender.documentRefsPending);
  if (dropped.length) {
    const reason = `Could not verify the repair: it found no files for ${count(dropped.length, "previously checked tender")} that had attachments.`;
    finishRun(repairId, "failed", reason);
    return failPortal(portalId, reason);
  }
  // A repair must not lose a cancellation: a tender we served as withdrawn that the patched recipe
  // still lists, but no longer marks withdrawn, would turn into a wrong "open" value.
  const wasWithdrawn = new Set(previous.filter((tender) => tender.status === "withdrawn").map((tender) => tender.id));
  const reopened = fixed.read.tenders.filter((tender) => wasWithdrawn.has(tender.id) && !tender.withdrawn);
  if (reopened.length) {
    const reason = `Could not verify the repair: it no longer sees the cancellation of ${count(reopened.length, "withdrawn tender")}.`;
    finishRun(repairId, "failed", reason);
    return failPortal(portalId, reason);
  }
  const { summary, documentsPending, documentFailures } = await deliver(portalId, fixed.read, rctx, fixed.recipe);
  if (ctx.signal.aborted) return;
  if (documentFailures.length) {
    const problem = documentFailures.find((failure) => failure.blocked) ?? documentFailures[0]!;
    const reason = problem.blocked ? problem.detail : labelled("Could not verify the repaired downloads", problem.detail);
    finishRun(repairId, "failed", reason);
    return failPortal(portalId, reason);
  }
  store.saveRecipe(portalId, fixed.recipe, "repair", fixed.summary, nowWithOffset());
  finishRun(repairId, "ok", join(fixed.summary, summary));
  store.setState(portalId, "serving", join(labelled("Repaired", fixed.summary), summary), nowWithOffset());
  scheduleNext(portalId, documentsPending ? config.pendingReadMinutes : config.readIntervalMinutes);
}

/**
 * What document problems in one read mean for the portal, out of the tenders whose documents were
 * fetched in that read. Login or captcha walls on more than half: the portal is blocked (failed,
 * a person must look). Other failures on more than half: the download path probably changed
 * (repair). Fewer: stay serving and say so; the next read fetches them again.
 */
export function classifyDocumentFailures(failures: DocumentFailure[], fetched: number) {
  if (failures.length === 0 || fetched === 0) return null;
  const blocked = failures.filter((f) => f.blocked);
  if (blocked.length * 2 > fetched) return { kind: "blocked" as const, reason: blocked[0]!.detail.replace(/\.$/, "") };
  if (failures.length * 2 > fetched) {
    return { kind: "broken" as const, reason: `Documents could not be fetched for ${failures.length} of ${count(fetched, "tender")}: ${failures.find((f) => !f.blocked)!.detail.replace(/\.$/, "")}` };
  }
  return null;
}

type DocumentFailure = { blocked: boolean; tenderId: string; detail: string };

// ------------------------------------------------------------ delivery

function hashTender(t: TenderT): string {
  const { lastChangedAt: _ignored, ...rest } = t;
  return sha(JSON.stringify(rest));
}

/** Keeps only values that pass the contract. A wrong value is worse than a missing one. */
function sanitize(et: ExtractedTender, documents: TenderDocument[], status: TenderT["status"], lastChangedAt: string): TenderT {
  const shape = Tender.shape;
  const required = (k: "title" | "buyerName") =>
    shape[k].safeParse(et[k] ?? null).success ? (et[k] ?? null) : null;
  const t: TenderT = {
    id: et.id,
    url: et.url,
    title: required("title"),
    buyerName: required("buyerName"),
    publicationDate: et.publicationDate && isCalendarDate(et.publicationDate) ? et.publicationDate : null,
    submissionDeadline: validDeadline(et.submissionDeadline),
    status,
    documents: documents.filter((d) => TenderDocumentSchema.safeParse(d).success),
    lastChangedAt,
  };
  for (const k of ["referenceNumber", "description", "procedureType", "contractNature", "cpvCodes", "placeOfPerformance"] as const) {
    const v = et[k];
    if (v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length)) continue;
    if (k === "placeOfPerformance" && typeof v === "object" && !Object.values(v).some((part) => typeof part === "string" && part.trim())) continue;
    if (shape[k].safeParse(v).success) (t as Record<string, unknown>)[k] = v;
  }
  return t;
}

function validDeadline(value: ExtractedTender["submissionDeadline"]): string | null {
  return value && Tender.shape.submissionDeadline.safeParse(value).success && Number.isFinite(dateTimeEpoch(value)) ? value : null;
}

/** Stage metadata until downloads pass the publication policy. Files are still streamed to disk. */
export async function deliver(portalId: string, read: OkRead, ctx: PortalContext, repairRecipe?: Recipe, heldBack: ReadonlySet<string> = new Set()): Promise<{ summary: string; pendingNew: number; documentsPending: boolean; documentFailures: DocumentFailure[]; documentsFetched: number }> {
  const now = nowWithOffset();
  // Held-back tenders are still on the portal: never close them for being absent from this delivery.
  const seen = new Set<string>(heldBack);
  let fresh = 0;
  let changed = 0;

  // One entry per tender id, first occurrence wins. A tender without a usable id or address cannot
  // be served (the contract requires both), so it is left out and logged, never sent half-valid.
  const unique: ExtractedTender[] = [];
  let unusable = 0;
  for (const et of read.tenders) {
    if (!Tender.shape.id.safeParse(et.id).success || !Tender.shape.url.safeParse(et.url).success) {
      unusable += 1;
      continue;
    }
    if (seen.has(et.id)) continue;
    seen.add(et.id);
    unique.push(et);
  }
  if (unusable > 0) ctx.log(`Left out ${count(unusable, "tender")} without a usable id or address.`, "warn");

  // Status comes from the same deadline the API shows: one without an offset is dropped by
  // sanitize, so it must not make a tender "closed" either.
  const statusOf = (et: ExtractedTender): TenderT["status"] => {
    const deadline = validDeadline(et.submissionDeadline);
    return et.withdrawn ? "withdrawn" : deadline && toEpoch(deadline) < Date.now() ? "closed" : "open";
  };

  // Failed fetches leave the previous refs hash intact, so changed refs keep needing a fetch.
  // Older rows with an empty refs hash are also retried. The budget decides which get a turn.
  const rows = new Map(unique.map((et) => [et.id, store.getTenderRow(portalId, et.id)]));
  const refsHashOf = new Map(unique.map((et) => [et.id, sha(JSON.stringify(et.documentRefs))]));
  const previousFileCounts = new Map<string, number>();
  if (repairRecipe) {
    for (const [id, row] of rows) {
      if (!row) continue;
      const files = (JSON.parse(row.json) as TenderT).documents.length;
      if (files > 0) previousFileCounts.set(id, files);
    }
  }
  const plan = planDocuments(
    unique.map((et) => {
      const row = rows.get(et.id);
      // Refs not looked for in this read (documentRefsPending) say nothing new: no fetch planned.
      const need: Need = et.documentRefsPending
        ? "none"
        : !row ? "new" : previousFileCounts.has(et.id) ? "changed" : row.refs_hash === refsHashOf.get(et.id) ? "none" : row.refs_hash === "" ? "retry" : "changed";
      return { id: et.id, need, refs: et.documentRefs.length, open: statusOf(et) === "open", publicationDate: et.publicationDate ?? null };
    }),
    // Until a portal has served once, fetch a small first batch so its first tenders appear in
    // minutes; the rest follow in the next reads, one minute apart.
    store.getPortal(portalId)?.last_success_at || repairRecipe ? config.docRefsPerRead : Math.min(config.firstDocRefs, config.docRefsPerRead),
  );

  let pendingRefs = 0;
  const documentFailures: DocumentFailure[] = [];
  const staged: { tender: TenderT; hash: string; refsHash: string }[] = [];
  let documentsFetched = 0;
  for (const et of unique) {
    if (ctx.signal.aborted) break;
    const row = rows.get(et.id);
    const refsHash = refsHashOf.get(et.id)!;
    const previousFiles = previousFileCounts.get(et.id) ?? 0;
    if (previousFiles > 0 && (et.documentRefsPending || !plan.fetch.has(et.id))) {
      documentFailures.push({ tenderId: et.id, blocked: false, detail: "A previously delivered tender's files could not be checked within this repair." });
      continue;
    }
    let documents: TenderDocument[];
    if (et.documentRefsPending) {
      // Do not combine a new listing with attachments from a different snapshot.
      pendingRefs += 1;
      continue;
    } else if (row && row.refs_hash === refsHash && previousFiles === 0) {
      documents = (JSON.parse(row.json) as TenderT).documents;
    } else if (plan.fetch.has(et.id)) {
      const got = await documentFetcher.fetchAll(et.documentRefs, ctx);
      if (ctx.signal.aborted) break;
      for (const p of got.problems) ctx.log(`Tender ${et.id}: ${p}`, "warn");
      documents = got.documents;
      if (et.documentRefs.length > 0) documentsFetched++;
      const failures = got.problems.filter((problem) => !/^Left out .+: it is over \d+ MB\.$/.test(problem));
      if (failures.length > 0) {
        // Login and captcha walls and robots.txt are blocks (a repair cannot get past them);
        // a web page instead of a file may be a moved link.
        const wall = failures.find((p) => /^(Documents need a login|Blocked by a captcha)|robots\.txt disallows/.test(p));
        documentFailures.push({ tenderId: et.id, detail: wall ?? failures[0]!, blocked: wall !== undefined });
        // A partial download is not a new snapshot. The old refs hash (or absent row) also
        // ensures we retry these refs instead of caching an incomplete attachment list.
        continue;
      }
      if (documents.length < previousFiles) {
        documentFailures.push({ tenderId: et.id, blocked: false, detail: `A previously delivered tender now has ${count(documents.length, "verified file")} instead of ${previousFiles}.` });
        continue;
      }
    } else {
      continue; // keep the last snapshot until this tender's documents can be verified
    }
    const draft = sanitize(et, documents, statusOf(et), now);
    const hash = hashTender(draft);
    if (!row) fresh += 1;
    else if (row.content_hash !== hash) changed += 1;
    const lastChangedAt = row && row.content_hash === hash ? row.last_changed_at : now;
    staged.push({ tender: { ...draft, lastChangedAt }, hash, refsHash });
  }

  // No longer listed => closed, but only when this read saw the whole list (see listing.ts):
  // a read capped by maxPages, or aborted halfway, did not see the older tenders.
  // Aborted (DELETE): stop before closing tenders or moving the baseline.
  if (ctx.signal.aborted) return { summary: "Stopped.", pendingNew: 0, documentsPending: false, documentFailures, documentsFetched };
  const rejectDelivery = repairRecipe
    ? documentFailures.length > 0
    : classifyDocumentFailures(documentFailures, documentsFetched) !== null;
  if (rejectDelivery) return { summary: "Downloads did not pass.", pendingNew: 0, documentsPending: false, documentFailures, documentsFetched };
  for (const { tender, hash, refsHash } of staged) store.upsertTender(portalId, tender, hash, refsHash, now);
  const pagination = (repairRecipe ?? store.currentRecipe(portalId))?.list.pagination;
  const wholeList = sawWholeList(pagination, read.diagnostics.listPages, ctx.signal.aborted, read.diagnostics.itemsSeen);
  if (maybeFirstPageOnly(pagination, read.diagnostics.itemsSeen)) {
    ctx.log(`The list showed exactly ${read.diagnostics.itemsSeen} tenders, a typical page size, and the recipe follows no pages: it may be only the first page, so no tender is closed for being absent (passed deadlines still close).`);
  }
  const oldestSeen = unique
    .map((et) => et.publicationDate)
    .filter((d): d is string => !!d && isCalendarDate(d))
    .reduce<string | null>((min, d) => (min === null || d < min ? d : min), null);
  for (const t of store.listTenders(portalId)) {
    // A held-back tender is still listed, so it never closes for being absent, but a passed deadline still closes it.
    const isHeldBack = heldBack.has(t.id);
    const close = mayClose({ wholeList: wholeList && !isHeldBack, submissionDeadline: t.submissionDeadline, now: Date.now(), toEpoch: dateTimeEpoch, publicationDate: t.publicationDate, oldestSeen });
    if ((!seen.has(t.id) || isHeldBack) && t.status === "open" && close) {
      const closed: TenderT = { ...t, status: "closed", lastChangedAt: now };
      store.upsertTender(portalId, closed, hashTender(closed), store.getTenderRow(portalId, t.id)?.refs_hash ?? "", now);
    }
  }

  const baseline = store.getBaseline(portalId);
  store.setBaseline(portalId, {
    ...baseline,
    lastGoodCount: read.tenders.length,
    lastGoodFieldFill: read.diagnostics.fieldFill,
    lastGoodSkeletonHash: read.diagnostics.listSkeletonHash ?? baseline.lastGoodSkeletonHash,
  });

  const delivered = store.listTenders(portalId);
  const open = delivered.filter((t) => t.status === "open").length;
  const at = formatWithOffset(new Date()).slice(11, 16);
  const pendingNew = plan.pendingNew + pendingRefs;
  const documentsPending = plan.pending + pendingRefs + documentFailures.length > 0;
  const waiting = pendingNew > 0 ? `; documents for ${count(pendingNew, "more tender")} are on their way` : "";
  const deferredUpdates = plan.pending - plan.pendingNew;
  const wallNotes = [
    [/^Documents need a login/i, "need a login"],
    [/^Blocked by a captcha/i, "are blocked by a captcha"],
    [/robots\.txt disallows/i, "are blocked by robots.txt"],
  ] as const;
  const namedWalls = documentFailures.filter((f) => f.blocked);
  const wallNote = wallNotes.map(([pattern, why]) => {
    const n = namedWalls.filter((f) => pattern.test(f.detail)).length;
    return n ? ` Documents for ${count(n, "tender")} ${why}; ${n === 1 ? "that tender is" : "those tenders are"} held back from this delivery.` : "";
  }).join("");
  const otherFailures = documentFailures.length - namedWalls.length;
  const documentNote = documentFailures.length
    ? wallNote + (otherFailures ? ` Documents for ${count(otherFailures, "tender")} could not be fetched; retrying next read.` : "")
    : deferredUpdates > 0 ? ` Document updates for ${count(deferredUpdates, "tender")} are on their way.`
      : documentsPending ? "" : " All checks passed.";
  const deliveryNote = delivered.length > 0 && read.tenders.every((t) => statusOf(t) !== "open")
    ? `This read found 0 open tenders; keeping ${count(delivered.length, "delivered tender")} available (${open} still marked open).`
    : `Serving ${count(open, "open tender")} (${fresh} new, ${changed} changed)${waiting}.`;
  return { summary: `${deliveryNote} Last read ${at}.${documentNote}`, pendingNew, documentsPending, documentFailures, documentsFetched };
}
