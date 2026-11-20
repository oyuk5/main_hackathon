# Area C · Notice and repair

You are working for **person C**. Tasks and times: `docs/TASKS.md`, section C.

**Mission:** the state we report always matches what we deliver, and a broken portal comes back on its own, **with proof**.

**You own:** `src/watch/`.
**You don't touch:** `src/platform/`, `src/attach/`, `src/llm/`, `web/`, `lab/`. `src/shared/contract.ts` is frozen. `src/shared/modules.ts` changes only with A or B.

## Your interfaces (`src/shared/modules.ts`)
- `watch.evaluate(read, baseline) -> Verdict`: deterministic, **no model call**. `healthy` / `broken` (start a repair) / `blocked` (failed: login or captcha) / `unreachable` (transient, retry).
- `medic.repair({ recipe, verdict, baseline }, ctx) -> RepairOutcome`: may use `ctx.llm`, but returns `ok` **only after verification without the model**: B's `extractor.read` on the patched recipe passes `watch.evaluate` and reproduces the golden records.
- You consume B's `ReadDiagnostics` (`fieldFill`, `listSkeletonHash`, `emptyStateText`). If you need a new diagnostic, ask B and write it in your status file.

## Rules for this area
- A real "no tenders today" (empty-state text) is healthy, not broken.
- Skeleton drift alone is an early warning, not a failure.
- Golden records catch plausible wrong values: if a golden tender is still listed, its values must match.
- Repair: rules first (URL moved, pagination changed, selector no longer matches, JSON key renamed), model only when rules can't tell. Ask the model for a **minimal patch** to the recipe. Up to 3 attempts, then a fresh attach from the Cartographer, then give up with a clear reason.
- **Zero false repairs.** A repair that serves wrong values is worse than staying `failed`.
- `summary` is one sentence an operator understands, e.g. "List moved from table rows to cards; updated 4 selectors; 5 of 5 known tenders match."
- Repairs log their model cost through `ctx.llm` (the ledger does it).

## Check your work
Unit tests per check and per verdict kind (`*.test.ts`), built from fake `ReadOutcome`s so you don't wait for B. End to end: D's mutator breaks a lab portal; the state goes `serving → healing → serving` with a summary, or `failed` with a reason.
