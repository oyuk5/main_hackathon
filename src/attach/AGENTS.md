# Area B · Attach

You are working for **person B**. Tasks and times: `docs/TASKS.md`, section B.

**Mission:** given only a URL, produce a **Recipe** (JSON data, no code) that the Extractor runs with **no model call**, plus 3 to 5 golden records.

**You own:** `src/attach/`, `src/llm/`, `src/shared/recipe.ts`.
**You don't touch:** `src/platform/`, `src/watch/`, `web/`, `lab/`. `src/shared/contract.ts` is frozen. `src/shared/modules.ts` changes only with A or C.

## Your interfaces (`src/shared/modules.ts`)
- `extractor.read(recipe, ctx) -> ReadOutcome`: deterministic, **must not call `ctx.llm`**. Fill `diagnostics.fieldFill` for every field, `listSkeletonHash`, and `emptyStateText` when the portal says "no results". C's checks depend on these.
- `cartographer.attach(ctx) -> AttachOutcome`: may use `ctx.llm.json({ schema: Recipe, ... })`. Returns `ok` with recipe, golden records and the first read, or `blocked` / `failed` with a plain reason.
- C's Medic reuses your Extractor to verify repairs and may ask the Cartographer for a fresh attach. Keep both callable on their own.

## Rules for this area
- Network only through `ctx.http` / `ctx.browser` (1 req/s per portal). Check `ctx.signal` in loops.
- Prefer the most stable source: feed > JSON API seen in network traffic > HTML > browser-only.
- Follow summary pages to the real tender page. Notice links often lead to a summary.
- Deadlines on the page are **local time**: use the recipe's `timeZone` and `localWallTime()` from `src/shared/time.ts`.
- CPV without check digit (`45000000-7` → `45000000`). Map local words to `procedureType` / `contractNature`; unknown → leave out.
- **When unsure, null.** A wrong value is worse than a missing one.
- Send the model a compressed page (pruned DOM or accessibility tree, repeated rows collapsed to 2), never raw HTML. At most 3 correction rounds, each with the exact dry-run errors.
- Login form, captcha widget, 401/403 → `blocked` with the reason in words. Try the documents first: some portals show a captcha, yet the files download anyway.
- Every model call goes through `src/llm/client.ts` so it lands in the ledger with tokens and cost.

## Check your work
Unit tests for normalization next to the code (`*.test.ts`). Then `npm run dev`, `POST /portals` with a lab portal from D (`npm run lab`) or a real one, and watch `GET /portals/{id}` and `/tenders`. `GET /internal/ledger` must show zero calls for regular reads.
