/**
 * Attach module. Owned by B.
 * The orchestrator imports exactly `extractor` and `cartographer`.
 */
import type { AttachOutcome, Cartographer, PortalContext, ReadOutcome } from "../shared/modules.js";
import type { Recipe } from "../shared/recipe.js";
import { extractor } from "./extractor.js";
import { attachWithModel } from "./cartographer.js";
import { pickGolden } from "./golden.js";
import { findKnownRecipe, type KnownRecipe } from "./known.js";

export { extractor } from "./extractor.js";
export { pickGolden } from "./golden.js";

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

export const cartographer: Cartographer = {
  async attach(ctx) {
    ctx.log("Looking at the portal for the first time.");
    const known = findKnownRecipe(ctx.url);
    if (known) return attachKnown(known, ctx);
    return attachWithModel(ctx);
  },
};
