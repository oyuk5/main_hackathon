import { z } from "zod";
import { load } from "cheerio";
import { compressHtml, detectBlockInContent } from "./snapshot.js";
import { Recipe } from "../shared/recipe.js";
import type {
  Baseline,
  Cartographer,
  CheckResult,
  ExtractedTender,
  Extractor,
  GoldenRecord,
  Medic,
  PortalContext,
  ReadOutcome,
  RepairOutcome,
  Verdict,
} from "../shared/modules.js";
import { buildRepairSummary, summarizeRecipeChanges } from "./recipe-diff.js";
import { plural, sanitizeOperatorReason } from "./text.js";
import type {
  GoldenVerificationResult,
  SnapshotOutcome,
  TriageReport,
} from "./types.js";

const DEFAULT_MAX_PATCH_ATTEMPTS = 3;
const MAX_SAMPLE_TENDERS = 2;

interface AttemptFeedback {
  attempt: number;
  changesTried: string;
  reason: string;
  sampleTenders: Array<Record<string, unknown>>;
}

const PatchResponseSchema = z.object({
  recipe: Recipe,
  changeNote: z.string().min(1),
});

type PatchResponse = z.infer<typeof PatchResponseSchema>;

export interface MedicDeps {
  extractor: Extractor;
  cartographer: Cartographer;
  evaluate: (read: ReadOutcome, baseline: Baseline) => Verdict;
  verifyGolden: (tenders: ExtractedTender[], golden: GoldenRecord[]) => GoldenVerificationResult;
  captureSnapshot: (recipe: Recipe, ctx: PortalContext) => Promise<SnapshotOutcome>;
  triage: (
    input: { recipe: Recipe; verdict: Verdict; snapshot: SnapshotOutcome },
    ctx: PortalContext,
  ) => Promise<TriageReport>;
  maxPatchAttempts?: number;
}

const REPAIR_SYSTEM_PROMPT = [
  "You are Watchtower's Medic. Repair a broken portal extraction Recipe using the live page snapshot and triage report.",
  "Return a complete, valid Recipe (schemaVersion: 1) and a brief plain-English changeNote describing what changed on the portal.",
  "Preserve all golden tender fields accurately. Never invent selectors that are not supported by the live snapshot.",
  "Never clear list.item or listFields to match an empty list; keep extraction selectors intact and add any no-tenders wording to list.emptyText.",
].join(" ");

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message.trim();
  return String(err);
}

function formatFailedChecks(checks: CheckResult[]): string {
  const failing = checks.filter((c) => !c.ok);
  if (failing.length === 0) return "none";
  return failing.map((c) => `- ${c.name}: ${c.detail}`).join("\n");
}

function formatSnapshotSection(snapshot: SnapshotOutcome): string {
  if (snapshot.kind !== "ok") {
    return `Portal check failed: ${snapshot.reason} (${snapshot.kind})`;
  }
  const sections = [
    `Final URL: ${snapshot.finalUrl} (HTTP ${snapshot.httpStatus}, ${snapshot.contentType})`,
    snapshot.capturedApiUrls && snapshot.capturedApiUrls.length > 0
      ? `Discovered JSON API URLs:\n${snapshot.capturedApiUrls.map((u) => `- ${u}`).join("\n")}`
      : null,
    `Structure summary:\n${snapshot.structureSummary}`,
    `Compressed content:\n${snapshot.compressedContent}`,
  ];
  return sections.filter((s): s is string => s !== null).join("\n\n");
}

function formatAttemptHistory(history: AttemptFeedback[]): string | null {
  if (history.length === 0) return null;
  const entries = history.map((item) => {
    const header = `Attempt ${item.attempt} (${item.changesTried}) failed: ${item.reason}`;
    return item.sampleTenders.length > 0
      ? `${header}\nSample extracted tenders:\n${JSON.stringify(item.sampleTenders, null, 2)}`
      : header;
  });
  return `Previous patch attempts failed verification:\n${entries.join("\n\n")}\nFix these issues without repeating failed selectors.`;
}

function buildRepairPrompt(params: {
  recipe: Recipe;
  triage: TriageReport;
  golden: GoldenRecord[];
  attemptHistory: AttemptFeedback[];
  pageEvidence?: string;
}): string {
  const sections = [
    `Triage category: ${params.triage.category}`,
    `Triage reason: ${params.triage.reason}`,
    `Triage hint: ${params.triage.hint}`,
    params.triage.redirectUrl ? `Redirect URL: ${params.triage.redirectUrl}` : null,
    `Failing checks:\n${formatFailedChecks(params.triage.failedChecks)}`,
    `Previous recipe:\n${JSON.stringify(params.recipe, null, 2)}`,
    formatSnapshotSection(params.triage.snapshot),
    params.pageEvidence ?? null,
    params.golden.length > 0
      ? `Golden records to preserve:\n${JSON.stringify(params.golden, null, 2)}`
      : null,
    formatAttemptHistory(params.attemptHistory),
  ];
  return sections.filter((s): s is string => s !== null).join("\n\n");
}

function summarizeSampleTenders(read: ReadOutcome): Array<Record<string, unknown>> {
  if (read.kind !== "ok") return [];
  return read.tenders.slice(0, MAX_SAMPLE_TENDERS).map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    buyerName: t.buyerName,
    publicationDate: t.publicationDate,
    submissionDeadline: t.submissionDeadline,
    documentRefsCount: t.documentRefs.length,
  }));
}

function describeVerdictForPrompt(verdict: Verdict): string {
  if (verdict.kind === "broken") {
    const failed = verdict.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
    if (failed.length > 0) return `${verdict.reason}: ${failed.join("; ")}`;
  }
  return verdict.reason;
}

function describeVerdictForOperator(verdict: Verdict): string {
  const fallback = "The repaired recipe failed verification checks.";
  const direct = sanitizeOperatorReason(verdict.reason, "");
  if (direct.length > 0) return direct;
  if (verdict.kind === "broken") {
    const details = verdict.checks
      .filter((c) => !c.ok)
      .map((c) => sanitizeOperatorReason(c.detail, ""))
      .filter((d) => d.length > 0);
    if (details.length > 0) return details.join(" ");
  }
  return fallback;
}

function describeGoldenForPrompt(golden: GoldenVerificationResult): string {
  return `Known tender verification failed (${golden.matched} of ${golden.checked} matched): ${golden.mismatches.join("; ")}`;
}

function describeGoldenForOperator(golden: GoldenVerificationResult): string {
  return `Only ${golden.matched} of ${golden.checked} known tenders matched after repair.`;
}

type VerificationResult =
  | { kind: "ok"; read: Extract<ReadOutcome, { kind: "ok" }>; golden: GoldenVerificationResult }
  | { kind: "blocked"; reason: string }
  | {
      kind: "retry";
      promptReason: string;
      operatorReason: string;
      sampleTenders: Array<Record<string, unknown>>;
    };

async function verifyCandidate(
  candidate: Recipe,
  previousRecipe: Recipe,
  baseline: Baseline,
  deps: MedicDeps,
  ctx: PortalContext,
): Promise<VerificationResult> {
  const read = await deps.extractor.read(candidate, ctx);
  const verdict = deps.evaluate(read, baseline);
  if (verdict.kind === "blocked") {
    return {
      kind: "blocked",
      reason: sanitizeOperatorReason(verdict.reason, "Portal requires a login or security check."),
    };
  }
  const sampleTenders = summarizeSampleTenders(read);
  if (verdict.kind !== "healthy" || read.kind !== "ok") {
    return {
      kind: "retry",
      promptReason: describeVerdictForPrompt(verdict),
      operatorReason: describeVerdictForOperator(verdict),
      sampleTenders,
    };
  }
  if (
    read.tenders.length === 0 &&
    ((previousRecipe.list.item.trim().length > 0 && candidate.list.item.trim().length === 0) ||
      (Object.keys(previousRecipe.listFields).length > 0 && Object.keys(candidate.listFields).length === 0) ||
      (previousRecipe.detail !== null && candidate.detail === null) ||
      (previousRecipe.documents !== null && candidate.documents === null))
  ) {
    return {
      kind: "retry",
      promptReason: "Do not clear list.item, listFields, detail, or documents when 0 tenders are currently shown. Preserve the existing selectors and add the empty-day wording to list.emptyText instead.",
      operatorReason: "The patch cleared existing extraction rules instead of preserving them.",
      sampleTenders,
    };
  }
  const golden = deps.verifyGolden(read.tenders, baseline.golden);
  if (golden.mismatches.length > 0) {
    return {
      kind: "retry",
      promptReason: describeGoldenForPrompt(golden),
      operatorReason: describeGoldenForOperator(golden),
      sampleTenders,
    };
  }
  // A candidate that reproduces none of the known tenders proves nothing; the platform would refuse it.
  if (read.tenders.length > 0 && baseline.golden.length > 0 && golden.matched === 0) {
    return {
      kind: "retry",
      promptReason: "None of the known (golden) tenders were found with their values. Make sure the list rule still reads the same tenders and their id, title and url.",
      operatorReason: "The patch matched none of the known tenders.",
      sampleTenders,
    };
  }
  // A ZIP ref can legitimately expand into multiple delivered files; Platform checks the bytes and final count.
  const published = (baseline as Baseline & { publishedDocumentCounts?: Readonly<Record<string, number>> }).publishedDocumentCounts ?? {};
  const lostFiles = read.tenders.filter((t) => {
    const refs = new Set(t.documentRefs.map((ref) => ref.url));
    const hasArchive = t.documentRefs.some((ref) => /\.zip(?:[?#]|$)/i.test(ref.url) || /\.zip$/i.test(ref.fileNameHint ?? ""));
    return !t.documentRefsPending && refs.size < (published[t.id] ?? 0) && !hasArchive;
  });
  if (lostFiles.length > 0) {
    const counts = lostFiles.slice(0, 3).map((t) => `${t.id}: ${new Set(t.documentRefs.map((ref) => ref.url)).size} of ${published[t.id]} previously delivered files`).join(", ");
    return {
      kind: "retry",
      promptReason: `The documents rule returned fewer files than previously delivered (${counts}). Fix the documents rule against the tender's own page.`,
      operatorReason: `The patch returned fewer files for ${plural(lostFiles.length, "tender")} that had attachments.`,
      sampleTenders,
    };
  }
  return { kind: "ok", read, golden };
}

async function requestPatch(
  params: {
    recipe: Recipe;
    triage: TriageReport;
    golden: GoldenRecord[];
    attemptHistory: AttemptFeedback[];
    pageEvidence?: string;
  },
  ctx: PortalContext,
): Promise<PatchResponse> {
  return ctx.llm.json({
    purpose: "repair",
    model: "smart",
    system: REPAIR_SYSTEM_PROMPT,
    user: buildRepairPrompt(params),
    schema: PatchResponseSchema,
  });
}

type PatchAttemptOutcome =
  | { kind: "resolved"; outcome: RepairOutcome }
  | { kind: "retry"; feedback: AttemptFeedback; operatorReason: string };

function normalizePatchedRecipe(
  patched: Recipe,
  original: Recipe,
  triageCategory: TriageReport["category"],
): Recipe {
  if (triageCategory !== "format-changed" && patched.timeZone.trim().length === 0) {
    return { ...patched, timeZone: original.timeZone };
  }
  return patched;
}

async function executePatchAttempt(params: {
  attempt: number;
  recipe: Recipe;
  baseline: Baseline;
  triage: TriageReport;
  attemptHistory: AttemptFeedback[];
  pageEvidence?: string;
  deps: MedicDeps;
  ctx: PortalContext;
}): Promise<PatchAttemptOutcome> {
  let patched: PatchResponse;
  try {
    patched = await requestPatch(
      {
        recipe: params.recipe,
        triage: params.triage,
        golden: params.baseline.golden,
        attemptHistory: params.attemptHistory,
        pageEvidence: params.pageEvidence,
      },
      params.ctx,
    );
  } catch (err) {
    if (params.ctx.signal.aborted) {
      return { kind: "resolved", outcome: { kind: "failed", reason: "Repair stopped." } };
    }
    const operatorReason = "The repair model did not return a valid fix.";
    params.ctx.log(
      `Repair attempt ${params.attempt} could not get a fix from the model; trying again.`,
      "warn",
    );
    return {
      kind: "retry",
      operatorReason,
      feedback: {
        attempt: params.attempt,
        changesTried: "LLM request failed",
        reason: `Model request failed (${formatErrorMessage(err)})`,
        sampleTenders: [],
      },
    };
  }

  if (params.ctx.signal.aborted) {
    return { kind: "resolved", outcome: { kind: "failed", reason: "Repair stopped." } };
  }
  const candidateRecipe = normalizePatchedRecipe(patched.recipe, params.recipe, params.triage.category);
  const verified = await verifyCandidate(candidateRecipe, params.recipe, params.baseline, params.deps, params.ctx);
  if (params.ctx.signal.aborted) {
    return { kind: "resolved", outcome: { kind: "failed", reason: "Repair stopped." } };
  }
  if (verified.kind === "blocked") {
    const logLine = verified.reason.toLowerCase().startsWith("portal")
      ? verified.reason
      : `Portal is blocked: ${verified.reason}`;
    params.ctx.log(logLine, "warn");
    return { kind: "resolved", outcome: { kind: "failed", reason: verified.reason } };
  }
  if (verified.kind === "ok") {
    const summary = buildRepairSummary({
      llmNote: patched.changeNote,
      before: params.recipe,
      after: candidateRecipe,
      golden: verified.golden,
    });
    params.ctx.log(summary);
    return {
      kind: "resolved",
      outcome: { kind: "ok", recipe: candidateRecipe, read: verified.read, summary },
    };
  }
  params.ctx.log(
    `Repair attempt ${params.attempt} did not pass verification: ${verified.operatorReason}`,
    "warn",
  );
  return {
    kind: "retry",
    operatorReason: verified.operatorReason,
    feedback: {
      attempt: params.attempt,
      changesTried: summarizeRecipeChanges(params.recipe, candidateRecipe),
      reason: verified.promptReason,
      sampleTenders: verified.sampleTenders,
    },
  };
}

type PatchLoopResult =
  | { kind: "resolved"; outcome: RepairOutcome }
  | { kind: "exhausted"; lastFailureReason: string; maxAttempts: number };

async function captureTenderEvidence(recipe: Recipe, baseline: Baseline, ctx: PortalContext): Promise<string | undefined> {
  if (!recipe.detail && !recipe.documents) return;
  const golden = baseline.golden.find((record) => typeof record.fields.url === "string");
  if (!golden || ctx.signal.aborted) return;
  const page = async (target: URL) => {
    if (!/^https?:$/.test(target.protocol) || ctx.signal.aborted) return;
    try {
      const res = await ctx.http.fetch(target.href, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(8_000)]) });
      if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "")) {
        await res.body?.cancel();
        return;
      }
      const url = new URL(res.url || target.href);
      const reader = res.body?.getReader();
      if (!reader) return;
      let body = "";
      const decoder = new TextDecoder();
      try {
        while (body.length < 64_000) {
          const chunk = await reader.read();
          if (chunk.done) break;
          body += decoder.decode(chunk.value, { stream: true });
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (!detectBlockInContent(body, res.status, url.href)) return { body: body.slice(0, 64_000), url };
    } catch { /* Supplementary evidence is optional; still try the list snapshot. */ }
  };
  try {
    const detail = await page(new URL(String(golden.fields.url), ctx.url));
    if (!detail) return;
    const evidence = [`Known tender detail page (${detail.url.href}):\n${compressHtml(detail.body, 5200).compressed}`];
    if (recipe.documents) {
      const $ = load(detail.body);
      const link = $("a[href]").toArray().find((el) => {
        const href = $(el).attr("href") ?? "";
        return href && !/\.(pdf|zip|docx?|xlsx?)(?:[?#]|$)/i.test(href) &&
          /dokument|za[łl][ąa]cznik|attachment|annexe|pi[eè]ce|unterlag|beilage/i.test(`${$(el).text()} ${href}`);
      });
      if (link) {
        const target = new URL($(link).attr("href")!, detail.url);
        if (target.origin === detail.url.origin) {
          const documents = await page(target);
          if (documents) evidence.push(`Linked tender documents page (${documents.url.href}):\n${compressHtml(documents.body, 4200).compressed}`);
        }
      }
    }
    return evidence.join("\n\n");
  } catch { return; }
}

async function runPatchLoop(params: {
  recipe: Recipe;
  baseline: Baseline;
  triage: TriageReport;
  deps: MedicDeps;
  ctx: PortalContext;
}): Promise<PatchLoopResult> {
  const maxAttempts = params.deps.maxPatchAttempts ?? DEFAULT_MAX_PATCH_ATTEMPTS;
  let lastFailureReason = sanitizeOperatorReason(
    params.triage.reason,
    "The repair could not be verified.",
  );
  const attemptHistory: AttemptFeedback[] = [];
  const pageEvidence = await captureTenderEvidence(params.recipe, params.baseline, params.ctx);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (params.ctx.signal.aborted) {
      return { kind: "resolved", outcome: { kind: "failed", reason: "Repair stopped." } };
    }
    const result = await executePatchAttempt({ ...params, attempt, attemptHistory, pageEvidence });
    if (result.kind === "resolved") return result;
    lastFailureReason = result.operatorReason;
    attemptHistory.push(result.feedback);
  }

  return { kind: "exhausted", lastFailureReason, maxAttempts };
}

function verifyAttachedOutcome(params: {
  before: Recipe;
  attached: { recipe: Recipe; read: Extract<ReadOutcome, { kind: "ok" }>; note: string };
  baseline: Baseline;
  deps: MedicDeps;
  ctx: PortalContext;
}): RepairOutcome {
  const verdict = params.deps.evaluate(params.attached.read, params.baseline);
  if (verdict.kind === "blocked") {
    return {
      kind: "failed",
      reason: sanitizeOperatorReason(verdict.reason, "Portal requires a login or security check."),
    };
  }
  if (verdict.kind !== "healthy") {
    return { kind: "failed", reason: describeVerdictForOperator(verdict) };
  }
  const golden = params.deps.verifyGolden(params.attached.read.tenders, params.baseline.golden);
  if (golden.mismatches.length > 0) {
    return { kind: "failed", reason: describeGoldenForOperator(golden) };
  }
  const summary = buildRepairSummary({
    llmNote: params.attached.note || "Re-attached portal from scratch",
    before: params.before,
    after: params.attached.recipe,
    golden,
  });
  params.ctx.log(summary);
  return { kind: "ok", recipe: params.attached.recipe, read: params.attached.read, summary };
}

async function tryFreshAttach(params: {
  recipe: Recipe;
  baseline: Baseline;
  deps: MedicDeps;
  ctx: PortalContext;
  fallbackReason: string;
  maxAttempts: number;
}): Promise<RepairOutcome> {
  if (params.ctx.signal.aborted) {
    return { kind: "failed", reason: "Repair stopped." };
  }
  params.ctx.log("Targeted fixes did not pass verification; trying a fresh reconnect.");
  const exhaustedReason =
    params.maxAttempts > 0
      ? `Could not repair the portal after ${plural(params.maxAttempts, "attempt")} and a fresh reconnect.`
      : params.fallbackReason;
  try {
    const attached = await params.deps.cartographer.attach(params.ctx);
    if (params.ctx.signal.aborted) {
      return { kind: "failed", reason: "Repair stopped." };
    }
    if (attached.kind === "blocked") {
      return {
        kind: "failed",
        reason: sanitizeOperatorReason(attached.reason, "Portal requires a login or security check."),
      };
    }
    if (attached.kind === "failed") {
      return {
        kind: "failed",
        reason: sanitizeOperatorReason(attached.reason, exhaustedReason),
      };
    }
    return verifyAttachedOutcome({
      before: params.recipe,
      attached,
      baseline: params.baseline,
      deps: params.deps,
      ctx: params.ctx,
    });
  } catch {
    if (params.ctx.signal.aborted) {
      return { kind: "failed", reason: "Repair stopped." };
    }
    params.ctx.log("Fresh reconnect failed during repair.", "warn");
    return { kind: "failed", reason: exhaustedReason };
  }
}

export function createMedic(deps: MedicDeps): Medic {
  return {
    async repair({ recipe, verdict, baseline }, ctx): Promise<RepairOutcome> {
      if (ctx.signal.aborted) {
        return { kind: "failed", reason: "Repair stopped." };
      }

      const snapshot = await deps.captureSnapshot(recipe, ctx);
      if (ctx.signal.aborted) {
        return { kind: "failed", reason: "Repair stopped." };
      }

      const triageReport = await deps.triage({ recipe, verdict, snapshot }, ctx);
      if (ctx.signal.aborted) {
        return { kind: "failed", reason: "Repair stopped." };
      }

      const diagnosedReason = sanitizeOperatorReason(triageReport.reason, "Portal checks failed.");
      ctx.log(`Diagnosed issue: ${diagnosedReason}`);

      if (triageReport.category === "blocked" || triageReport.category === "unreachable") {
        return { kind: "failed", reason: diagnosedReason };
      }

      const loopResult = await runPatchLoop({
        recipe,
        baseline,
        triage: triageReport,
        deps,
        ctx,
      });
      if (loopResult.kind === "resolved") {
        return loopResult.outcome;
      }

      return tryFreshAttach({
        recipe,
        baseline,
        deps,
        ctx,
        fallbackReason: loopResult.lastFailureReason,
        maxAttempts: loopResult.maxAttempts,
      });
    },
  };
}
