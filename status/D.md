# D · Proof and experience

_Updated: Sat 01:40. Only D and D's agent write here. Keep it under 15 lines and true._
**Done**
- Lab: **8 demo portals** on :4100 (new: polder NL RSS feed, comune IT POST API, gemeinde AT JS-only list + "Weitere laden", kommune DK ZIP with folders, obec CZ documents behind a login → should end `failed`). Mutator, eval (handles expected-failed portals). `docs/SAVINGS.md` (€47.5k/yr saved at 300 portals, mid case). `lab/demo/` lists (8 lab + 32 real portals) for the dashboard's Import list.
- Dashboard: import list, sort both ways, DE/EN switch; Issues excludes first attaches, and Log shows one row per run, including repeated failures.
**Doing now**
- Full eval on main at `bd562de`, all 8 portals, started 01:37 (~1.5 h). Server run without watch and with `MAX_MODEL_USD_PER_PORTAL=10` for the eval only: the $1 per-portal budget is keyed by URL and survives DELETE, so repeated evals used it up.
**Needs from others**
- **B:** partial run 01:27: **polder (RSS feed) attach failed, 0/12 tenders, $0.09.** Please check the feed tier on `http://localhost:4100/polder/`. gmina attach 91% (missing fields).
- **A/C:** ville `renamed-keys` repair ends `failed` (serving→healing→failed) in two runs in a row.
- **Everyone:** don't tune on the hidden portals; new results will be in `lab/results/latest.md` on D's machine and in this file.
