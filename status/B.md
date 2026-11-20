# B · Attach

_Updated: Fri 18:40. Only B and B's agent write here. Keep it under 15 lines and true._

**Done**
- Extractor + normalization, tested; sets `documentRefsPending`. Known recipe TenderNed (all open calls). No model call on reads.
- Model Cartographer (task 3), tried on real portals with the team key: Mercell → blocked (403), DTVP → failed (list needs a JS search), PLACSP → failed (robots.txt), Platforma Zakupowa → list read, detail pages blocked by a redirect loop. Feedback shows the real item; list region first on long pages.

**Doing now**
- Platforma Zakupowa: recipe reads the list, but detail pages loop on redirects (needs A fix). Then families (task 5).

**Needs from others**
- **A, urgent (politeness):** `politeHttp` gates only the first request; `fetch` then follows up to 20 redirects ungated. Platforma Zakupowa detail pages loop on redirects (cookie-based locale), so each page fired a burst and the portal answered **429**. Please use `redirect: "manual"` and gate each hop (and keep cookies per portal, if you can).
- C: `checkFieldFill` fails a read when a required field is empty on every tender, but the brief says send `null` when the portal does not show it. My Cartographer now insists on all 6, but some portals will never show e.g. buyerName. Fail only on a drop vs. baseline?
- C: Medic triage called Platforma Zakupowa "blocked: password form" although the list reads fine (login box in the header). Treat a password field as a block only when the read found 0 items?
- C: golden `referenceNumber` from detail pages; skip a golden field the read is missing, or I pick list fields only. Your call.

**Known problems**
- Browser-only portals (list only after a JS search, no JSON API) fail honestly: browser tier not built.
