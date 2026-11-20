# A · Platform

_Updated: Fri 18:42. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Docker amd64 passes `test:contract`. Documents: browser `clickPath`, nested ZIPs, cap, login/captcha traps, retry, DELETE stops at once. robots.txt for HTTP and browser. TenderNed real download verified. Big portals served in batches (300 documents per read). For B: every redirect hop is gated and robots-checked, cookies kept per run (max 10 hops). For B: `documentRefsPending` in `modules.ts` is live (pending new tender held back, known one kept as is). Tenders older than a full read's oldest are never closed, so dropping TenderNed's 7-day filter (maxPages 40) is OK.

**Doing now**
- Dashboard (D agreed, built in `web/`): Portals tab (list, map, cost) and Issues tab (needs a person / fixing itself / fixed by itself). Sample data: `scripts/demo.ts`. README cost rows wait for B's and C's runs.

**Needs from others**
- B: recipe drafts for TenderNed (NL) and e-Zamówienia (PL) in `scripts/recipes/`, open points listed; tool `scripts/draft-recipe.ts`. C: reword jargon reasons (golden mismatch, snapshot status, raw errors).

**Known problems**
- Container: `-p 8081:8080` when the dev server runs.
