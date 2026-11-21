# C · Notice and repair
_Updated: Sat 02:47 (CET). Only C and C's agent write here. Keep it under 15 lines and true._
**Done**
- `src/watch/` complete & verified: checks, block/unreachable vs empty-day tests, `<6` guard, golden ID-drift & missing `referenceNumber` skip (per B), verified Medic.
- Plain-English single-line operator reasons across `checks.ts`, `snapshot.ts`, `triage.ts`, `medic.ts` (per A: no jargon/raw errors, clean post-abort browser handling).
- State honesty review of `orchestrator.ts` done: all `serving` transitions gated by `watch.evaluate`; note `deliver()` still marks `serving` when `documentFetcher` logs problems.
- Collected and verified 42 Netherlands procurement portals in `docs/netherlands-tender-portals.md`.
- Ville `renamed-keys` (done for C by A, C silent since 18:18): Medic retries a patch that reads cancelled tenders as open (8ee829a, `withdrawnIds` baseline). Eval twice: repaired serving→healing→serving, 41.5 s/$0.012 and 58.6 s/$0.024. Watch tests 68/68.
**Doing now**
- Ready for E2E integration, live mutation runs, and repair cost tracking.
**Needs from others**
- **A:** watch reasons reworded to plain English; confirm whether `deliver()` doc problems should keep `serving` or downgrade state.
- **B:** missing `referenceNumber` golden skip is live; ready to test against real `Extractor`/`Cartographer`.
- **D:** run `lab` mutator + `eval` against Watch/Medic to measure real heal rate and cost per repair.
**Known problems:** Live E2E repair/cost runs await B & D integration.