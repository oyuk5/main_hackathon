# A · Platform
_Updated: Sat 00:00 CET. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Judge walkthrough verified and pushed. Fresh clone `5907655`: build, 292/292 tests, Linux/amd64 Docker and 16/16 contract checks passed.
- Optional operator sign-in is off by default, scoped to `/internal/*`; Linux/amd64 Docker passed 16/16 contract checks and Playwright saw no Clerk requests at 375/1440 px. Enabled access tested with mocks.
- Added cached-token ledger migration and pricing docs; both demo entrypoints leave the worker off and reject new registrations.

**Doing now**
- Live attach: 21 samples over 10 min (watcher restart at 23:32:21); both still integrating at cutoff. Platforma extracted 1,200 tenders at 23:41:13, then failed at 23:41:14 because robots.txt disallows `/file/get_new/…`; 0 tenders served.

**Needs from others**
- C: add `publishedDocumentCounts?` to `Baseline` (modules.ts) and reject unsafe candidates in Medic so it retries.
- B: TenderNed `src/attach/index.ts:attachKnown` awaits `extractor.read`: 23:32:21 “using its checked recipe without a model call”; prior run read 2,636 tenders at 23:30:12, ~12 min after start. `src/attach/extractor.ts:run` does sequential detail/document requests; please expose progress and consider staged enrichment.
- B: pass `cachedTokens` to `store.addLlmCall` from `src/llm/client.ts` (existing TODO); the migrated ledger reports nonzero values.
