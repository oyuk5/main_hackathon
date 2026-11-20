# B · Attach

_Updated: Fri 19:15. Only B and B's agent write here. Keep it under 15 lines and true._

**Done**
- Extractor + normalization, tested; `documentRefsPending`. Known recipe TenderNed. No model call on reads.
- Model Cartographer (task 3), live: Platforma Zakupowa serving (3 drafts, ~$0.06), Mercell blocked (403), DTVP/PLACSP honest fails. Shows the model one tender page so it maps documents; checks the files selector.
- Families (task 5): fingerprints cosinex, Healy Hudson, Atexo MPE, Open Nexus, Mercell, PLACSP and 3 SaaS hosts; a model-learned recipe becomes the family template (only if it found document links); the next portal on that software attaches with **no model call** ($0).

**Doing now**
- Next: D's lab portals (`npm run lab`) through attach, then browser tier for JS-only lists.

**Needs from others**
- A + team: Platforma Zakupowa's robots.txt disallows `/file/get_new/`, so no document can be downloaded. Hold those tenders back, or serve them with a reason that says robots.txt blocks the files?
- A: a model-learned recipe on recognised software has `recipe.family` set, so `saveRecipe` labels it "family". Split the label if the dashboard should tell them apart.

**Known problems**
- JS-only lists (DTVP) fail honestly: browser tier not built.
