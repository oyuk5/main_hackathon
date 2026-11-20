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

export class ModelBudgetError extends Error {}

/** Reserve headroom synchronously so concurrent portals cannot all spend the same daily balance. */
export function modelBudget() {
  const active = new Set<{ id: string | null; day: string; usd: number }>();
  return (id: string | null, day: string, usd: number, spent: { portal: number; day: number }, limits: { portal: number; day: number }) => {
    const pending = [...active];
    const portalPending = pending.filter((r) => r.id === id).reduce((sum, r) => sum + r.usd, 0);
    const dayPending = pending.filter((r) => r.day === day).reduce((sum, r) => sum + r.usd, 0);
    const money = (value: number) => value.toFixed(2);
    if (id && (spent.portal >= limits.portal || spent.portal + portalPending + usd > limits.portal)) {
      throw new ModelBudgetError(`Model budget for this portal is used up ($${money(spent.portal)} of $${money(limits.portal)}); a person must raise it.`);
    }
    if (spent.day >= limits.day || spent.day + dayPending + usd > limits.day) {
      throw new ModelBudgetError(`Daily model budget is used up ($${money(spent.day)} of $${money(limits.day)}); a person must raise it.`);
    }
    const reservation = { id, day, usd };
    active.add(reservation);
    return () => { active.delete(reservation); };
  };
}

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
export function planDocuments(items: PlanItem[], budget: number): { fetch: Set<string>; pendingNew: number; pending: number } {
  const candidates = items
    .filter((i) => i.need !== "none")
    .sort((a, b) => rank(a) - rank(b) || (b.publicationDate ?? "").localeCompare(a.publicationDate ?? ""));
  const fetch = new Set<string>();
  let left = budget;
  let attemptedFiles = false;
  for (const item of candidates) {
    const cost = item.refs; // a tender without documents costs nothing and is always served
    if (cost > 0 && cost > left && attemptedFiles) continue;
    fetch.add(item.id);
    left -= cost;
    if (cost > 0) attemptedFiles = true;
  }
  const pendingNew = candidates.filter((i) => i.need === "new" && !fetch.has(i.id)).length;
  return { fetch, pendingNew, pending: candidates.length - fetch.size };
}
