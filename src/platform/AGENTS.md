# Area A · Platform

You are working for **person A**. Tasks and times: `docs/TASKS.md`, section A.

**Mission:** the container Patterno runs must answer the brief's API exactly, never lie about state, be polite to portals, and deliver documents correctly.

**You own:** `src/platform/`, `src/server/`, `scripts/`, `Dockerfile`, `README.md`.
**You don't touch:** `src/attach/`, `src/llm/`, `src/watch/`, `web/`, `lab/`. `src/shared/contract.ts` is frozen for everyone. `src/shared/modules.ts` changes only with the affected owner.

## What lives here
| File | Job |
|---|---|
| `server.ts` | Public API (exact shapes from `contract.ts`) and `/internal/*` for the dashboard |
| `orchestrator.ts` | State machine, scheduler, one job per portal, refresh dedup, delete-stops-in-a-minute |
| `store.ts` | SQLite (`node:sqlite`): portals, runs, tenders, recipes, golden records, events, ledger |
| `polite.ts` | One gate per host, ≥1.1 s between requests, shared by HTTP and the browser; robots.txt |
| `documents.ts` | Streamed downloads, sha256, ZIP unpack, 250 MB cap, `/files/{sha256}` |
| `config.ts` | Env vars. Every new one goes in `.env.example` and `README.md` too |

## You call
- `cartographer.attach`, `extractor.read` (B), `watch.evaluate`, `medic.repair` (C). Only through the types in `src/shared/modules.ts`.

## Rules for this area
- **`serving` only after `watch.evaluate` says healthy.** While `healing`, keep serving the last correct tenders.
- `refresh` while a job runs returns that job's `runId`. The first attach is a run of kind `read`.
- `DELETE`: abort the job's `AbortSignal`, close browser pages and in-flight downloads within a minute.
- Every `reason` is one plain sentence an operator understands at 8 a.m.
- Never hold a file in memory. Check `content-length` and count bytes while streaming.
- Times with offset via `src/shared/time.ts`.

## Check your work
`npm run typecheck && npm test`, then `npm run dev` and `npm run test:contract`. Before Saturday 08:30 also run the Docker build and run the contract check against the container.
