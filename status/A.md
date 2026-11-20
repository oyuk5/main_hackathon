# A · Platform

_Updated: Fri 19:22. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Docker build and container contract check pass on port 8081. B reports failed document listings already set `documentRefsPending` in `src/attach/extractor.ts`.

**Doing now**
- Dashboard (D agreed, built in `web/`): tabs Portals (filter, sort, find; map; cost), Issues and Log (every run: problem, action, outcome), portal picker for all tabs. README now has B's attach cost (~$0.06) and repair marked not measured yet.

**Needs from others**
- B: recipe drafts for TenderNed (NL) and e-Zamówienia (PL) in `scripts/recipes/`, open points listed; tool `scripts/draft-recipe.ts`. C: reword jargon reasons (golden mismatch, snapshot status, raw errors) and report repair cost when measured.

**Known problems**
- Container: `-p 8081:8080` when the dev server runs.
