/**
 * Attach module. Owned by B.
 * The orchestrator imports exactly `extractor` and `cartographer`.
 */
import type { AttachOutcome, Cartographer, PortalContext, ReadOutcome } from "../shared/modules.js";
import type { Recipe } from "../shared/recipe.js";
import { extractor, readSample } from "./extractor.js";
import { attachWithModel } from "./cartographer.js";
import { attachFromFamily, familyStore, fingerprint, firstPage, rememberFamily, type FamilyStore } from "./families.js";
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
      // Staged enrichment: tenders past this read's detail budget are served from the next reads.
      const waiting = out.tenders.filter((t) => t.documentRefsPending).length;
      ctx.log(`Read ${out.tenders.length} tenders with the known recipe; kept ${golden.length} as golden records.${waiting ? ` ${waiting} wait for their detail pages; they follow in the next reads.` : ""}`);
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

export interface AttachDeps {
  store: () => FamilyStore;
  model: (ctx: PortalContext) => Promise<AttachOutcome>;
  sample: (r: Recipe, c: PortalContext) => Promise<ReadOutcome>;
  read: (r: Recipe, c: PortalContext) => Promise<ReadOutcome>;
}

const defaultDeps: AttachDeps = {
  store: familyStore,
  model: (ctx) => attachWithModel(ctx),
  sample: (r, c) => readSample(r, c),
  read: (r, c) => extractor.read(r, c),
};

/**
 * Attach order: a known recipe for this exact host, then the recipe of the portal's software family
 * (no model call), then the model Cartographer. A model-learned recipe becomes the family's template.
 */
export async function attachPortal(ctx: PortalContext, deps: AttachDeps = defaultDeps): Promise<AttachOutcome> {
  ctx.log("Looking at the portal for the first time.");
  const known = findKnownRecipe(ctx.url);
  if (known) return attachKnown(known, ctx, deps.read);

  let page;
  try {
    page = await firstPage(ctx);
  } catch {
    return { kind: "failed", reason: "The attach was cancelled." };
  }
  const family = fingerprint(page) ?? fingerprint({ url: ctx.url, html: "" });
  if (family) {
    const template = deps.store().load(family.id);
    if (template) {
      const out = await attachFromFamily(ctx, family, template, page.url, deps);
      if (out.kind !== "miss") return out;
      ctx.log(`The ${family.name} family recipe does not fit this portal (${out.reason}); asking the model instead.`, "warn");
    } else {
      ctx.log(`This portal runs ${family.name}; no family recipe yet, so the model learns it.`);
    }
  }

  const out = await deps.model(ctx);
  if (out.kind !== "ok") return out;
  const fam = family ?? fingerprint({ url: out.recipe.list.request.url, html: "" });
  if (fam) {
    out.recipe.family = fam.id;
    // A template whose documents rule found nothing would hand the next portal tenders without files.
    if (out.read.tenders.some((t) => t.documentRefs.length > 0)) rememberFamily(deps.store(), fam, out.recipe, [page.url, ctx.url], ctx.log);
    else ctx.log(`Not keeping this recipe for the ${fam.name} family: it found no document links, so it is not complete enough to reuse.`);
  }
  return out;
}

export const cartographer: Cartographer = {
  attach: (ctx) => attachPortal(ctx),
};
