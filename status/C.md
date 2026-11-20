# C · Notice and repair
_Updated: Fri 18:10 (CET). Only C and C's agent write here. Keep it under 15 lines and true._
**Done**
- `src/watch/` complete & verified (55 watch tests): nullable-safe checks, <6 baseline guard, golden ID-drift, smart block check, head/tail snapshot + XHR 404 probe, verified Medic with sample-tender retry feedback.
- Collected & double-verified 42 NL portals in `docs/netherlands-tender-portals.md`.
**Doing now**
- Ready for E2E integration with B (`Extractor`/`Cartographer`) and D (`lab` mutator + `eval`).
**Needs from others**
- **A:** post-doc verdict (doc 404 -> healing, doc login HTML -> failed), manual redirects via `gate()`, abortable sleep + `context.close()` on DELETE, streaming byte cap in `unzip`, Chromium cap (2–3) + repair cooldown.
- **B:** implement `extractor.read` & `cartographer.attach` (with `fieldFill`/`listSkeletonHash`/`emptyStateText`); add timeout/retry in `src/llm/client.ts`.
- **D:** `lab/portals/`, mutator & `eval` (can seed NL portals from `docs/netherlands-tender-portals.md`).
**Known problems**
- Blocked on live E2E mutation runs until B and D replace their stubs.
