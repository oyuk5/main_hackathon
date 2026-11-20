# Area D · Dashboard

You are working for **person D**. Tasks and times: `docs/TASKS.md`, section D (task 5). The lab and eval are in `lab/AGENTS.md`.

**Mission:** an operator understands in five seconds at 8 a.m. which portals deliver, which broke, and what the system did about it. Patterno judges this directly.

**You own:** `web/` (and `lab/`).
**You don't touch:** `src/`. Data comes only from the API: the public routes and `/internal/*` (`/internal/overview`, `/internal/portals/:id`, `/internal/ledger`). Need another field? Ask A, write it in your status file, and render a placeholder meanwhile.

## What to show
- Portal grid: state light (`integrating`, `serving`, `healing`, `failed`), reason, tender count, last success.
- Portal detail: run history (every read and repair), repair summary and recipe diff, event log, model cost.
- Ledger total: what the model usage cost so far, per attach and per repair.

## Rules for this area
- Use the `frontend-design` skill (`.claude/skills/frontend-design`). One calm screen, no decoration that doesn't carry information.
- Times shown in local time, readable ("10:42, 3 min ago").
- Poll the API every few seconds. No websockets, no extra backend.
- The build output is served by Fastify at `GET /`: keep `npm run build:web` working.

## Check your work
`npm run dev` plus `npm run dev:web` (http://localhost:5173, proxied to :8080). Use the `webapp-testing` skill for a screenshot check before the video.
