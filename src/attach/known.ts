/**
 * Known portals: recipes we wrote and checked by hand, bundled with the code.
 * An interim step towards task 5 (families): a known portal attaches with no model call.
 */
import { Recipe } from "../shared/recipe.js";
import tenderned from "./recipes/tenderned.json" with { type: "json" };

export interface KnownMatch {
  /** Hostname without "www.", compared case-insensitively. */
  host: string;
  /** Optional path prefix, e.g. "/aankondigingen". Empty or missing matches every path. */
  pathPrefix?: string;
}

export interface KnownRecipe {
  name: string;
  match: KnownMatch;
  recipe: Recipe;
}

const registry: KnownRecipe[] = [
  { name: "TenderNed", match: { host: "tenderned.nl" }, recipe: Recipe.parse(tenderned) },
];

/** For tests: adds a recipe to the registry. Later entries win over earlier ones. */
export function registerKnownRecipe(name: string, match: KnownMatch, recipe: unknown): void {
  registry.unshift({ name, match, recipe: Recipe.parse(recipe) });
}

function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Finds a bundled recipe for this address, or null. */
export function findKnownRecipe(url: string, list: readonly KnownRecipe[] = registry): KnownRecipe | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = bareHost(u.hostname);
  for (const k of list) {
    if (bareHost(k.match.host) !== host) continue;
    const prefix = k.match.pathPrefix ?? "";
    if (prefix && !u.pathname.startsWith(prefix)) continue;
    return k;
  }
  return null;
}
