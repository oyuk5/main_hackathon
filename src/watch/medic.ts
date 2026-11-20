import { z } from "zod";
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
import { buildRepairSummary } from "./recipe-diff.js";
import type {
  GoldenVerificationResult,
  SnapshotOutcome,
  TriageReport,
} from "./types.js";

const DEFAULT_MAX_PATCH_ATTEMPTS = 3;

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
].join(" ");

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message.trim();
  return String(err);
}

function formatSingleSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  if (cleaned.length === 0) return "Repair failed.";
  return `${cleaned[0]!.toUpperCase()}${cleaned.slice(1)}.`;
}

function formatFailedChecks(checks: CheckResult[]): string {
  const failing = checks.filter((c) => !c.ok);
  if (failing.length === 0) return "none";
  return failing.map((c) => `- ${c.name}: ${c.detail}`).join("\n");
}

function formatSnapshotSection(snapshot: SnapshotOutcome): string {
  if (snapshot.kind !== "ok") {
    return `Snapshot status: ${snapshot.kind} (${snapshot.reason})`;
  }
  return [
    `Final URL: ${snapshot.finalUrl} (HTTP ${snapshot.httpStatus}, ${snapshot.contentType})`,
    `Structure summary:\n${snapshot.structureSummary}`,
    `Compressed content:\n${snapshot.compressedContent}`,
  ].join("\n\n");
}

function buildRepairPrompt(params: {
  recipe: Recipe;
  triage: TriageReport;
  golden: GoldenRecord[];
  previousFeedback: string | null;
}): string {
  const sections = [
    `Triage category: ${params.triage.category}`,
    `Triage reason: ${params.triage.reason}`,
    `Triage hint: ${params.triage.hint}`,
    params.triage.redirectUrl ? `Redirect URL: ${params.triage.redirectUrl}` : null,
    `Failing checks:\n${formatFailedChecks(params.triage.failedChecks)}`,
    `Previous recipe:\n${JSON.stringify(params.recipe, null, 2)}`,
    formatSnapshotSection(params.triage.snapshot),
    params.golden.length > 0
      ? `Golden records to preserve:\n${JSON.stringify(params.golden, null, 2)}`
      : null,
    params.previousFeedback
      ? `Previous patch attempt failed verification:\n${params.previousFeedback}\nFix these issues in the updated recipe.`
      : null,
  ];
  return sections.filter((s): s is string => s !== null).join("\n\n");
}

function describeVerdictFailure(verdict: Verdict): string {
  if (verdict.kind === "broken") {
    const failed = verdict.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
    if (failed.length > 0) return `${verdict.reason}: ${failed.join("; ")}`;
  }
  return verdict.reason;
}

function describeGoldenFailure(golden: GoldenVerificationResult): string {
  return `Golden mismatch (${golden.matched}/${golden.checked} matched): ${golden.mismatches.join("; ")}`;
}

type VerificationResult =
  | { kind: "ok"; read: Extract<ReadOutcome, { kind: "ok" }>; golden: GoldenVerificationResult }
  | { kind: "blocked"; reason: string }
  | { kind: "retry"; reason: string };

async function verifyCandidate(
  candidate: Recipe,
  baseline: Baseline,
  deps: MedicDeps,
  ctx: PortalContext,
): Promise<VerificationResult> {
  const read = await deps.extractor.read(candidate, ctx);
  const verdict = deps.evaluate(read, baseline);
  if (verdict.kind === "blocked") {
    return { kind: "blocked", reason: verdict.reason };
  }
  if (verdict.kind !== "healthy" || read.kind !== "ok") {
    return { kind: "retry", reason: describeVerdictFailure(verdict) };
  }
  const golden = deps.verifyGolden(read.tenders, baseline.golden);
  if (golden.mismatches.length > 0) {
    return { kind: "retry", reason: describeGoldenFailure(golden) };
  }
  return { kind: "ok", read, golden };
}

async function requestPatch(
  params: {
    recipe: Recipe;
    triage: TriageReport;
    golden: GoldenRecord[];
    previousFeedback: string | null;
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
  | { kind: "retry"; reason: string };

async function executePatchAttempt(params: {
  attempt: number;
  recipe: Recipe;
  baseline: Baseline;
  triage: TriageReport;
  previousFeedback: string | null;
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
        previousFeedback: params.previousFeedback,
      },
      params.ctx,
    );
  } catch (err) {
    const reason = `Repair model error: ${formatErrorMessage(err)}`;
    params.ctx.log(`Repair attempt ${params.attempt} failed: ${reason}`, "warn");
    return { kind: "retry", reason };
  }

  if (params.ctx.signal.aborted) {
    return { kind: "resolved", outcome: { kind: "failed", reason: "Repair cancelled." } };
  }
  const verified = await verifyCandidate(patched.recipe, params.baseline, params.deps, params.ctx);
  if (verified.kind === "blocked") {
    params.ctx.log(`Portal is blocked: ${verified.reason}`, "warn");
    return { kind: "resolved", outcome: { kind: "failed", reason: verified.reason } };
  }
  if (verified.kind === "ok") {
    const summary = buildRepairSummary({
      llmNote: patched.changeNote,
      before: params.recipe,
      after: patched.recipe,
      golden: verified.golden,
    });
    params.ctx.log(summary);
    return {
      kind: "resolved",
      outcome: { kind: "ok", recipe: patched.recipe, read: verified.read, summary },
    };
  }
  params.ctx.log(`Repair attempt ${params.attempt} did not pass verification: ${verified.reason}`, "warn");
  return { kind: "retry", reason: verified.reason };
}

type PatchLoopResult =
  | { kind: "resolved"; outcome: RepairOutcome }
  | { kind: "exhausted"; lastFailureReason: string };

async function runPatchLoop(params: {
  recipe: Recipe;
  baseline: Baseline;
  triage: TriageReport;
  deps: MedicDeps;
  ctx: PortalContext;
}): Promise<PatchLoopResult> {
  const maxAttempts = params.deps.maxPatchAttempts ?? DEFAULT_MAX_PATCH_ATTEMPTS;
  let lastFailureReason = params.triage.reason;
  let feedback: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (params.ctx.signal.aborted) {
      return { kind: "resolved", outcome: { kind: "failed", reason: "Repair cancelled." } };
    }
    const result = await executePatchAttempt({ ...params, attempt, previousFeedback: feedback });
    if (result.kind === "resolved") return result;
    lastFailureReason = result.reason;
    feedback = result.reason;
  }

  return { kind: "exhausted", lastFailureReason };
}

function verifyAttachedOutcome(params: {
  before: Recipe;
  attached: { recipe: Recipe; read: Extract<ReadOutcome, { kind: "ok" }>; note: string };
  baseline: Baseline;
  deps: MedicDeps;
  ctx: PortalContext;
}): RepairOutcome {
  const verdict = params.deps.evaluate(params.attached.read, params.baseline);
  if (verdict.kind === "blocked") return { kind: "failed", reason: verdict.reason };
  if (verdict.kind !== "healthy") {
    return { kind: "failed", reason: formatSingleSentence(describeVerdictFailure(verdict)) };
  }
  const golden = params.deps.verifyGolden(params.attached.read.tenders, params.baseline.golden);
  if (golden.mismatches.length > 0) {
    return { kind: "failed", reason: formatSingleSentence(describeGoldenFailure(golden)) };
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
}): Promise<RepairOutcome> {
  if (params.ctx.signal.aborted) {
    return { kind: "failed", reason: "Repair cancelled." };
  }
  params.ctx.log("Patch attempts failed; trying a fresh attach.");
  try {
    const attached = await params.deps.cartographer.attach(params.ctx);
    if (attached.kind === "blocked") return { kind: "failed", reason: attached.reason };
    if (attached.kind === "failed") {
      return { kind: "failed", reason: formatSingleSentence(attached.reason || params.fallbackReason) };
    }
    return verifyAttachedOutcome({
      before: params.recipe,
      attached,
      baseline: params.baseline,
      deps: params.deps,
      ctx: params.ctx,
    });
  } catch (err) {
    return {
      kind: "failed",
      reason: formatSingleSentence(`Fresh attach failed: ${formatErrorMessage(err)}`),
    };
  }
}

export function createMedic(deps: MedicDeps): Medic {
  return {
    async repair({ recipe, verdict, baseline }, ctx): Promise<RepairOutcome> {
      if (ctx.signal.aborted) {
        return { kind: "failed", reason: "Repair cancelled." };
      }

      const snapshot = await deps.captureSnapshot(recipe, ctx);
      if (ctx.signal.aborted) {
        return { kind: "failed", reason: "Repair cancelled." };
      }

      const triageReport = await deps.triage({ recipe, verdict, snapshot }, ctx);
      ctx.log(`Triage classified failure as ${triageReport.category}: ${triageReport.reason}`);

      if (triageReport.category === "blocked" || triageReport.category === "unreachable") {
        return { kind: "failed", reason: triageReport.reason };
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
      });
    },
  };
}
