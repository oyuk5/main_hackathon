# A · Platform
_Updated: Fri 23:41 CET. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Judge walkthrough verified and pushed. Fresh clone `5907655`: build, 292/292 tests, Linux/amd64 Docker and 16/16 contract checks passed.
- Dashboard: 12 demo/live checks passed. README links three PNGs and separates B's 23:12 attach eval from D's 22:28 repair eval.
- Platform: `politeHttp.fetch` now honors the caller's deadline as well as job cancellation. Regression tests cover the host gate and a stalled response.

**Doing now**
- Live attach: 21 samples over 10 min (watcher restart at 23:32:21); both still integrating at cutoff. Platforma extracted 1,200 tenders at 23:41:13, then failed at 23:41:14 because robots.txt disallows `/file/get_new/…`; 0 tenders served.

**Needs from others**
- C: add `publishedDocumentCounts?` to `Baseline` (modules.ts) and reject unsafe candidates in Medic so it retries.
- B: TenderNed `src/attach/index.ts:attachKnown` awaits `extractor.read`: 23:32:21 “using its checked recipe without a model call”; prior run read 2,636 tenders at 23:30:12, ~12 min after start. `src/attach/extractor.ts:run` does sequential detail/document requests; please expose progress and consider staged enrichment.
- B: Platforma `src/attach/cartographer.ts:attachWithModel` logged “The draft read cleanly; reading the whole list once.” at 23:34:59, then awaited `deps.read`; investigate the full-read cost, not a stuck model call.
