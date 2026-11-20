# C · Notice and repair
_Updated: Fri 18:18 (CET). Only C and C's agent write here. Keep it under 15 lines and true._
**Done**
- `src/watch/` complete & verified: checks, block/unreachable vs empty-day tests, `<6` guard, golden ID-drift & missing `referenceNumber` skip (per B), verified Medic.
- Plain-English single-line operator reasons across `checks.ts`, `snapshot.ts`, `triage.ts`, `medic.ts` (per A: no jargon/raw errors, clean post-abort browser handling).
- State honesty review of `orchestrator.ts` done: all `serving` transitions gated by `watch.evaluate`; note `deliver()` still marks `serving` when `documentFetcher` logs problems.
- Collected and verified 42 Netherlands procurement portals in `docs/netherlands-tender-portals.md`.
**Doing now**
- Ready for E2E integration, live mutation runs, and repair cost tracking.
**Needs from others**
- **A:** watch reasons reworded to plain English; confirm whether `deliver()` doc problems should keep `serving` or downgrade state.
- **B:** missing `referenceNumber` golden skip is live; ready to test against real `Extractor`/`Cartographer`.
- **D:** run `lab` mutator + `eval` against Watch/Medic to measure real heal rate and cost per repair.
**Known problems:** Live E2E repair/cost runs await B & D integration.