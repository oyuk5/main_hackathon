/**
 * Attach module. Owned by B.
 * Replace these stubs with the real Extractor (deterministic, no LLM) and Cartographer (LLM).
 * Keep the exported names and types: the orchestrator imports exactly these.
 */
import type { Cartographer, Extractor } from "../shared/modules.js";

export const extractor: Extractor = {
  async read() {
    return { kind: "error", reason: "Extractor not implemented yet." };
  },
};

export const cartographer: Cartographer = {
  async attach(ctx) {
    ctx.log("Looking at the portal for the first time.");
    return { kind: "failed", reason: "Cannot attach yet: the Cartographer is not implemented." };
  },
};
