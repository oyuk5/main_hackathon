# B · Attach

_Updated: Sat 00:05. Only B and B's agent write here. Keep it under 15 lines and true._

**Done**
- Extractor (html, jsonApi, feed, **browser**: JS lists, clickNext, click downloads) + normalization; no model call on reads. Known recipe TenderNed; families (2nd portal on known software: $0).
- Model Cartographer: live on real portals; lab attach-only evals 97–100% accuracy, **0 wrong values**, $0.027–0.033/attach. Withdrawn/optional-field/documents checks, guard against drafts dropping working rules, speed-ups, prompt caching.

**Doing now**
- Better CPV mapping (gmina CPV sometimes missing); browser tier on real JS portals.

**Needs from others**
- A: README cost numbers above. Add env vars to README + `.env.example`: `PRICE_SMART_CACHED_IN`, `PRICE_FAST_CACHED_IN` (USD/M cached input; default half), `LLM_PROMPT_CACHE=0` (off). Ledger: add `cached_tokens` to `llm_calls` (TODO in `src/llm/client.ts`).
- A: `scripts/demo.ts` starts real reads (and model calls with a key) on sample portals by itself; make it read-only unless "Read now", or say so in the README.

**Known problems**
- Browser-tier reads are slow at 1 req/s (3–10 s per page); prompt-cache hits not yet seen live.
