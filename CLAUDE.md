# Watchtower: instructions for AI agents

Hackathon project for Patterno's "Build the Watchtower" challenge. Deadline Saturday 10:30 (CET).

## Read first, in this order
1. `docs/BRIEF.md`: the requirements. It wins every conflict.
2. `docs/TASKS.md`: who owns what, the tasks and the timeline. Ask the user which person (A, B, C or D) they are.
3. `docs/ARCHITECTURE.md`: the design and why.

## Hard rules (from the brief, never break)
- The public API in `src/shared/contract.ts` is frozen. Exact paths, status codes and field names. Extra data goes on `/internal/*` routes only.
- Every time in API output is a date-time **with offset** (`2026-12-09T10:00:00+01:00`). Use `src/shared/time.ts`, never `toISOString()`.
- A wrong value is worse than a missing one. When unsure, send `null` (required fields) or leave the field out (optional ones).
- At most **1 request per second per portal**. All network access goes through `ctx.http` or `ctx.browser`, never raw `fetch` or a new browser.
- **No logins, no captcha solving.** A blocked portal is `failed` with a reason that says so.
- Regular reads make **no model call**. Only the Cartographer (attach) and the Medic (repair) use `ctx.llm`.
- No human steering at runtime: every state change must happen automatically.
- Model keys come from environment variables listed in `README.md` and `.env.example`.

## Working rules
- Stay inside the folders your person owns (see `docs/TASKS.md`). Interfaces between areas are in `src/shared/modules.ts`; change them only with the other owner.
- Keep `main` runnable. Before pushing: `npm run typecheck && npm test`. Run `npm run test:contract` against a running server when you touch the API.
- Commit small steps with one-line imperative messages. **No co-author, "Generated with" or session lines.**
- Never commit `.env`, keys or downloaded tender documents.

## Commands
| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | API and worker on :8080 with reload (reads `.env`) |
| `npm run dev:web` | Dashboard dev server on :5173, proxied to :8080 |
| `npm run build && npm start` | Production build and run |
| `npm run typecheck` / `npm test` | Types and unit tests (`*.test.ts`, node:test) |
| `npm run test:contract` | Checks a running server against the brief's exact answers |
| `npm run lab` / `npm run eval` | Demo portals and the scoreboard (person D) |
| `docker build -t watchtower . && docker run -p 8080:8080 --env-file .env watchtower` | What Patterno runs |

## Stack
TypeScript on Node 22.13+. Fastify (API and static dashboard), SQLite through `node:sqlite`, Playwright Chromium, cheerio, jsonpath-plus, zod 4, OpenAI SDK, yauzl. Dashboard: React 19, Vite, Tailwind 4. For dashboard work use the `frontend-design` skill in `.claude/skills/`. For browser tests use `webapp-testing`.
