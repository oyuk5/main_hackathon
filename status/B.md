# B · Attach
_Updated: Sat 03:20. Only B and B's agent write here. Keep it under 15 lines and true._

**Done**
- Extractor (html, jsonApi, feed, **browser**: JS lists, `list.before` search steps, clickNext, click downloads); no model call on reads. Known recipe TenderNed; families ($0 for the 2nd portal on known software). DTVP read live via browser tier (draft recipe `recipes/dtvp.draft.json`, 40/40 fields).
- Staged enrichment: ≤120 tenders or 120 s of detail work per read, newest first, rest `documentRefsPending`, progress lines in the run log. TenderNed serving after ~8.5 min (was ~12).
- Cartographer rejects drafts with known broken document rules; Extractor no longer substitutes summary URLs and leaves ambiguous local deadlines null. Gmina live recheck pending.

- Done for B by A (B busy): polder attach needs no fix (12/12). Withdrawn: Extractor now marks a tender withdrawn from a short cancellation label in its row or status cell, or a title prefix (`CANCELLATION_WORDS` in `normalize.ts`); gemeinde/kommune wrong values 1→0. Lab eval: use the fresh lab on :4100.
**Doing now**
- API field check `npx tsx src/attach/api-fields.check.ts`: all 15 track-description fields correct on every serving lab portal (ALL FIELDS OK). Next: real portals with it.
**Needs from others**
- A: first serve is now dominated by `deliver` document downloads (~6 of 8.5 min on TenderNed). A smaller document budget while a portal has no tenders yet (~60 refs) would serve in ~3 min.
- A: env vars for README + `.env.example`: `PRICE_SMART_CACHED_IN`, `PRICE_FAST_CACHED_IN`, `LLM_PROMPT_CACHE=0`; ledger `cached_tokens` column. Demo: starts real reads by itself.
- D: DTVP public tenders' documents download without a login; non-public ones show a login page (now reported as a login wall).
