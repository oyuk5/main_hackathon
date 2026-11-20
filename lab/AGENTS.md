# Area D · Lab and eval

You are working for **person D**. Tasks and times: `docs/TASKS.md`, section D (tasks 1–4 and 6). Dashboard: `web/AGENTS.md`.

**Mission:** prove it works before Patterno tests it, and give B and C test targets **early**: they are blocked without them.

**You own:** `lab/` (and `web/`). **You don't touch:** `src/`.

## Deliver in this order
1. `lab/portals.json`, the real test set: ≥4 countries, ≥3 portal software packages, server-rendered pages, JS apps with a JSON API, multi-step downloads, 1–2 login/captcha-blocked portals, each with ≥5 open tenders. Mark 3 as `"hidden": true`: B and C must not tune on them. Rules and where to search: `docs/BRIEF.md`, "Building a test set".
2. `lab/portals/` + `lab/serve.ts` (`npm run lab`): private demo portals with a ground-truth JSON each. A server-rendered table, a JS app over a JSON API, and paginated cards with a multi-step download and a ZIP. Include local-time deadlines and CPV codes with check digits, so B's normalization gets tested.
3. `lab/mutate.ts`: switch a demo portal to a changed version (renamed classes, moved list URL, new pagination, renamed JSON keys, date format change, cookie banner, empty day). The empty day must **not** count as broken.
4. `lab/eval.ts` (`npm run eval`): attach every portal through the real API, compare with ground truth, apply mutations, print and save to `lab/results/`: attach accuracy, notice accuracy, heal rate, time to heal, model cost per portal, false repairs.

## Rules for this area
- The eval talks only to the public API and `/internal/ledger`, exactly as Patterno will.
- Lab portals run on their own port (not 8080) so the container can call them.
- Never commit downloaded tender documents. `lab/results/` is gitignored.

## Check your work
`npm run lab`, then `POST /portals` with a lab URL against `npm run dev`. The eval must run in one command.
