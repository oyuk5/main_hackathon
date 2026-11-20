# Watchtower

Watchtower connects public-tender portals on its own, watches whether each one still delivers correctly, and repairs itself when a portal changes. Built for Patterno's challenge at the MAIN AI Hackathon 2026.

**Team: start with [docs/ONBOARDING.md](docs/ONBOARDING.md).**

## Run it

```bash
cp .env.example .env        # then fill in OPENAI_API_KEY, MODEL_SMART, MODEL_FAST
docker build -t watchtower .
docker run -p 8080:8080 --env-file .env watchtower
```

API on http://localhost:8080, dashboard at `/`. The key is passed at run time and never baked into the image.

Local development: `npm install`, `npx playwright install chromium` (once), then `npm run dev` (API) and `npm run dev:web` (dashboard).

## How it works

**The model proposes, code decides.** A model is used to learn a portal and to repair it. Reading a portal is plain code, so the regular work costs nothing in model usage and gives the same answer every time.

1. **Attach.** For a portal it has never seen, the Cartographer explores the site once and writes a **recipe**: a small JSON file that says where the tender list is (a feed, a JSON API, HTML or a page that needs a browser), how to page through it, where each field and each document is, and which time zone the portal uses. Code then reads the portal with that recipe and keeps a few **golden tenders**, real tenders it can check later.
2. **Read.** On a schedule (every 30 minutes by default) the Extractor runs the recipe. **No model call.** New and changed tenders get their documents downloaded, hashed (sha256) and unpacked if they are ZIPs. A big portal is served in batches: each read downloads at most 300 documents, newest tenders first, and the next read follows a minute later until all are in. A new tender is served only with its documents, never with an empty list that would look like "no documents".
3. **Notice.** Before anything is served, deterministic checks decide whether the read is correct: ids unique, dates and deadlines valid, URLs and CPV codes well formed, the number of tenders not collapsing, the page structure unchanged, and the golden tenders still matching. A portal that says "no tenders" is told apart from one that broke.
4. **Repair.** When the checks fail, the portal goes to `healing` and the last correct tenders stay available. The Medic shows the model what changed and gets back a small patch to the recipe. Code reruns the read with the patch and serves it only if every check passes, golden tenders included. If no patch passes, the portal goes to `failed` and says why.

Each portal is always in one of four states, with a one-sentence `reason` an operator can act on:

| State | Meaning | Example reason |
|---|---|---|
| `integrating` | Being attached, nothing delivered yet. | Attaching: learning how to read this portal. |
| `serving` | Delivering correctly. | Serving 23 open tenders (2 new, 1 changed). Last read 10:42, all checks passed. |
| `healing` | A read looked wrong; repairing while the last correct tenders stay served. | Repairing: no tender has a title (0 of 23). |
| `failed` | Cannot deliver; a person is needed. Logins and captchas end here. | Documents need a login: the portal shows a login page instead of the file. |

**Polite by construction.** Every request, from plain HTTP or from the headless browser, passes one gate per portal: at most one request every 1.1 seconds, robots.txt respected (Allow, Disallow, wildcards). No logins and no captcha solving. A portal that shows a captcha but still hands out its files is read normally; one that blocks is `failed`, and the reason says so. `DELETE` stops all traffic to a portal at once, open browser pages and downloads included.

**Documents.** Files stream to disk and are never held in memory. ZIPs are unpacked, one nested ZIP deep. Files over 250 MB are left out, checked from the declared size first and counted while streaming. Multi-step downloads (click through to the file) run in the browser. Each file is served from `/files/{sha256}`.

**Why this scales to many portals.** A recipe is data, not code, so a repair is a small reviewed patch and not a rewrite. Thousands of portals run on a few procurement software packages, and each recipe records its package (`family`), so the next portal on the same software can start from a recipe that already works. Reads cost $0 in model usage however many portals there are; the model is paid only when a portal is new or has changed.

## Environment variables

| Name | Required | Default | Meaning |
|---|---|---|---|
| `OPENAI_API_KEY` | yes | | Model key (OpenAI or any OpenAI-compatible provider). |
| `MODEL_SMART` | yes | | Model for attaching and repairing. We use `gpt-6.2-sol`. |
| `MODEL_FAST` | yes | | Model for triage. We use `gpt-6-luna`. |
| `OPENAI_BASE_URL` | no | OpenAI | Endpoint of an OpenAI-compatible provider. |
| `PRICE_SMART_IN`, `PRICE_SMART_OUT`, `PRICE_FAST_IN`, `PRICE_FAST_OUT` | no | 0 | USD per million tokens, so the cost ledger shows money and not only tokens. |
| `PORT` | no | 8080 | HTTP port. |
| `DATA_DIR` | no | `/data` in the container | SQLite database and downloaded files. |
| `READ_INTERVAL_MINUTES` | no | 30 | Time between regular reads of a serving portal. |
| `FAILED_RETRY_MINUTES` | no | 30 | Time between retries of a failed portal. |
| `DOC_REFS_PER_READ` | no | 300 | Document downloads per read at most; on a big portal the rest follow in reads one minute apart. |
| `MIN_REQUEST_GAP_MS` | no | 1100 | Gap between two requests to one portal; never below 1000. |
| `MAX_FILE_BYTES` | no | 262144000 (250 MB) | Largest document kept. |
| `USER_AGENT` | no | `WatchtowerBot/0.1 (...)` | How we identify ourselves to portals. |
| `TZ_DISPLAY` | no | `Europe/Berlin` | Time zone for times the system itself writes. |
| `LOG_LEVEL` | no | `warn` | Server log level. |

## What one portal costs in model usage

Every model call is recorded with its purpose, tokens and cost: `GET /internal/ledger` for all portals, `GET /internal/portals/{id}` for one.

| | Model calls | Cost per portal |
|---|---|---|
| Attach (once) | _measured before hand-in_ | _measured_ |
| Regular read | **0** | **$0** |
| Repair (per portal change) | _measured before hand-in_ | _measured_ |

**Per portal per month** = attach cost (once) + repair cost × number of portal changes that month. Reads add nothing.

First measurement: drafting a full recipe for TenderNed (Netherlands) from its real API answers took **1 call, 3,020 input and 800 output tokens: $0.014** with `gpt-6.2-sol` at $2 / $10 per million tokens.

## API

| Call | Answer |
|---|---|
| `POST /portals` `{ "url": ... }` | 201 with the portal; the same address twice gives the same id |
| `GET /portals`, `GET /portals/{id}` | Portals with `state`, `reason`, `tenderCount`, `lastSuccessAt` |
| `POST /portals/{id}/refresh` | 202 with a `runId` (the running job's, if one runs) |
| `GET /portals/{id}/tenders[?changedSince=]` | Tenders with their documents |
| `GET /portals/{id}/runs` | Reads and repairs, with results |
| `DELETE /portals/{id}` | 204; all traffic to the portal stops |
| `GET /files/{sha256}` | A document's bytes |
| `GET /` | Dashboard |

Exact shapes: `src/shared/contract.ts`. Every time has an offset, e.g. `2026-12-09T10:00:00+01:00`. Check a running server with `npm run test:contract`.
