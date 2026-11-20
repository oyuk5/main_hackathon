/**
 * Lab demo portal "polder" (NL): RSS/Atom feed with HTML detail pages.
 * PLACEHOLDER: being built by person D's agent. Keep the export name and slug.
 */
import { notFound, page, sendHtml, type LabPortal } from "./common.js";

export const polder: LabPortal = {
  slug: "polder",
  name: "Gemeente Polderwijk",
  country: "NL",
  timeZone: "Europe/Amsterdam",
  kind: "RSS/Atom feed with HTML detail pages",
  notes: [],
  tenders: [],
  variants: {},
  tenderUrl: (base, t) => `${base}/polder/${t.id}`,
  handle(_req, res, path) {
    if (path === "/" || path === "") return sendHtml(res, page("Gemeente Polderwijk", "en", "<h1>Gemeente Polderwijk</h1><p>Coming soon.</p>"));
    notFound(res);
  },
};
