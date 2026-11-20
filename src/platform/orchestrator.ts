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
import { config } from "./config.js";
import { store } from "./store.js";
import { politeBrowser, politeHttp } from "./polite.js";
import { documentFetcher } from "./documents.js";
import { count, join, labelled, sentence } from "./reason.js";
import { llmFor } from "../llm/client.js";
import { cartographer, extractor } from "../attach/index.js";
import { medic, watch } from "../watch/index.js";
import { formatWithOffset, nowWithOffset, toEpoch } from "../shared/time.js";
import { Tender, TenderDocument as TenderDocumentSchema } from "../shared/contract.js";
import type { Tender as TenderT, TenderDocument } from "../shared/contract.js";
import type { ExtractedTender, PortalContext, ReadOutcome } from "../shared/modules.js";

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
  return {
    portalId,
    url,
    http: politeHttp(controller.signal, counter),
    browser: politeBrowser(controller.signal, counter),
    llm: llmFor(portalId, runId),
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
    store.deletePortal(portalId);
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
      if (t.status === "open" && t.submissionDeadline && toEpoch(t.submissionDeadline) < now) {
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

function failPortal(portalId: string, reason: string) {
  if (!store.getPortal(portalId)) return;
  const kept = store.countTenders(portalId);
  // The contract needs a non-empty reason even when B or C gave none.
  const why = sentence(reason) || "Stopped without a reason from the reader; details are in the run log.";
  store.setState(portalId, "failed", kept ? join(why, `Keeping the last ${count(kept, "correct tender")}`) : why);
  scheduleNext(portalId, config.failedRetryMinutes);
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
    store.saveRecipe(portalId, out.recipe, out.recipe.family ? "family" : "attach", out.note, nowWithOffset());
    store.setGolden(portalId, out.golden);
    return judgeAndDeliver(portalId, runId, ctx, out.read);
  }

  // 2. Regular read: no model call
  let read = await extractor.read(recipe, ctx);
  for (const waitMs of [5_000, 20_000]) {
    if (read.kind !== "unreachable" || controller.signal.aborted) break;
    ctx.log(`Portal not reachable (${read.reason}). Trying again in ${waitMs / 1000} s.`, "warn");
    await new Promise((r) => setTimeout(r, waitMs));
    read = await extractor.read(recipe, ctx);
  }
  if (controller.signal.aborted) return;
  return judgeAndDeliver(portalId, runId, ctx, read);
}

async function judgeAndDeliver(portalId: string, runId: string, ctx: PortalContext, read: ReadOutcome) {
  const baseline = store.getBaseline(portalId);
  const verdict = watch.evaluate(read, baseline);

  if (verdict.kind === "healthy" && read.kind === "ok") {
    const summary = await deliver(portalId, read, ctx);
    finishRun(runId, "ok", summary);
    store.setState(portalId, "serving", summary, nowWithOffset());
    return scheduleNext(portalId, config.readIntervalMinutes);
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
  const recipe = store.currentRecipe(portalId);
  if (!recipe) return failPortal(portalId, labelled("Could not learn this portal", verdict.reason));
  store.setState(portalId, "healing", labelled("Repairing", verdict.reason));
  ctx.log(join(labelled("Read looks wrong", verdict.reason), "Starting a repair"), "warn");

  const repairId = "r_" + crypto.randomUUID().slice(0, 12);
  store.insertRun({ id: repairId, portalId, kind: "repair", startedAt: nowWithOffset() });
  const job = active.get(portalId);
  if (job) Object.assign(job, { runId: repairId, kind: "repair" });
  const rctx: PortalContext = { ...ctx, llm: llmFor(portalId, repairId), log: (m, l = "info") => store.addEvent(portalId, repairId, nowWithOffset(), l, m) };

  const fixed = await medic.repair({ recipe, verdict, baseline }, rctx);
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
  store.saveRecipe(portalId, fixed.recipe, "repair", fixed.summary, nowWithOffset());
  const summary = await deliver(portalId, fixed.read, rctx);
  finishRun(repairId, "ok", join(fixed.summary, summary));
  store.setState(portalId, "serving", join(labelled("Repaired", fixed.summary), summary), nowWithOffset());
  scheduleNext(portalId, config.readIntervalMinutes);
}

// ------------------------------------------------------------ delivery

function hashTender(t: TenderT): string {
  const { lastChangedAt: _ignored, ...rest } = t;
  return sha(JSON.stringify(rest));
}

/** Keeps only values that pass the contract. A wrong value is worse than a missing one. */
function sanitize(et: ExtractedTender, documents: TenderDocument[], status: TenderT["status"], lastChangedAt: string): TenderT {
  const shape = Tender.shape;
  const required = (k: "title" | "buyerName" | "publicationDate" | "submissionDeadline") =>
    shape[k].safeParse(et[k] ?? null).success ? (et[k] ?? null) : null;
  const t: TenderT = {
    id: et.id,
    url: et.url,
    title: required("title"),
    buyerName: required("buyerName"),
    publicationDate: required("publicationDate"),
    submissionDeadline: required("submissionDeadline"),
    status,
    documents: documents.filter((d) => TenderDocumentSchema.safeParse(d).success),
    lastChangedAt,
  };
  for (const k of ["referenceNumber", "description", "procedureType", "contractNature", "cpvCodes", "placeOfPerformance"] as const) {
    const v = et[k];
    if (v !== undefined && v !== null && shape[k].safeParse(v).success) (t as Record<string, unknown>)[k] = v;
  }
  return t;
}

async function deliver(portalId: string, read: OkRead, ctx: PortalContext): Promise<string> {
  const now = nowWithOffset();
  const seen = new Set<string>();
  let fresh = 0;
  let changed = 0;

  for (const et of read.tenders) {
    if (ctx.signal.aborted) break;
    if (seen.has(et.id)) continue;
    seen.add(et.id);
    const row = store.getTenderRow(portalId, et.id);
    const refsHash = sha(JSON.stringify(et.documentRefs));
    let documents: TenderDocument[];
    // Documents are fetched again only when the refs change, or when the last fetch had problems
    // (stored with an empty refs hash), so a failed download is retried on the next read.
    let storedRefsHash = refsHash;
    if (row && row.refs_hash === refsHash) {
      documents = (JSON.parse(row.json) as TenderT).documents;
    } else {
      const got = await documentFetcher.fetchAll(et.documentRefs, ctx);
      if (ctx.signal.aborted) break;
      for (const p of got.problems) ctx.log(`Tender ${et.id}: ${p}`, "warn");
      documents = got.documents;
      if (got.problems.length > 0) storedRefsHash = "";
    }
    const status: TenderT["status"] = et.withdrawn
      ? "withdrawn"
      : et.submissionDeadline && toEpoch(et.submissionDeadline) < Date.now()
        ? "closed"
        : "open";
    const draft = sanitize(et, documents, status, now);
    const hash = hashTender(draft);
    if (!row) fresh += 1;
    else if (row.content_hash !== hash) changed += 1;
    const lastChangedAt = row && row.content_hash === hash ? row.last_changed_at : now;
    store.upsertTender(portalId, { ...draft, lastChangedAt }, hash, storedRefsHash, now);
  }

  // No longer listed => closed.
  for (const t of store.listTenders(portalId)) {
    if (!seen.has(t.id) && t.status === "open") {
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

  const open = store.listTenders(portalId).filter((t) => t.status === "open").length;
  const at = formatWithOffset(new Date()).slice(11, 16);
  return `Serving ${count(open, "open tender")} (${fresh} new, ${changed} changed). Last read ${at}, all checks passed.`;
}
