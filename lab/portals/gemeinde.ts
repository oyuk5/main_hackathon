/**
 * Lab demo portal "gemeinde" (AT): JavaScript-only list with a load-more button (browser tier).
 * PLACEHOLDER: being built by person D's agent. Keep the export name and slug.
 */
import { notFound, page, sendHtml, type LabPortal } from "./common.js";

export const gemeinde: LabPortal = {
  slug: "gemeinde",
  name: "Marktgemeinde Almbach",
  country: "AT",
  timeZone: "Europe/Vienna",
  kind: "JavaScript-only list with a load-more button (browser tier)",
  notes: [],
  tenders: [],
  variants: {},
  tenderUrl: (base, t) => `${base}/gemeinde/${t.id}`,
  handle(_req, res, path) {
    if (path === "/" || path === "") return sendHtml(res, page("Marktgemeinde Almbach", "en", "<h1>Marktgemeinde Almbach</h1><p>Coming soon.</p>"));
    notFound(res);
  },
};
