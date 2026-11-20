/**
 * Lab demo portal "kommune" (DK): server-rendered table, ZIP with folders plus one PDF per tender.
 * PLACEHOLDER: being built by person D's agent. Keep the export name and slug.
 */
import { notFound, page, sendHtml, type LabPortal } from "./common.js";

export const kommune: LabPortal = {
  slug: "kommune",
  name: "Fjordby Kommune",
  country: "DK",
  timeZone: "Europe/Copenhagen",
  kind: "server-rendered table, ZIP with folders plus one PDF per tender",
  notes: [],
  tenders: [],
  variants: {},
  tenderUrl: (base, t) => `${base}/kommune/${t.id}`,
  handle(_req, res, path) {
    if (path === "/" || path === "") return sendHtml(res, page("Fjordby Kommune", "en", "<h1>Fjordby Kommune</h1><p>Coming soon.</p>"));
    notFound(res);
  },
};
