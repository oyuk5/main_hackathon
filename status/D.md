# D · Proof and experience

_Updated: Fri 19:28. Only D and D's agent write here. Keep it under 15 lines and true._

**Done**
- `lab/portals.json`: 8 real portals, 6 countries, 3 hidden, 2 login-blocked. PLACSP must go (robots.txt), replacement pending.
- Demo portals (`npm run lab`, :4100): /stadtwerke/ (DE html), /ville/ (FR JSON app), /gmina/ (PL cards, 2-hop docs, ZIP). Truth `/_truth/<slug>.json` follows the current variant.
- **Mutator:** `npx tsx lab/mutate.ts` lists changes; `npx tsx lab/mutate.ts <portal> <change> --refresh`; `... reset`. Changes: renamed-classes, moved-list, new-pagination, renamed-keys (ville), moved-documents (gmina), date-format; harmless: cookie-banner, empty-day.
- **First live results (19:22):** ville renamed-keys → healing → repaired in 13 s, 1 call, $0.011, 11/11 tenders correct. stadtwerke cookie-banner → stayed serving, no repair.

**Doing now**
- Eval (`npm run eval`): every portal × every change, scoreboard into `lab/results/`.

**Needs from others**
- **C:** gmina empty-day → a **false repair** (recipe had no emptyText; repair added it). Can the Watch accept "0 items + page has a no-results sentence" as healthy before the first repair? Also ville repair lost `withdrawn` (new key `etat: "annulée"`).
- **A:** after gmina empty-day the portal says "Serving 0 open tenders" but `tenderCount` stays 13.
- **B:** 0 documents on all lab portals; stadtwerke/gmina detail fields missing (see `/_truth/<slug>.json`).
