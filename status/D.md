# D · Proof and experience

_Updated: November 21, 2026. Only D and D's agent write here. Keep it under 15 lines and true._
**Done**
- `lab/portals.json` (8 real, 6 countries, 3 hidden; PLACSP must go). Demo portals `npm run lab` (:4100) with truth per variant. Mutator `npx tsx lab/mutate.ts`.
- Dashboard fixes: map hover flicker, sidebar overflow, and status cards filtering Issues/Log in place (Chromium regression test passed).
- **Eval** `npm run eval` (22:28, full table in `lab/results/latest.md`): attach accuracy 73%, 0 wrong values after attach; heal rate **85%** (11/13 breaking changes); median heal **16 s**; repair **$0.021**, attach **$0.040** per portal; false repairs **3 of 6**.
**Doing now**
- Backup video (Sat 01:00); replace PLACSP; spot checks of real portals in the eval.
**Needs from others**
- **C:** empty-day causes a false repair on all 3 demo portals (ville even ends `failed`). gmina renamed-classes: Medic's candidate found no files → failed. ville renamed-keys repair loses `withdrawn` (`etat: "annulée"`).
- **B:** stadtwerke: description/procedureType/contractNature/CPV/place missing, withdrawn 4753 read as open in 5 of 7 attaches. gmina: procedureType/contractNature/CPV missing. ville: 0 documents.
- **A:** README numbers above (repair $0.021, attach $0.040, heal 85%, median 16 s).
