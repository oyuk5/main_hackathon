/**
 * When may a tender that is missing from a read be marked closed? Owned by A.
 *
 * "No longer listed" only means "closed" when the read saw the whole list. A read that stopped at the
 * recipe's page cap, or was aborted halfway, did not see older tenders, so missing is not the same as
 * gone. Closing them anyway would serve a wrong status, and a wrong value is worse than a missing one.
 * Tenders whose deadline has passed are closed either way.
 */
import type { Recipe } from "../shared/recipe.js";

export function sawWholeList(pagination: Recipe["list"]["pagination"] | undefined, listPages: number, aborted: boolean): boolean {
  if (aborted) return false;
  if (!pagination || pagination.type === "none") return true;
  return listPages < pagination.maxPages;
}

export function mayClose(opts: { wholeList: boolean; submissionDeadline: string | null; now: number; toEpoch: (iso: string) => number }): boolean {
  if (opts.wholeList) return true;
  return opts.submissionDeadline !== null && opts.toEpoch(opts.submissionDeadline) < opts.now;
}
