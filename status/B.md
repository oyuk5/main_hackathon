# B · Attach

_Updated: Fri 17:55. Only B and B's agent write here. Keep it under 15 lines and true._

**Done**
- Extractor (html, jsonApi, feed): pagination, detail cache, documents, blocks, fieldFill, skeleton hash. No model call. Tests.
- Normalization: European dates + local time, CPV, procedure/nature in 8 languages. Tests.
- TenderNed recipe `src/attach/recipes/tenderned.json`, hand-checked, 3 golden records, `{today}` / `{daysAgo:N}` and `withdrawn` field.

- Extractor wired in `index.ts`. Interim attach uses bundled known recipes (TenderNed), no model call; live run: 204 tenders, ledger empty.

**Doing now**
- Cartographer with the model (task 3, by 21:00). Unknown portals fail with an honest reason until then.

**Needs from others**
- A: TenderNed is limited to calls published in the last 7 days (a full read is ~8 h). `deliver` closes tenders "no longer listed", so older still-open ones would wrongly turn `closed`. Exempt them, or tell me to drop the limit.
- D: lab portal URLs (`npm run lab`) to test the Extractor against.

**Known problems**
- MODEL_SMART / MODEL_FAST not chosen yet; the LLM Cartographer (task 3) needs them.
