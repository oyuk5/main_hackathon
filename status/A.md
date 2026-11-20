# A · Platform

_Updated: Fri 18:06. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Docker amd64 passes `test:contract`. Documents: browser `clickPath`, nested ZIPs, cap, login/captcha traps, retry, DELETE stops at once. robots.txt for HTTP and browser. TenderNed real download verified. Big portals served in batches (300 documents per read). For B: `documentRefsPending` in `modules.ts` is live (pending new tender held back, known one kept as is). Tenders older than a full read's oldest are never closed, so dropping TenderNed's 7-day filter (maxPages 40) is OK.

**Doing now**
- README drafted (how it works, all env vars, cost formula). Cost rows wait for B's attach and C's repair runs.

**Needs from others**
- B: recipe drafts for TenderNed (NL) and e-Zamówienia (PL) in `scripts/recipes/`, open points listed; tool `scripts/draft-recipe.ts`. C: reword jargon reasons (golden mismatch, snapshot status, raw errors).

**Known problems**
- Container: `-p 8081:8080` when the dev server runs.
