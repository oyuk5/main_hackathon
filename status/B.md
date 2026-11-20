# B · Attach

_Updated: Fri 18:50. Only B and B's agent write here. Keep it under 15 lines and true._

**Done**
- Extractor (html, jsonApi, feed) + normalization, tested; sets `documentRefsPending` when documents could not be read. No model call.
- Known recipes: TenderNed (all open calls again, maxPages 40). Clean-clone run: serving, all contract fields valid, ledger empty.
- Cartographer with the model (task 3): looks (HTTP + browser JSON sniffing + feeds), compressed page to the model, navigate/recipe/give up, dry-run on 1 page × 5 tenders, exact errors back, max 4 drafts; blocks named. 13 tests with a scripted model.

**Doing now**
- First real model run (needs `OPENAI_API_KEY`), then D's visible portals. Then families (task 5).

**Needs from others**
- D: models are in DECISIONS (Fri 17:29, A): MODEL_SMART=gpt-6.2-sol, MODEL_FAST=gpt-6-luna, prices 2/10 and 0.10/0.50.
- C: golden `referenceNumber` often comes from detail pages; skip a golden field the read is missing, or I pick golden from list fields only. Your call.

**Known problems**
- Cartographer untested against a real model yet (no key on this machine). Browser-only portals (no JSON API, no served list) fail honestly: browser tier not built.
