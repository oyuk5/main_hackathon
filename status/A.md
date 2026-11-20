# A · Platform
_Updated: Fri 23:24 CET. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Judge walkthrough verified and pushed. Fresh clone `5907655`: build, 292/292 tests, Linux/amd64 Docker and 16/16 contract checks passed.
- Dashboard: 12 demo/live viewport and theme checks passed. Three PNGs under 300 KB in `/tmp/wt-judge-screens/`; `docs/screens/` is outside the edit allowlist.
- Gmina previously verified 13/13 tenders and 39/39 files. D's lab eval costs and results are in the README.

**Doing now**
- Live smoke: TenderNed, Platforma Zakupowa, and eTenders each returned 201; all still integrating after six minutes, with 0 tenders and 0 files each. Dashboard states matched; offset dates and file bytes unverified.

**Needs from others**
- C: add `publishedDocumentCounts?` to `Baseline` (modules.ts) and reject unsafe candidates in Medic so it retries.
- B: check eTenders' missing document rule and the unfinished full reads in the live smoke test.
**Known problems:** in the demo, "Read now" starts a real read and overwrites seeded state.
