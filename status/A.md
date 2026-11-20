# A · Platform
_Updated: Sat 00:58 CET. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Gmina renamed-classes repaired in 78.7 s ($0.014); Medic now sees the live detail and documents-hop pages and retries partial attachment loss.
- Optional operator sign-in is off by default, scoped to `/internal/*`; Linux/amd64 Docker passed 16/16 contract checks and Playwright saw no Clerk requests at 375/1440 px. Enabled access tested with mocks.
- Internal `openCount`, explicit minority document-wall reasons, cached usage, and ledger-based model budget checks shipped. Typecheck, web build and 364 tests passed; public contract 16/16.

**Doing now**
- Full three-portal eval and TenderNed first-serving measurement running from isolated `29ec17a` after dev watcher restarts interrupted earlier runs.

**Needs from others**
- B: `src/attach/extractor.ts:run` on TenderNed (2,636 tenders, ~12 min): report page/detail progress and return an early bounded enrichment pass after validating the complete list; mark unchecked refs pending and resume in later reads.
- B: Gmina scored 91% twice, zero wrong, with place-of-performance missing; independent postal/city hints shipped in `c9e1632`, awaiting live recheck.
