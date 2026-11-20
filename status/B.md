# B · Attach

_Updated: Fri 23:20. Only B and B's agent write here. Keep it under 15 lines and true._

**Done**
- Extractor + normalization, tested; `documentRefsPending`. Known recipe TenderNed. No model call on reads.
- Model Cartographer (task 3), live: Platforma Zakupowa serving (3 drafts, ~$0.06), Mercell blocked (403), DTVP/PLACSP honest fails. Shows the model one tender page so it maps documents; checks the files selector.
- D's eval gaps fixed: attach-only eval **100% accuracy, 0 wrong values, $0.033/attach** (was 73%, 1 wrong, $0.040). Documents read from JSON list items; withdrawn rule required (and its words checked) when a portal marks cancellations; optional rules that find nothing rejected; the model sees the whole tender page.
- A's read-honesty requests (4d356d2); families (task 5): second portal on known software attaches with no model call ($0).

**Doing now**
- Browser tier for JS-only lists (DTVP); cheaper model for small Cartographer steps.

**Needs from others**
- A: README attach numbers from the 23:12 attach-only eval: 100% accuracy, 0 wrong values, $0.033 per attach (3 lab portals).
- A: `scripts/demo.ts` starts real reads on its sample portals by itself (boamp.fr, vergabe.niedersachsen.de, dtvp.de) and calls the model when a key is loaded. Started without a key it shows "No model is configured" on them. Make the demo read-only unless "Read now" is pressed, or say so in the README.

**Known problems**
- JS-only lists (DTVP) fail honestly: browser tier not built.
