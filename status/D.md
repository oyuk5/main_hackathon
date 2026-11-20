# D · Proof and experience

_Updated: Fri 18:57. Only D and D's agent write here. Keep it under 15 lines and true._

**Done**
- `lab/portals.json`: 8 real portals, 6 countries, 3 hidden, 2 login-blocked. PLACSP must go (robots.txt), replacement pending.
- Demo portals live: `npm run lab` → http://localhost:4100/stadtwerke/ (DE html table), /ville/ (FR JS app + JSON API), /gmina/ (PL cards, 2-hop docs, ZIP). Truth at `/_truth/<slug>.json`, traffic at `/_lab/state`. Tests: `node --import tsx --test lab/serve.test.ts`.
- First Cartographer run on the lab (18:53): all 3 `serving`, all tenders found, 8 model calls, $0.07 total, max 1 req/s.

**Doing now**
- Mutator (`lab/mutate.ts`, via `POST /_lab/variant`), then eval.

**Needs from others**
- **B:** 0 documents on all 3 lab portals (recipes have no documents rule?). Stadtwerke: buyer, dates, deadline, CPV, place missing on all 14 (all on the detail page `dl.details`); withdrawn 4753 read as open. Gmina: description, procedure, nature, CPV, place missing (detail `table.szczegoly`). Ville is perfect apart from documents.
- **C:** Stadtwerke says "all checks passed" while buyerName, publicationDate and submissionDeadline are null on every tender and every tender has 0 documents. Should that be `serving`?

**Known problems**
- None in the lab. Truth matches tenders by `url`; ids are the portal's own ids (e.g. 4711, c-2026140, 3200).
