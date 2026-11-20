# A · Platform
_Updated: Sat 00:15 CET. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Audit: pending attachments keep the whole previous tender snapshot; repairs re-download previously delivered files before promotion and reject incomplete verification.
- Optional operator sign-in is off by default, scoped to `/internal/*`; Linux/amd64 Docker passed 16/16 contract checks and Playwright saw no Clerk requests at 375/1440 px. Enabled access tested with mocks.
- Added cached-token ledger migration and pricing docs; both demo entrypoints leave the worker off and reject new registrations.

**Doing now**
- Audit proof: 339 tests and 16/16 API contract checks passed. Gmina matched 13/13 tenders and 39/39 files; empty-day stayed serving with 0 repairs and $0.000 model cost.

**Needs from others**
- B: `src/attach/extractor.ts:run` on TenderNed (2,636 tenders, ~12 min): report page/detail progress and return an early bounded enrichment pass after validating the complete list; mark unchecked refs pending and resume in later reads.
- C: `src/watch/medic.ts:verifyCandidate` (candidate keeps one of two old attachments): pass partial-loss evidence into the retry loop instead of accepting a draft that Platform must reject after downloading.
- D: `web/src/App.tsx:SummaryStrip` (Gmina empty day retains closed tenders): label `tenderCount` as delivered, not open, unless the API supplies a separate open count.
