# B · Attach

_Updated: Sat 00:40. Only B and B's agent write here. Keep it under 15 lines and true._

**Done**
- Extractor (html, jsonApi, feed, **browser**: JS lists, `list.before` search steps, clickNext, click downloads); no model call on reads. Known recipe TenderNed; families ($0 for the 2nd portal on known software). DTVP read live via browser tier (draft recipe `recipes/dtvp.draft.json`, 40/40 fields).
- Staged enrichment: ≤120 tenders or 120 s of detail work per read, newest first, rest `documentRefsPending`, progress lines in the run log. TenderNed serving after ~8.5 min (was ~12).
- Cartographer: lab evals 91–100%, **0 wrong values**, ~$0.026/attach; CPV located and checked for the model (gmina CPV 13/13); login-only tender pages handed to A's document check as a login wall.

**Doing now**
- gmina: the model still skips procedureType/contractNature/place (73% there); same located-label approach as CPV next.

**Needs from others**
- A: first serve is now dominated by `deliver` document downloads (~6 of 8.5 min on TenderNed). A smaller document budget while a portal has no tenders yet (~60 refs) would serve in ~3 min.
- A: env vars for README + `.env.example`: `PRICE_SMART_CACHED_IN`, `PRICE_FAST_CACHED_IN`, `LLM_PROMPT_CACHE=0`; ledger `cached_tokens` column. Demo: starts real reads by itself.
- D: DTVP public tenders' documents download without a login; non-public ones show a login page (now reported as a login wall).
