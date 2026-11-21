# Tasks and roles

Four people, four areas. Each area has one owner, its own folders, and clear inputs and outputs. **Stay in your folders.** To change something another person owns, ask them first.

Times are Maastricht time (CET, +01:00). Hard deadline: **Saturday 10:30**. We submit at **10:00**.

## Who owns what

| | Role | Mission | Owns |
|---|---|---|---|
| **A** | Platform | API, state machine, storage, politeness, documents, Docker, README | `src/platform/`, `src/server/`, `scripts/`, `Dockerfile`, `README.md` |
| **B** | Attach | Learn any unseen portal and read it without a model call | `src/attach/`, `src/llm/`, `src/shared/recipe.ts` |
| **C** | Notice and repair | Know when a read is wrong, repair it, prove the repair | `src/watch/` |
| **D** | Proof and experience | Test portals, chaos lab, eval scores, dashboard, video | `web/`, `lab/` |

Shared and frozen: `src/shared/contract.ts` (the brief's API, nobody changes it without the whole team) and `src/shared/modules.ts` (the interfaces between areas; change only with the affected owners).

## How the parts connect

```
POST /portals ─► orchestrator (A) ─► cartographer.attach (B) ─► Recipe + golden records
                       │
   every read:         ├─► extractor.read(recipe) (B, no LLM) ─► ReadOutcome
                       ├─► watch.evaluate(read, baseline) (C, no LLM) ─► Verdict
                       ├─ healthy ─► documentFetcher (A) ─► store ─► GET /portals/{id}/tenders
                       └─ broken ──► medic.repair (C, LLM + verifier) ─► new recipe ─► deliver
```

The skeleton already runs end to end. The stubs in `src/attach/index.ts` and `src/watch/index.ts` return "not implemented", so every portal ends `failed` with an honest reason. Replace a stub and the whole pipeline lights up.

---

## A · Platform

**Already done (in the skeleton):** every API route with the exact shapes, the contract check script, SQLite storage, the state machine, the per-host 1 request/second gate (HTTP and browser), robots.txt, the document pipeline (streaming, sha256, ZIP unpack, 250 MB cap), the Dockerfile.

**Your tasks, in order:**

1. **Prove the Docker build** (by 17:30). `docker build --platform linux/amd64 -t watchtower .` then `docker run -p 8080:8080 --env-file .env watchtower` and `npm run test:contract`. The Dockerfile checks that the base image's Node has `node:sqlite`; if that fails, switch the base or move to `better-sqlite3`.
2. **Browser downloads** in `documents.ts` (by 20:00): `ref.via === "browser"` with `clickPath` (multi-step downloads). Use `page.waitForEvent("download")` and stream the file through the same hash, cap and ZIP logic.
3. **Document traps** (by 22:00):
   - A captcha on the page, but the file downloads anyway: try the download before declaring a block.
   - An HTML response instead of a file: report it as a problem, and if it's a login page, report "documents need a login".
   - ZIPs over 1 GB: check `content-length` first, abort streaming at the cap. Never hold a file in memory.
   - Nested ZIPs: unpack one level deeper.
4. **Deletion within a minute:** confirm that aborting the job stops browser pages and in-flight downloads. Write a test.
5. **Reason strings:** every `reason` is one plain sentence an operator understands. Review them with C.
6. **README.md** (by Sat 08:00): how it works on one page, the env vars, and the cost of one portal from the ledger (`GET /internal/ledger`).
7. **Fresh-machine test** (Sat 08:30): clone the repo on a second laptop, `docker build .`, run, and pass the contract check.

**Done when:** `npm run test:contract` passes against the Docker container, documents with ZIPs and multi-step downloads arrive with correct sha256 values, and DELETE stops all traffic within a minute.

---

## B · Attach

**Goal:** given only a URL, produce a recipe that the Extractor runs with **no model call**, plus 3 to 5 golden records.

1. **Extractor** in `src/attach/` (by 18:30). Implement `extractor.read(recipe, ctx)` for the `html` and `jsonApi` tiers first, using `ctx.http` (never raw fetch), cheerio and jsonpath-plus. Pagination, list fields, detail pages for new items, document refs. Fill `diagnostics.fieldFill` for every field and `emptyStateText` when the portal says "no results".
2. **Normalization** (by 19:30), with unit tests:
   - Dates in European formats (`09.12.2026`, `9 déc. 2026`, `09/12/2026`, `9 december 2026`) and times shown in **local time**, using the recipe's `timeZone` and `localWallTime()` from `src/shared/time.ts`.
   - CPV: strip the check digit (`45000000-7` → `45000000`).
   - `procedureType` and `contractNature` mapping from local words (Offenes Verfahren → open, Bauleistung → works, and so on).
   - When unsure, return null. **A wrong value is worse than a missing one.**
3. **Cartographer** (by 21:00): `cartographer.attach(ctx)`.
   - Cheap checks first: feeds, `<link rel=alternate>`, a JSON API seen in the browser's network traffic (`page.on("response")`).
   - Follow summary pages to the real tender page (a brief trap).
   - Send the model a **compressed page** (accessibility tree or pruned DOM, repeated rows collapsed to 2), never raw HTML.
   - Get the recipe through `ctx.llm.json({ schema: Recipe })`, dry-run it with the Extractor, and send exact errors back. At most 3 rounds.
   - Detect blocks: login forms, captcha widgets, 401/403. Return `{ kind: "blocked", reason }` with the reason in plain words.
   - Pick 3 to 5 golden records from the first good read.
4. **Browser tier** (by 23:00): recipes with `tier: "browser"` for JavaScript-only portals, through `ctx.browser.withPage`.
5. **Families** (Saturday night, Should-have): fingerprint the portal software (URL paths, footer, generator tags) and reuse a family recipe for the next portal on the same software, with no model call. Start with whichever family appears most in D's test set (likely cosinex: DTVP and German state portals).
6. **LLM client** in `src/llm/client.ts`: make sure every call is logged to the ledger with tokens and cost.

**Done when:** at least 6 of D's test portals attach on their own and serve correct tenders, and regular reads make zero model calls (check the ledger).

---

## C · Notice and repair

**Goal:** the reported state always matches what we deliver, and broken portals come back on their own with proof.

1. **Checks** in `src/watch/` (by 19:00). Extend `watch.evaluate`:
   - Count against the baseline, with the "no results" text respected.
   - Field fill across the whole run, for every required field.
   - Invariants: dates parse, the deadline is after the publication date, ids are unique and stable, URLs are absolute, CPV codes have 8 digits.
   - **Golden-record recheck:** if a golden tender is still listed, its values must match.
   - Skeleton drift: a different `listSkeletonHash` is an early warning, not a failure on its own.
2. **Blocks vs breakage** (by 20:00): a login or captcha → `blocked`. HTTP 5xx or timeouts → `unreachable` (the orchestrator retries). A real "no tenders today" → healthy. Write a unit test for each.
3. **Medic** (by 22:30): `medic.repair({ recipe, verdict, baseline }, ctx)`.
   - Triage with rules first (URL moved, pagination changed, selector no longer matches, JSON key renamed). Use the model only when rules can't tell.
   - Ask the model for a **minimal patch** to the recipe, given the old recipe, the failing checks and a structural diff of the old and new page.
   - **Verify with no model:** run the patched recipe with B's Extractor, pass `watch.evaluate`, and reproduce the golden records. Up to 3 attempts, then ask B's Cartographer for a fresh attach, then give up with a clear reason.
   - Return a one-sentence `summary` of what changed, for example: "List moved from table rows to cards; updated 4 selectors; 5 of 5 known tenders match."
4. **State honesty review** (Sat 01:00): go through every path in `src/platform/orchestrator.ts` with A. A portal may only say `serving` if the last read passed the checks.
5. **Cost:** make sure repairs log their model cost, and add "cost per repair" to the README numbers.

**Done when:** D's mutations (renamed classes, moved list, new pagination, renamed JSON keys) are detected and repaired automatically, with **zero false repairs**, and blocked portals end `failed` with a reason that names the block.

---

## D · Proof and experience

**Goal:** prove that it works before Patterno tests it, and make it look excellent.

1. **Test portal set** (by 18:00), in `lab/portals.json`. Follow the brief's rules: at least 4 countries, 3 portal software packages, server-rendered pages, JavaScript apps with a JSON API, multi-step downloads, 1 or 2 portals blocked by a login or captcha. Each must have at least 5 open tenders. Use TED and the national sites listed in `docs/BRIEF.md`. Keep 3 portals hidden from B and C until the final test.
2. **Private demo portals** (by 19:30) in `lab/portals/`, served by `npm run lab`: a server-rendered table, a JavaScript app over a JSON API, and paginated cards with a multi-step download and a ZIP. Each has a ground-truth JSON with the exact expected tenders.
3. **Mutator** (by 21:00): switches a demo portal to a changed version, such as renamed classes, a moved list URL, new pagination, renamed JSON keys, a date format change, a cookie banner, or an empty day.
4. **Eval** (by 23:00): `npm run eval` attaches every test portal through the real API, compares against ground truth (lab portals) or spot checks (real portals), applies mutations, and reports: attach accuracy, notice accuracy (state vs reality), heal rate, time to heal, model cost per portal, false repairs. Save results to `lab/results/`.
5. **Dashboard** in `web/` (by Sat 03:00). Use the `frontend-design` skill. One calm screen: a portal grid with state lights, the reason, tender count and last success. Click a portal for its run history with every read and repair, the repair summary and recipe diff, the event log, and model cost. Add a ledger total. It must make sense to an operator at 8 a.m. in five seconds.
6. **Video** (backup at Sat 01:00, final at 09:30): 2 minutes 30 seconds maximum (see BRIEF answers). Attach an unseen portal, a mutation and its automatic repair, the dashboard, the eval numbers and the cost per portal.

**Done when:** the eval runs in one command and prints the scoreboard, and the dashboard shows every state and every repair clearly.

---

## Timeline

| By | Team milestone |
|---|---|
| Fri 17:30 | Everyone has the repo running locally. Docker build proven (A). Test portal list started (D). |
| Fri 19:00 | **First real portal served end to end** by a hand-checked recipe (B + A). |
| Fri 21:00 | Cartographer attaches lab portals on its own (B). Checks done (C). Mutator ready (D). |
| Fri 23:00 | **First automatic repair** of a mutated lab portal, verified (C). Eval prints numbers (D). |
| Sat 01:00 | **Backup video recorded.** Clean Docker build. Everything pushed. |
| Sat 01:00–07:00 | Sleep in two shifts (A+D, then B+C). The awake pair runs the eval and fixes the worst failure. |
| Sat 08:00 | README final with real cost numbers (A). |
| Sat 08:30 | **Code freeze.** Fresh-machine Docker test. |
| Sat 09:30 | Final video. |
| Sat 10:00 | **Submit** on BuilderBase (the form closes exactly at 10:30). |

## Git rules
- Work on `main` in small commits. Before every push: `git pull --rebase`, then `npm run typecheck && npm test`.
- Commit messages: imperative, one line, **no co-author or tool attribution lines**.
- Never commit `.env` or keys.
- Push at least every hour. If something is half-done, keep it behind the stub so `main` always runs.

## Prompt for your AI agent
In Claude Code type `/start A` (or B, C, D). For Codex or any other agent, paste this at the start of a session, with your letter:

> You are working on Watchtower for the Patterno hackathon track. I am person **[A/B/C/D]**. Read `AGENTS.md`, then `docs/BRIEF.md`, my area's `AGENTS.md`, my section of `docs/TASKS.md`, all of `status/` and `docs/DECISIONS.md`. Work only in the folders my role owns. Do not change `src/shared/contract.ts`. Start with my first unfinished task, keep `npm run typecheck && npm test` green, update `status/<my letter>.md` when a task is done, and commit small steps without attribution lines.

How we work together day to day: `docs/ONBOARDING.md`.
