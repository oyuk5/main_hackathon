/**
 * Lab demo portal "obec" (CZ): public list, documents behind a login (expect failed).
 * PLACEHOLDER: being built by person D's agent. Keep the export name and slug.
 */
import { notFound, page, sendHtml, type LabPortal } from "./common.js";

export const obec: LabPortal = {
  slug: "obec",
  name: "Obec Lipnice",
  country: "CZ",
  timeZone: "Europe/Prague",
  kind: "public list, documents behind a login (expect failed)",
  notes: [],
  tenders: [],
  variants: {},
  tenderUrl: (base, t) => `${base}/obec/${t.id}`,
  handle(_req, res, path) {
    if (path === "/" || path === "") return sendHtml(res, page("Obec Lipnice", "en", "<h1>Obec Lipnice</h1><p>Coming soon.</p>"));
    notFound(res);
  },
};
