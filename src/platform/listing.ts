/**
 * When may a tender that is missing from a read be marked closed? Owned by A.
 *
 * "No longer listed" only means "closed" when the read saw the whole list. A read that stopped at the
 * recipe's page cap, or was aborted halfway, did not see older tenders, so missing is not the same as
 * gone. Closing them anyway would serve a wrong status, and a wrong value is worse than a missing one.
 * Tenders whose deadline has passed are closed either way.
 *
 * A read can also see "the whole list" of a window: a recipe filtered to recent tenders, or a portal
 * that only lists the last weeks. A missing tender published before the oldest tender this read saw
 * may simply be outside that window, so it is not closed on absence alone either.
 */
import { MAX_LIST_PAGES, type Recipe } from "../shared/recipe.js";

export function sawWholeList(pagination: Recipe["list"]["pagination"] | undefined, listPages: number, aborted: boolean): boolean {
  if (aborted) return false;
  if (!pagination || pagination.type === "none") return true;
  // The Extractor never reads past MAX_LIST_PAGES, whatever the recipe asks: a read that reached it is capped.
  return listPages < Math.min(pagination.maxPages, MAX_LIST_PAGES);
}

export function mayClose(opts: {
  wholeList: boolean;
  submissionDeadline: string | null;
  now: number;
  toEpoch: (iso: string) => number;
  /** YYYY-MM-DD of the missing tender, if known. */
  publicationDate?: string | null;
  /** YYYY-MM-DD of the oldest tender this read saw, if any had one. */
  oldestSeen?: string | null;
}): boolean {
  const olderThanRead = !!opts.publicationDate && !!opts.oldestSeen && opts.publicationDate < opts.oldestSeen;
  if (opts.wholeList && !olderThanRead) return true;
  return opts.submissionDeadline !== null && opts.toEpoch(opts.submissionDeadline) < opts.now;
}
