# B · Attach

_Updated: Fri 18:50. Only B and B's agent write here. Keep it under 15 lines and true._

**Done**
- Extractor + normalization, tested; sets `documentRefsPending`. Known recipe TenderNed (all open calls). No model call on reads.
- Model Cartographer (task 3), tried on real portals with the team key: Mercell → blocked (403), DTVP → failed (list needs a JS search), PLACSP → failed (robots.txt), Platforma Zakupowa → **serving 1,200 tenders** after A's redirect fix (3 drafts, $0.06). Feedback shows the real item; list region first on long pages.

**Doing now**
- Getting the model to map documents too (PL served with empty document lists). Then families (task 5).

**Needs from others**
- A: cost per attach for the README: 3 model calls, ~21k in / 1.7k out tokens, $0.06 (Platforma Zakupowa); known recipes $0. Model calls now time out at 90 s with 2 retries (C's request).

**Known problems**
- Browser-only portals (list only after a JS search, no JSON API) fail honestly: browser tier not built.
