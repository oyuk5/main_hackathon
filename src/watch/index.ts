/**
 * Watch module. Owned by C.
 * evaluate(): deterministic verdict on a read. medic: repairs a broken recipe and proves it.
 */
import type { Medic, Watch } from "../shared/modules.js";
import { cartographer, extractor } from "../attach/index.js";
import { evaluateRead, verifyGoldenRecords } from "./checks.js";
import { createMedic } from "./medic.js";
import { capturePortalSnapshot } from "./snapshot.js";
import { triageBreakage } from "./triage.js";

export const watch: Watch = {
  evaluate: evaluateRead,
};

export const medic: Medic = createMedic({
  extractor,
  cartographer,
  evaluate: evaluateRead,
  verifyGolden: verifyGoldenRecords,
  captureSnapshot: capturePortalSnapshot,
  triage: triageBreakage,
});

export { evaluateRead, verifyGoldenRecords } from "./checks.js";
export { createMedic } from "./medic.js";
export { buildRepairSummary, summarizeRecipeChanges } from "./recipe-diff.js";
export { capturePortalSnapshot, compressHtml, compressJson, detectBlockInContent } from "./snapshot.js";
export { classifyWithRules, triageBreakage } from "./triage.js";
export type { GoldenVerificationResult, SnapshotOutcome, TriageCategory, TriageReport } from "./types.js";
