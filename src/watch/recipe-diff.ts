import type { Recipe } from "../shared/recipe.js";
import type { GoldenVerificationResult } from "./types.js";

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`).join(",")}}`;
}

function countChangedRecordKeys<T>(
  before: Record<string, T>,
  after: Record<string, T>,
): number {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let changed = 0;
  for (const key of keys) {
    if (stableSerialize(before[key]) !== stableSerialize(after[key])) {
      changed += 1;
    }
  }
  return changed;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function collectRecipeChangeParts(before: Recipe, after: Recipe): string[] {
  const parts: string[] = [];
  if (before.tier !== after.tier) parts.push(`tier (${before.tier} to ${after.tier})`);
  if (before.list.request.url !== after.list.request.url) parts.push("list URL");
  if (before.list.item !== after.list.item) parts.push("list selector");
  if (
    before.list.pagination.type !== after.list.pagination.type ||
    stableSerialize(before.list.pagination) !== stableSerialize(after.list.pagination)
  ) {
    parts.push("pagination");
  }
  const listFieldsChanged = countChangedRecordKeys(before.listFields, after.listFields);
  if (listFieldsChanged > 0) parts.push(pluralize(listFieldsChanged, "field rule"));
  const detailFieldsChanged = countChangedRecordKeys(
    before.detail?.fields ?? {},
    after.detail?.fields ?? {},
  );
  if (detailFieldsChanged > 0) parts.push(pluralize(detailFieldsChanged, "detail field rule"));
  if (stableSerialize(before.documents) !== stableSerialize(after.documents)) {
    parts.push("document rules");
  }
  return parts;
}

export function summarizeRecipeChanges(before: Recipe, after: Recipe): string {
  const parts = collectRecipeChangeParts(before, after);
  if (parts.length === 0) return "no recipe changes";
  return `updated ${formatList(parts)}`;
}

function normalizeClause(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
}

function formatGoldenClause(golden: GoldenVerificationResult): string | null {
  if (golden.checked === 0) return null;
  const noun = golden.checked === 1 ? "known tender matches" : "known tenders match";
  return `${golden.matched} of ${golden.checked} ${noun}`;
}

function capitalize(text: string): string {
  if (text.length === 0) return text;
  return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

export function buildRepairSummary(params: {
  llmNote: string;
  before: Recipe;
  after: Recipe;
  golden: GoldenVerificationResult;
}): string {
  const clauses: string[] = [];
  const note = normalizeClause(params.llmNote);
  if (note.length > 0) clauses.push(note);

  const diff = summarizeRecipeChanges(params.before, params.after);
  if (diff !== "no recipe changes" || clauses.length === 0) {
    clauses.push(diff === "no recipe changes" ? "verified existing recipe" : diff);
  }

  const goldenClause = formatGoldenClause(params.golden);
  if (goldenClause !== null) clauses.push(goldenClause);

  return `${capitalize(clauses.join("; "))}.`;
}
