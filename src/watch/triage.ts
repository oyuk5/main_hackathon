import { z } from "zod";
import type { CheckResult, PortalContext, Verdict } from "../shared/modules.js";
import type { Recipe } from "../shared/recipe.js";
import type { SnapshotOutcome, TriageCategory, TriageReport } from "./types.js";

const TriageCategorySchema = z.enum([
  "blocked",
  "unreachable",
  "url-moved",
  "selector-broken",
  "json-key-renamed",
  "pagination-changed",
  "format-changed",
  "golden-mismatch",
  "unknown",
]);

const LlmTriageSchema = z.object({
  category: TriageCategorySchema,
  reason: z.string(),
  hint: z.string(),
});

const FORMAT_CHECK_NAMES = new Set(["dates", "deadline-order", "cpv-codes"]);

export function classifyWithRules(
  recipe: Recipe,
  failedChecks: CheckResult[],
  snapshot: SnapshotOutcome,
): TriageReport {
  const failures = failedChecks.filter((check) => !check.ok);

  if (snapshot.kind === "blocked") {
    return buildReport("blocked", snapshot.reason, "Portal requires login or captcha.", failures, snapshot);
  }

  if (snapshot.kind === "unreachable") {
    return buildReport("unreachable", snapshot.reason, "Portal is temporarily unreachable.", failures, snapshot);
  }

  const urlMoveReport = detectUrlMove(failures, snapshot);
  if (urlMoveReport) {
    return urlMoveReport;
  }

  return classifyByFailedChecks(recipe, failures, snapshot);
}

function detectUrlMove(
  failures: CheckResult[],
  snapshot: Extract<SnapshotOutcome, { kind: "ok" }>,
): TriageReport | null {
  if (snapshot.httpStatus === 404) {
    return {
      ...buildReport(
        "url-moved",
        `Portal list URL returned HTTP 404 (${snapshot.url}).`,
        "Update recipe.list.request.url to the portal's new tender list endpoint.",
        failures,
        snapshot,
      ),
      redirectUrl: snapshot.finalUrl,
    };
  }

  if (hasSignificantPathChange(snapshot.url, snapshot.finalUrl)) {
    return {
      ...buildReport(
        "url-moved",
        `Portal redirected from ${snapshot.url} to ${snapshot.finalUrl}.`,
        "Update recipe.list.request.url to the redirected destination.",
        failures,
        snapshot,
      ),
      redirectUrl: snapshot.finalUrl,
    };
  }

  return null;
}

function hasSignificantPathChange(requestedUrl: string, finalUrl: string): boolean {
  try {
    const req = new URL(requestedUrl);
    const fin = new URL(finalUrl);
    const reqHost = req.hostname.replace(/^www\./i, "").toLowerCase();
    const finHost = fin.hostname.replace(/^www\./i, "").toLowerCase();
    if (reqHost !== finHost) {
      return true;
    }
    const reqPath = normalizePathname(req.pathname);
    const finPath = normalizePathname(fin.pathname);
    return reqPath !== finPath;
  } catch {
    return false;
  }
}

function normalizePathname(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed.toLowerCase();
}

function classifyByFailedChecks(
  recipe: Recipe,
  failures: CheckResult[],
  snapshot: SnapshotOutcome,
): TriageReport {
  const failedNames = new Set(failures.map((check) => check.name));
  const hasItemsFailure = failedNames.has("items") || failedNames.has("item-count");
  const hasFillFailure = [...failedNames].some((name) => name.startsWith("fill:") || name.startsWith("field-fill:"));
  const hasFormatFailure = [...failedNames].some((name) => FORMAT_CHECK_NAMES.has(name));

  if (failedNames.has("golden-records")) {
    return buildReport(
      "golden-mismatch",
      summarizeChecks(failures, "Golden record verification failed."),
      "Compare extracted fields against golden records and update mismatched field rules.",
      failures,
      snapshot,
    );
  }

  if (hasFormatFailure && !hasItemsFailure) {
    return buildReport(
      "format-changed",
      summarizeChecks(failures, "Date or code format validation failed."),
      "Inspect date/deadline/CPV formatting in the snapshot and update field parse/format rules.",
      failures,
      snapshot,
    );
  }

  if (failedNames.has("count-drop") && !hasItemsFailure && !hasFillFailure) {
    return buildReport(
      "pagination-changed",
      summarizeChecks(failures, "Item count dropped significantly while selectors still match."),
      "Check pagination links, page parameters, or page size in the snapshot.",
      failures,
      snapshot,
    );
  }

  if (hasItemsFailure || hasFillFailure) {
    return classifyExtractionFailure(recipe, failures, snapshot);
  }

  return buildReport(
    "unknown",
    summarizeChecks(failures, "Breakage cause could not be determined from rules."),
    "Inspect the portal snapshot and failed checks to diagnose the root cause.",
    failures,
    snapshot,
  );
}

function classifyExtractionFailure(
  recipe: Recipe,
  failures: CheckResult[],
  snapshot: SnapshotOutcome,
): TriageReport {
  if (recipe.tier === "jsonApi") {
    return buildReport(
      "json-key-renamed",
      summarizeChecks(failures, "JSON API extraction returned missing items or fields."),
      "Inspect the compressed JSON keys and update recipe.list.item or jsonPath field rules.",
      failures,
      snapshot,
    );
  }

  return buildReport(
    "selector-broken",
    summarizeChecks(failures, "HTML/DOM extraction returned missing items or fields."),
    "Inspect the compressed HTML structure and update broken CSS/item selectors.",
    failures,
    snapshot,
  );
}

function summarizeChecks(failures: CheckResult[], fallback: string): string {
  if (failures.length === 0) {
    return fallback;
  }
  return failures.map((check) => `${check.name}: ${check.detail}`).join("; ");
}

function buildReport(
  category: TriageCategory,
  reason: string,
  hint: string,
  failedChecks: CheckResult[],
  snapshot: SnapshotOutcome,
): TriageReport {
  return { category, reason, hint, failedChecks, snapshot };
}

function extractFailedChecks(verdict: Verdict): CheckResult[] {
  if (verdict.kind === "healthy" || verdict.kind === "broken") {
    return verdict.checks.filter((check) => !check.ok);
  }
  return [];
}

export async function triageBreakage(
  input: { recipe: Recipe; verdict: Verdict; snapshot: SnapshotOutcome },
  ctx: PortalContext,
): Promise<TriageReport> {
  const failedChecks = extractFailedChecks(input.verdict);
  const ruleReport = classifyWithRules(input.recipe, failedChecks, input.snapshot);

  if (ruleReport.category !== "unknown" || input.snapshot.kind !== "ok" || ctx.signal.aborted) {
    return ruleReport;
  }

  return classifyWithLlm(input.recipe, ruleReport, input.snapshot, ctx);
}

async function classifyWithLlm(
  recipe: Recipe,
  fallback: TriageReport,
  snapshot: Extract<SnapshotOutcome, { kind: "ok" }>,
  ctx: PortalContext,
): Promise<TriageReport> {
  const system = [
    "You triage why a public-procurement portal scraper broke.",
    "Choose the most specific category and provide a concise plain-English reason and repair hint.",
  ].join(" ");

  const user = JSON.stringify(
    {
      tier: recipe.tier,
      listUrl: recipe.list.request.url,
      itemSelector: recipe.list.item,
      failedChecks: fallback.failedChecks,
      httpStatus: snapshot.httpStatus,
      finalUrl: snapshot.finalUrl,
      structureSummary: snapshot.structureSummary,
      compressedContent: snapshot.compressedContent.slice(0, 3000),
    },
    null,
    2,
  );

  try {
    const classified = await ctx.llm.json({
      purpose: "triage",
      model: "fast",
      system,
      user,
      schema: LlmTriageSchema,
    });
    return {
      ...fallback,
      category: classified.category,
      reason: classified.reason,
      hint: classified.hint,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`Triage LLM fallback failed: ${message}`, "warn");
    return fallback;
  }
}
