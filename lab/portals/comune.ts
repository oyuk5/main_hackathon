/**
 * Lab demo portal "comune" (IT): JSON API searched with POST, cursor pagination, two-hop documents.
 * PLACEHOLDER: being built by person D's agent. Keep the export name and slug.
 */
import { notFound, page, sendHtml, type LabPortal } from "./common.js";

export const comune: LabPortal = {
  slug: "comune",
  name: "Comune di Valdoria",
  country: "IT",
  timeZone: "Europe/Rome",
  kind: "JSON API searched with POST, cursor pagination, two-hop documents",
  notes: [],
  tenders: [],
  variants: {},
  tenderUrl: (base, t) => `${base}/comune/${t.id}`,
  handle(_req, res, path) {
    if (path === "/" || path === "") return sendHtml(res, page("Comune di Valdoria", "en", "<h1>Comune di Valdoria</h1><p>Coming soon.</p>"));
    notFound(res);
  },
};
