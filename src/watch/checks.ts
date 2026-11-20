import { DateTimeWithOffset, IsoDate } from "../shared/contract.js";
import type {
  Baseline,
  CheckResult,
  ExtractedTender,
  FieldFill,
  GoldenRecord,
  ReadDiagnostics,
  ReadOutcome,
  Verdict,
} from "../shared/modules.js";
import { toEpoch } from "../shared/time.js";
import type { GoldenVerificationResult } from "./types.js";

const STRICT_REQUIRED_FIELDS = ["id", "url", "title"] as const;
const NULLABLE_REQUIRED_FIELDS = [
  "buyerName",
  "publicationDate",
  "submissionDeadline",
] as const;
const REQUIRED_FIELDS = [...STRICT_REQUIRED_FIELDS, ...NULLABLE_REQUIRED_FIELDS] as const;

const GOLDEN_FIELDS = [
  "title",
  "buyerName",
  "publicationDate",
  "submissionDeadline",
  "referenceNumber",
  "url",
] as const;

const COUNT_DROP_RATIO = 0.5;
const COUNT_DROP_MIN_BASELINE = 6;
const BASELINE_FILL_MIN_SAMPLES = 3;
const BASELINE_FILL_HIGH_THRESHOLD = 0.8;
const CURRENT_FILL_COLLAPSE_THRESHOLD = 0.3;
const ISO_DATE_PREFIX_LENGTH = 10;
const MIN_FUZZY_TITLE_LENGTH = 8;
const CPV_CODE_PATTERN = /^\d{8}$/;

type RequiredField = (typeof REQUIRED_FIELDS)[number];

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeComparable(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return normalizeText(value);
}

function formatGoldenValue(value: string | null): string {
  return value === null ? "null" : `"${value}"`;
}

function compareGoldenFields(record: GoldenRecord, tender: ExtractedTender): string[] {
  const mismatches: string[] = [];
  for (const field of GOLDEN_FIELDS) {
    const rawExpected = record.fields[field];
    if (rawExpected === undefined) continue;

    const expected = normalizeComparable(rawExpected);
    const actual = normalizeComparable(tender[field]);
    if (expected !== actual) {
      mismatches.push(
        `Golden tender "${record.id}" field ${field} changed from ${formatGoldenValue(expected)} to ${formatGoldenValue(actual)}.`,
      );
    }
  }
  return mismatches;
}

function buildUniqueTenderLookup(
  tenders: ExtractedTender[],
  keyFn: (tender: ExtractedTender) => string | null,
): Map<string, ExtractedTender> {
  const seen = new Map<string, ExtractedTender | null>();
  for (const tender of tenders) {
    const key = keyFn(tender);
    if (!key) continue;
    seen.set(key, seen.has(key) ? null : tender);
  }
  const unique = new Map<string, ExtractedTender>();
  for (const [key, tender] of seen) {
    if (tender) unique.set(key, tender);
  }
  return unique;
}

function findFuzzyGoldenMatch(
  record: GoldenRecord,
  byUrl: Map<string, ExtractedTender>,
  byTitle: Map<string, ExtractedTender>,
): { tender: ExtractedTender; matchedBy: "url" | "title" } | null {
  const url = normalizeComparable(record.fields.url);
  if (url) {
    const byUrlMatch = byUrl.get(url);
    if (byUrlMatch && byUrlMatch.id !== record.id) {
      return { tender: byUrlMatch, matchedBy: "url" };
    }
  }
  const title = normalizeComparable(record.fields.title);
  if (title && title.length >= MIN_FUZZY_TITLE_LENGTH) {
    const byTitleMatch = byTitle.get(title);
    if (byTitleMatch && byTitleMatch.id !== record.id) {
      return { tender: byTitleMatch, matchedBy: "title" };
    }
  }
  return null;
}

function detectGoldenIdDrift(
  tenders: ExtractedTender[],
  golden: GoldenRecord[],
): GoldenVerificationResult {
  const byUrl = buildUniqueTenderLookup(tenders, (t) => normalizeComparable(t.url));
  const byTitle = buildUniqueTenderLookup(tenders, (t) => {
    const title = normalizeComparable(t.title);
    return title && title.length >= MIN_FUZZY_TITLE_LENGTH ? title : null;
  });

  let checked = 0;
  const mismatches: string[] = [];
  for (const record of golden) {
    const found = findFuzzyGoldenMatch(record, byUrl, byTitle);
    if (!found) continue;
    checked += 1;
    mismatches.push(
      `Golden tender "${record.id}" appears under a changed ID "${found.tender.id}" (matched by ${found.matchedBy}).`,
    );
  }
  return { checked, matched: 0, mismatches };
}

export function verifyGoldenRecords(
  tenders: ExtractedTender[],
  golden: GoldenRecord[],
): GoldenVerificationResult {
  const byId = new Map<string, ExtractedTender>();
  for (const tender of tenders) {
    if (tender.id) byId.set(tender.id, tender);
  }

  let checked = 0;
  let matched = 0;
  const mismatches: string[] = [];

  for (const record of golden) {
    const tender = byId.get(record.id);
    if (!tender) continue;

    checked += 1;
    const recordMismatches = compareGoldenFields(record, tender);
    if (recordMismatches.length === 0) {
      matched += 1;
    } else {
      mismatches.push(...recordMismatches);
    }
  }

  if (golden.length > 0 && checked === 0) {
    return detectGoldenIdDrift(tenders, golden);
  }

  return { checked, matched, mismatches };
}

function isValidIsoDate(value: string): boolean {
  if (!IsoDate.safeParse(value).success) return false;
  const parts = value.split("-").map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (year === undefined || month === undefined || day === undefined) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isValidDateTimeWithOffset(value: string): boolean {
  if (!DateTimeWithOffset.safeParse(value).success) return false;
  if (!isValidIsoDate(value.slice(0, ISO_DATE_PREFIX_LENGTH))) return false;
  return Number.isFinite(toEpoch(value));
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function computeFieldFill(tenders: ExtractedTender[], field: RequiredField): FieldFill {
  let filled = 0;
  for (const tender of tenders) {
    const value = tender[field];
    if (typeof value === "string" && value.trim().length > 0) {
      filled += 1;
    }
  }
  return { filled, total: tenders.length };
}

function formatPercent(fill: FieldFill): string {
  if (fill.total === 0) return "0%";
  return `${Math.round((fill.filled / fill.total) * 100)}%`;
}

function isStrictRequiredField(field: RequiredField): boolean {
  return (STRICT_REQUIRED_FIELDS as readonly string[]).includes(field);
}

function hadMeaningfulBaselineFill(previous: FieldFill | undefined): boolean {
  if (!previous) return false;
  return previous.filled >= 2 || (previous.total > 0 && previous.filled / previous.total >= 0.5);
}

function isBaselineFillCollapsed(current: FieldFill, previous: FieldFill | undefined): boolean {
  if (!previous) return false;
  if (previous.total < BASELINE_FILL_MIN_SAMPLES) return false;
  if (current.total < BASELINE_FILL_MIN_SAMPLES) return false;

  const previousRate = previous.filled / previous.total;
  const currentRate = current.filled / current.total;
  return previousRate >= BASELINE_FILL_HIGH_THRESHOLD && currentRate < CURRENT_FILL_COLLAPSE_THRESHOLD;
}

function checkItemCount(tenders: ExtractedTender[], diagnostics: ReadDiagnostics): CheckResult {
  if (tenders.length > 0) {
    return { name: "item-count", ok: true, detail: `Found ${tenders.length} tenders.` };
  }
  if (diagnostics.emptyStateText) {
    return {
      name: "item-count",
      ok: true,
      detail: `Portal says: "${diagnostics.emptyStateText}".`,
    };
  }
  return { name: "item-count", ok: false, detail: "No tenders found on the list." };
}

function checkCountDrop(
  tenders: ExtractedTender[],
  diagnostics: ReadDiagnostics,
  baseline: Baseline,
): CheckResult | null {
  if (baseline.lastGoodCount === null || baseline.lastGoodCount < COUNT_DROP_MIN_BASELINE) {
    return null;
  }
  if (diagnostics.emptyStateText) return null;

  const minimumExpected = baseline.lastGoodCount * COUNT_DROP_RATIO;
  if (tenders.length < minimumExpected) {
    return {
      name: "count-drop",
      ok: false,
      detail: `Tender count dropped from ${baseline.lastGoodCount} to ${tenders.length}.`,
    };
  }
  return {
    name: "count-drop",
    ok: true,
    detail: `Tender count (${tenders.length}) is consistent with baseline (${baseline.lastGoodCount}).`,
  };
}

function checkFieldFill(
  tenders: ExtractedTender[],
  diagnostics: ReadDiagnostics,
  baseline: Baseline,
): CheckResult[] {
  const results: CheckResult[] = [];
  for (const field of REQUIRED_FIELDS) {
    const current = diagnostics.fieldFill[field] ?? computeFieldFill(tenders, field);
    if (current.total === 0) continue;

    const previous = baseline.lastGoodFieldFill?.[field];
    if (current.filled === 0) {
      if (isStrictRequiredField(field) || hadMeaningfulBaselineFill(previous)) {
        results.push({
          name: `field-fill:${field}`,
          ok: false,
          detail: `No tender has a ${field}.`,
        });
      } else {
        results.push({
          name: `field-fill:${field}`,
          ok: true,
          detail: `Field ${field} not shown by portal (0/${current.total}).`,
        });
      }
      continue;
    }

    if (isBaselineFillCollapsed(current, previous) && previous) {
      results.push({
        name: `field-fill:${field}`,
        ok: false,
        detail: `Field ${field} fill dropped from ${formatPercent(previous)} to ${formatPercent(current)}.`,
      });
      continue;
    }

    results.push({
      name: `field-fill:${field}`,
      ok: true,
      detail: `Field ${field} filled on ${current.filled}/${current.total} tenders.`,
    });
  }
  return results;
}

function checkUniqueIds(tenders: ExtractedTender[]): CheckResult | null {
  if (tenders.length === 0) return null;

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let blankCount = 0;

  for (const tender of tenders) {
    const trimmed = tender.id.trim();
    if (trimmed.length === 0) {
      blankCount += 1;
      continue;
    }
    if (seen.has(trimmed)) {
      duplicates.add(trimmed);
    } else {
      seen.add(trimmed);
    }
  }

  if (blankCount > 0 || duplicates.size > 0) {
    const problems: string[] = [];
    if (blankCount > 0) problems.push(`${blankCount} tender(s) have a blank id.`);
    if (duplicates.size > 0) {
      problems.push(`Duplicate tender IDs found: ${[...duplicates].join(", ")}.`);
    }
    return { name: "unique-ids", ok: false, detail: problems.join(" ") };
  }

  return { name: "unique-ids", ok: true, detail: `All ${tenders.length} tender IDs are unique.` };
}

function checkValidUrls(tenders: ExtractedTender[]): CheckResult | null {
  if (tenders.length === 0) return null;

  let invalidTenderUrls = 0;
  let invalidDocUrls = 0;

  for (const tender of tenders) {
    if (!isHttpUrl(tender.url)) invalidTenderUrls += 1;
    for (const doc of tender.documentRefs) {
      if (!isHttpUrl(doc.url)) invalidDocUrls += 1;
    }
  }

  if (invalidTenderUrls > 0 || invalidDocUrls > 0) {
    const problems: string[] = [];
    if (invalidTenderUrls > 0) problems.push(`${invalidTenderUrls} invalid tender URL(s).`);
    if (invalidDocUrls > 0) problems.push(`${invalidDocUrls} invalid document URL(s).`);
    return { name: "valid-urls", ok: false, detail: problems.join(" ") };
  }

  return { name: "valid-urls", ok: true, detail: "All tender and document URLs are valid." };
}

function checkDatesAndDeadlines(tenders: ExtractedTender[]): CheckResult[] {
  if (tenders.length === 0) return [];

  let invalidDateCount = 0;
  let invertedDeadlineCount = 0;

  for (const tender of tenders) {
    const pubValid = tender.publicationDate === null || isValidIsoDate(tender.publicationDate);
    const deadlineValid =
      tender.submissionDeadline === null || isValidDateTimeWithOffset(tender.submissionDeadline);

    if (!pubValid || !deadlineValid) {
      invalidDateCount += 1;
      continue;
    }

    if (tender.publicationDate !== null && tender.submissionDeadline !== null) {
      const deadlineDate = tender.submissionDeadline.slice(0, ISO_DATE_PREFIX_LENGTH);
      if (deadlineDate < tender.publicationDate) {
        invertedDeadlineCount += 1;
      }
    }
  }

  return [
    invalidDateCount > 0
      ? {
          name: "dates",
          ok: false,
          detail: `${invalidDateCount} tender(s) have invalid publication dates or deadlines.`,
        }
      : { name: "dates", ok: true, detail: "All dates and deadlines are valid." },
    invertedDeadlineCount > 0
      ? {
          name: "deadline-order",
          ok: false,
          detail: `${invertedDeadlineCount} tender(s) have a submission deadline earlier than publication date.`,
        }
      : { name: "deadline-order", ok: true, detail: "All submission deadlines follow publication dates." },
  ];
}

function checkCpvCodes(tenders: ExtractedTender[]): CheckResult | null {
  let checkedCodes = 0;
  const invalidCodes: string[] = [];

  for (const tender of tenders) {
    if (!tender.cpvCodes) continue;
    for (const code of tender.cpvCodes) {
      checkedCodes += 1;
      if (!CPV_CODE_PATTERN.test(code)) {
        invalidCodes.push(code);
      }
    }
  }

  if (invalidCodes.length > 0) {
    return {
      name: "cpv-codes",
      ok: false,
      detail: `Invalid CPV code(s): ${invalidCodes.join(", ")}.`,
    };
  }
  if (checkedCodes > 0) {
    return { name: "cpv-codes", ok: true, detail: "All CPV codes are valid 8-digit codes." };
  }
  return null;
}

function checkGoldenRecords(
  tenders: ExtractedTender[],
  golden: GoldenRecord[],
): CheckResult | null {
  const result = verifyGoldenRecords(tenders, golden);
  if (result.mismatches.length > 0) {
    return { name: "golden-records", ok: false, detail: result.mismatches.join(" ") };
  }
  if (result.checked > 0) {
    return {
      name: "golden-records",
      ok: true,
      detail: `${result.matched} of ${result.checked} known tenders match.`,
    };
  }
  return null;
}

function checkSkeletonDrift(
  diagnostics: ReadDiagnostics,
  baseline: Baseline,
): CheckResult | null {
  if (!baseline.lastGoodSkeletonHash || !diagnostics.listSkeletonHash) return null;
  if (baseline.lastGoodSkeletonHash === diagnostics.listSkeletonHash) return null;

  return {
    name: "skeleton-drift",
    ok: true,
    detail: "List page structure changed (early warning).",
  };
}

function collectChecks(
  tenders: ExtractedTender[],
  diagnostics: ReadDiagnostics,
  baseline: Baseline,
): CheckResult[] {
  const checks: CheckResult[] = [checkItemCount(tenders, diagnostics)];
  const maybePush = (check: CheckResult | null) => {
    if (check) checks.push(check);
  };

  maybePush(checkCountDrop(tenders, diagnostics, baseline));
  checks.push(...checkFieldFill(tenders, diagnostics, baseline));
  maybePush(checkUniqueIds(tenders));
  maybePush(checkValidUrls(tenders));
  checks.push(...checkDatesAndDeadlines(tenders));
  maybePush(checkCpvCodes(tenders));
  maybePush(checkGoldenRecords(tenders, baseline.golden));
  maybePush(checkSkeletonDrift(diagnostics, baseline));

  return checks;
}

function buildHealthyReason(tenders: ExtractedTender[], diagnostics: ReadDiagnostics): string {
  if (tenders.length === 0 && diagnostics.emptyStateText) {
    return `Portal says: "${diagnostics.emptyStateText}".`;
  }
  return `Read ${tenders.length} tenders; all checks passed.`;
}

export function evaluateRead(read: ReadOutcome, baseline: Baseline): Verdict {
  if (read.kind === "blocked") {
    return { kind: "blocked", reason: read.reason };
  }
  if (read.kind === "unreachable") {
    return { kind: "unreachable", reason: read.reason };
  }
  if (read.kind === "error") {
    return { kind: "broken", reason: read.reason, checks: [] };
  }

  const checks = collectChecks(read.tenders, read.diagnostics, baseline);
  const failed = checks.filter((check) => !check.ok);

  if (failed.length > 0) {
    return {
      kind: "broken",
      reason: failed.map((check) => check.detail).join(" "),
      checks,
    };
  }

  return {
    kind: "healthy",
    reason: buildHealthyReason(read.tenders, read.diagnostics),
    checks,
  };
}
