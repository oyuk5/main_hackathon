# Onboarding: 10 minutes, then build

**What we build:** Watchtower, a container that attaches any tender portal on its own, notices when it breaks, and repairs itself. Patterno runs it on portals it has never seen. Requirements: `docs/BRIEF.md`. Design: `docs/ARCHITECTURE.md`. Your tasks: `docs/TASKS.md`.

**Deadline Saturday 10:30, we submit at 10:00.** No submission, no judging.

## 1. Set up (Windows, macOS or Linux)
1. **Node 22.13 or newer** (`node -v`). Git. VS Code with Claude Code or Codex. **A** also needs Docker Desktop (Docker Engine on Linux).
2. Clone the repo and install:
   ```bash
   git clone https://github.com/oyuk5/main_hackathon.git
   cd main_hackathon
   npm install
   npx playwright install chromium
   ```
3. `.env`: copy `.env.example` to `.env`. The OpenAI key is on **BuilderBase → Resources → Reveal**. Ask B which values to use for `MODEL_SMART` and `MODEL_FAST` so we all use the same. Never commit `.env`.
4. Check that everything runs:
   ```bash
   npm run typecheck && npm test
   npm run dev                # http://localhost:8080
   npm run test:contract      # in a second terminal: "All contract checks passed"
   ```
5. **Windows:** if `git status` shows every file as changed after you pull `.gitattributes`, run `git add --renormalize .` once. Only line endings changed; nothing else.
6. **Linux** (tested path: Ubuntu/Debian; other distros work but install Chromium's libraries by hand):
   ```bash
   # Node 22 via nvm (distro packages are usually too old)
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
   source ~/.bashrc && nvm install 22 && node -v      # must print v22.13 or newer

   # Chromium plus the system libraries it needs (asks for sudo)
   npx playwright install --with-deps chromium

   cp .env.example .env
   ```
   - If Playwright fails with "missing dependencies", rerun the `--with-deps` line. A plain `install chromium` downloads the browser but not the libraries.
   - **A, Docker:** install Docker Engine (`curl -fsSL https://get.docker.com | sh`), then `sudo usermod -aG docker $USER` and log out and back in so `docker` runs without sudo.
   - Port 8080 busy? Check with `ss -ltnp | grep 8080`.

## 2. Pick your letter
| | Area | You own | Your agent reads |
|---|---|---|---|
| **A** | Platform: API, state, storage, documents, Docker, README | `src/platform/`, `src/server/`, `scripts/`, `Dockerfile`, `README.md` | `src/platform/AGENTS.md` |
| **B** | Attach: learn a portal, read it without a model | `src/attach/`, `src/llm/`, `src/shared/recipe.ts` | `src/attach/AGENTS.md` |
| **C** | Notice and repair: checks, Medic, proof | `src/watch/` | `src/watch/AGENTS.md` |
| **D** | Proof and experience: test portals, lab, eval, dashboard, video | `web/`, `lab/` | `lab/AGENTS.md`, `web/AGENTS.md` |

**Stay in your folders.** The skeleton already runs end to end: replacing your stub lights up the pipeline.

## 3. Start your agent
- **Claude Code:** `/start B` (your letter). At the end of a task: `/sync`.
- **Codex:** it reads `AGENTS.md` by itself. Paste the prompt from the end of `docs/TASKS.md` with your letter.

## 4. How the agents work together
Agents don't talk to each other. They share the repo, and each file has one job:

| File | Who writes it | What it's for |
|---|---|---|
| `src/shared/contract.ts` | nobody (frozen) | Patterno's exact API |
| `src/shared/modules.ts` | owners together | The interfaces between areas, as code. If the types disagree, the compiler says so at once |
| `status/A.md` … `D.md` | each person only their own | Done, doing now, **needs from others**, known problems. Agents read all four before they start |
| `docs/DECISIONS.md` | anyone, append only | One line per decision that affects another area, so nobody's agent undoes it |
| `docs/BRIEF.md` → "Answers from Patterno" | whoever asked | What the mentors told us |

Why not one shared `context.md`: four agents editing one file means merge conflicts every hour and stale context. One status file per person can't conflict.

## 5. The loop (about every hour)
1. `git pull --rebase`
2. Work in your folders, in small steps.
3. `npm run typecheck && npm test` (plus `npm run test:contract` if you touched the API)
4. Update your `status/<letter>.md` → commit → push. `/sync` does all of this.

Rules:
- `main` must always run. Half-done work stays behind the stub.
- **Another area's test fails? Don't fix it.** Tell its owner.
- Need a change in `modules.ts` or someone else's folder? Write it under "Needs from others" **and** say it in the team chat.
- Stuck for 30 minutes? Say so in the chat. Pairing for 10 minutes is cheaper than losing an hour.
- Commit messages: one line, imperative, no co-author or "Generated with" lines.

## 6. Using Codex well (from the OpenAI talk)
- **Give a goal, not steps:** what done looks like, where to start, how to check. Example: `/goal Implement the html tier of extractor.read in src/attach. Done when npm test passes and the lab table portal returns 12 tenders with every required field.`
- **Parallel work, separate scopes:** one task per worktree or cloud task, each touching different files. Never two agents on the same file.
- **Cloud tasks for long jobs,** especially overnight (more test portals, more tests). Local for fast iteration.
- **Drafter and critic:** for the Cartographer and Medic prompts, have one agent draft and another critique against the brief before you commit.
- Watch the token budget: models run only for attach and repair, never for regular reads. That is also what Patterno judges.

## 7. Team checkpoints
| When | Must be true | Who |
|---|---|---|
| Fri 17:30 | Everyone runs the repo locally. Docker build proven. Test portal list started | all, A, D |
| Fri 19:00 | First real portal served end to end | B + A |
| Fri 21:00 | Lab portals attach on their own. Checks done. Mutator ready | B, C, D |
| Fri 23:00 | First automatic, verified repair. Eval prints numbers | C, D |
| Sat 01:00 | **Backup video.** Clean Docker build. Everything pushed | all |
| Sat 01:00–07:00 | Sleep in shifts: A+D, then B+C | all |
| Sat 08:30 | **Code freeze.** Fresh-machine Docker test | A |
| Sat 10:00 | **Submit** on BuilderBase | D + A |

A 5-minute stand-up at every checkpoint: each person reads out their status file.

## 8. Hand-in checklist (Saturday)
- [ ] `docker build .` works on linux/amd64; the container serves the API and dashboard on :8080
- [ ] `npm run test:contract` passes against the container
- [ ] README: how it works on one page, env vars, measured cost per portal (`GET /internal/ledger`)
- [ ] Video of 3 minutes or less: attach an unseen portal, a mutation and its repair, the dashboard, eval numbers, cost
- [ ] BuilderBase: project name, repo link, pitch video, key values for Patterno
- [ ] No `.env`, keys or tender documents in git

**Questions for Patterno:** see the open questions in `docs/BRIEF.md`. Whoever goes to mentoring asks them and writes the answers down.
