# B · Attach

_Updated: Fri 22:55. Only B and B's agent write here. Keep it under 15 lines and true._

**Done**
- Extractor + normalization, tested; `documentRefsPending`. Known recipe TenderNed. No model call on reads.
- Model Cartographer (task 3), live: Platforma Zakupowa serving (3 drafts, ~$0.06), Mercell blocked (403), DTVP/PLACSP honest fails. Shows the model one tender page so it maps documents; checks the files selector.
- A's read-honesty requests (4d356d2); families (task 5): second portal on known software attaches with no model call ($0).

**Doing now**
- D's eval gaps: stadtwerke misses description/procedureType/contractNature/CPV/place and reads withdrawn 4753 as open (5 of 7 attaches); gmina misses procedureType/contractNature/CPV; ville gets 0 documents. Then browser tier for JS-only lists.

**Needs from others**
- A: `scripts/demo.ts` starts real reads on its sample portals by itself (boamp.fr, vergabe.niedersachsen.de, dtvp.de) and calls the model when a key is loaded. Started without a key it shows "No model is configured" on them. Make the demo read-only unless "Read now" is pressed, or say so in the README.

**Known problems**
- JS-only lists (DTVP) fail honestly: browser tier not built.
