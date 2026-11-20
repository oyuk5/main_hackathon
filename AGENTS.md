# Watchtower: instructions for AI agents

Hackathon project for Patterno's "Build the Watchtower" challenge. Deadline **Saturday 10:30 CET**; we submit at 10:00.
This file is read by Codex directly and by Claude Code through `CLAUDE.md`. It applies to every agent in this repo.

## At the start of every session
1. Ask which person the user is (**A, B, C or D**) if they haven't said.
2. Read, in this order:
   - `docs/BRIEF.md`: the requirements. It wins every conflict.
   - Your area's `AGENTS.md` (see the table below), then your section of `docs/TASKS.md`.
   - `status/*.md`: what the other three are doing right now and what they need from you.
   - `docs/DECISIONS.md`: decisions already made. Don't reopen them without asking the user.
   - `docs/ARCHITECTURE.md` when you need the design and the reasons behind it.
3. Continue with the first unfinished task in your section of `docs/TASKS.md`, unless the user says otherwise.

| Person | Area | Area instructions | Owns |
|---|---|---|---|
| A | Platform | `src/platform/AGENTS.md` | `src/platform/`, `src/server/`, `scripts/`, `Dockerfile`, `README.md` |
| B | Attach | `src/attach/AGENTS.md` | `src/attach/`, `src/llm/`, `src/shared/recipe.ts` |
| C | Notice and repair | `src/watch/AGENTS.md` | `src/watch/` |
| D | Proof and experience | `web/AGENTS.md`, `lab/AGENTS.md` | `web/`, `lab/` |

## Hard rules (from the brief, never break)
- The public API in `src/shared/contract.ts` is **frozen**: exact paths, status codes and field names. Extra data goes on `/internal/*` routes only.
- Every time in API output is a date-time **with offset** (`2026-12-09T10:00:00+01:00`). Use `src/shared/time.ts`, never `toISOString()`.
- **A wrong value is worse than a missing one.** When unsure, send `null` (required fields) or leave the field out (optional ones).
- At most **1 request per second per portal**. All network access goes through `ctx.http` or `ctx.browser`, never raw `fetch` or a new browser.
- **No logins, no captcha solving.** A blocked portal is `failed` with a reason that says so.
- Regular reads make **no model call**. Only the Cartographer (attach) and the Medic (repair) use `ctx.llm`.
- No human steering at runtime: every state change happens automatically.
- Model keys come from environment variables listed in `README.md` and `.env.example`.

## Working with the other three agents
We are four people with four agents working on `main` at the same time. The repo is how the agents coordinate:
- **Code is the contract.** Interfaces between areas live in `src/shared/modules.ts`. Change it only after the affected owner agrees; tell the user to message them. Never edit another area's folder: if you need something from it, write the request in your status file under "Needs from others" and tell the user.
- **Your status file, `status/<letter>.md`, is the only status file you write.** Update it at the end of every task: done, doing now, needs from others, known problems. Keep it under 15 lines and keep it true.
- **Decisions** that affect another area go at the end of `docs/DECISIONS.md` as one line: `HH:MM · who · decision · why`. Append only, never rewrite.
- **Answers from Patterno** go in `docs/BRIEF.md` under "Answers from Patterno".
- If a test in another area fails after you pull, don't fix it. Tell the user who owns it.

## Git
- Small commits on `main`, one-line imperative messages. **No co-author, "Generated with" or session lines.**
- Before every push: `git pull --rebase`, then `npm run typecheck && npm test`. Run `npm run test:contract` against a running server when you touch the API.
- Keep `main` runnable. Half-done work stays behind the existing stub.
- Never commit `.env`, keys, downloaded tender documents or `data/`.

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
TypeScript on Node 22.13+. Fastify (API and static dashboard), SQLite through `node:sqlite`, Playwright Chromium, cheerio, jsonpath-plus, zod 4, OpenAI SDK, yauzl. Dashboard: React 19, Vite, Tailwind 4. Tests use `node:test`; put them next to the code as `*.test.ts`.
