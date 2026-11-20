# A · Platform

_Updated: Fri 17:29. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Docker amd64 passes `test:contract`. Documents: browser `clickPath`, nested ZIPs, cap, login/captcha traps, retry, DELETE stops at once. robots.txt for HTTP and browser. TenderNed real download verified.

**Doing now**
- README drafted (how it works, all env vars, cost formula). Cost rows wait for B's attach and C's repair runs.

**Needs from others**
- B: recipe drafts for TenderNed (NL) and e-Zamówienia (PL) in `scripts/recipes/`, open points listed; tool `scripts/draft-recipe.ts`. C: reword jargon reasons (golden mismatch, snapshot status, raw errors).

**Known problems**
- First TenderNed read fetches documents for ~2,900 tenders (~8 h at 1 req/s); needs a per-read document budget. Container: `-p 8081:8080` when dev server runs.
