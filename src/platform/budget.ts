/**
 * Document budget per read. Owned by A.
 *
 * A big portal can list thousands of tenders, each with several files. At 1 request per second the
 * first read would take hours, with the portal stuck in `integrating`. So each read fetches documents
 * for at most `budget` document refs, most useful first, and the rest wait for the next read
 * (scheduled soon while anything is pending).
 *
 * A new tender is served only once its documents are fetched: an empty document list would say
 * "this tender has no documents", which is a wrong value. A known tender whose refs changed, or whose
 * last fetch had problems, keeps serving its last documents until it gets its turn.
 */

export type Need = "none" | "new" | "changed" | "retry";

export type PlanItem = {
  id: string;
  need: Need;
  refs: number;
  open: boolean;
  /** YYYY-MM-DD or null; newer first. */
  publicationDate: string | null;
};

const ORDER: Record<Exclude<Need, "none">, number> = { new: 0, changed: 1, retry: 3 };

function rank(item: PlanItem): number {
  if (item.need === "none") return -1;
  // New closed or withdrawn tenders come after open changes, before retries.
  if (item.need === "new" && !item.open) return 2;
  return ORDER[item.need];
}

/**
 * Picks which tenders get their documents fetched in this read.
 * At least one tender is always fetched when any need it, so a tender with more refs than the
 * budget still makes progress.
 */
export function planDocuments(items: PlanItem[], budget: number): { fetch: Set<string>; pendingNew: number } {
  const candidates = items
    .filter((i) => i.need !== "none")
    .sort((a, b) => rank(a) - rank(b) || (b.publicationDate ?? "").localeCompare(a.publicationDate ?? ""));
  const fetch = new Set<string>();
  let left = budget;
  for (const item of candidates) {
    const cost = item.refs; // a tender without documents costs nothing and is always served
    if (cost > 0 && cost > left && fetch.size > 0) continue;
    fetch.add(item.id);
    left -= cost;
  }
  const pendingNew = candidates.filter((i) => i.need === "new" && !fetch.has(i.id)).length;
  return { fetch, pendingNew };
}
