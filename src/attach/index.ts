/**
 * Attach module. Owned by B.
 * The orchestrator imports exactly `extractor` and `cartographer`.
 */
import type { AttachOutcome, Cartographer, ExtractedTender, GoldenRecord, PortalContext, ReadOutcome } from "../shared/modules.js";
import type { Recipe } from "../shared/recipe.js";
import { extractor } from "./extractor.js";
import { findKnownRecipe, type KnownRecipe } from "./known.js";

export { extractor } from "./extractor.js";

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

/** Runs a known recipe and turns the read into an attach outcome. Never calls the model. */
export async function attachKnown(known: KnownRecipe, ctx: PortalContext, read: (r: Recipe, c: PortalContext) => Promise<ReadOutcome> = (r, c) => extractor.read(r, c)): Promise<AttachOutcome> {
  ctx.log(`This is ${known.name}, a portal we know: using its checked recipe without a model call.`);
  const recipe = structuredClone(known.recipe);
  const out = await read(recipe, ctx);
  switch (out.kind) {
    case "ok": {
      if (out.tenders.length === 0) {
        return { kind: "failed", reason: `The known ${known.name} recipe read no tenders, so it cannot be trusted for this portal.` };
      }
      const golden = pickGolden(out.tenders);
      ctx.log(`Read ${out.tenders.length} tenders with the known recipe; kept ${golden.length} as golden records.`);
      return { kind: "ok", recipe, golden, read: out, note: `Used the known ${known.name} recipe; no model call.` };
    }
    case "blocked":
      return { kind: "blocked", reason: out.reason };
    case "unreachable":
      return { kind: "failed", reason: `Could not reach ${known.name}: ${out.reason}` };
    case "error":
      return { kind: "failed", reason: `The known ${known.name} recipe failed: ${out.reason}` };
  }
}

export const NOT_KNOWN_REASON = "Cannot attach this portal yet: it is not a known portal and the model-based Cartographer is not built yet.";

export const cartographer: Cartographer = {
  async attach(ctx) {
    ctx.log("Looking at the portal for the first time.");
    const known = findKnownRecipe(ctx.url);
    if (known) return attachKnown(known, ctx);
    return { kind: "failed", reason: NOT_KNOWN_REASON };
  },
};
