/** Golden records: known values that prove a recipe still reads correctly. Owned by B. */
import type { ExtractedTender, GoldenRecord } from "../shared/modules.js";

const GOLDEN_FIELDS = ["title", "buyerName", "publicationDate", "submissionDeadline", "referenceNumber", "url"] as const;

/** Picks 3 to 5 tenders with the most golden fields filled. Only non-null fields are kept. */
export function pickGolden(tenders: ExtractedTender[], max = 5): GoldenRecord[] {
  const scored = tenders.map((t, i) => {
    const fields: GoldenRecord["fields"] = {};
    for (const f of GOLDEN_FIELDS) {
      const v = t[f];
      if (v !== null && v !== undefined && v !== "") (fields as Record<string, unknown>)[f] = v;
    }
    return { id: t.id, fields, score: Object.keys(fields).length, i };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored
    .filter((s) => s.score > 0)
    .slice(0, max)
    .map(({ id, fields }) => ({ id, fields }));
}
