# Watchtower: architecture

**Any tender portal in Europe. Attached on its own. Watched honestly. Repaired with proof.**

Requirements: `docs/BRIEF.md` (wins every conflict). Tasks and owners: `docs/TASKS.md`.

## 1. The problem from first principles

Patterno reads tenders from **4,500+ portals in 29 countries** and connects each one by hand. When a portal changes, its tenders "can stop arriving without anyone noticing" (Patterno brief). At that scale something breaks every day, so the fix is not more engineers. The fix is a cost per portal close to zero, and breakage that is noticed, explained and repaired on its own.

Three facts shape the design:

1. **Thousands of portals, a few software packages.** Many portals run the same e-procurement software under different addresses (the brief says so; cosinex powers DTVP and several German state portals). Learn the software once, reuse it many times.
2. **The dangerous failure is the silent one.** A scraper that returns nothing is easy to spot. One that returns plausible wrong values is not. The brief agrees: *"A wrong value is worse than a missing one"* and *"the state it reports matches what it delivers."*
3. **Models are expensive and unpredictable; code is cheap and repeatable.** The brief: use an LLM to learn, check and repair; regular reads should run without a model call.

**Principle: the model proposes, code decides.** The model writes and patches a recipe (data, not code). Deterministic code runs it, checks it, and has the final word on whether it may serve.

## 2. System

```
                    ┌──────────────────── one container, port 8080 ─────────────────────┐
 POST /portals ───► │ orchestrator (state machine, scheduler, 1 job per portal)         │
                    │    │                                                              │
                    │    ├─ attach ─► Cartographer (LLM) ─► Recipe v1 + golden records  │
                    │    ├─ read ───► Extractor (no LLM) ─► ReadOutcome                 │
                    │    ├─ judge ──► Watch.evaluate (no LLM) ─► healthy │ broken │ ... │
                    │    ├─ healthy ► DocumentFetcher ─► SQLite + /files ─► API         │
                    │    └─ broken ─► Medic (LLM patch) ─► Verifier (no LLM) ─► vN+1    │
                    │                                                                   │
                    │ politeness gate: ≤1 req/s per host, robots.txt, no login/captcha  │
                    │ dashboard (React) at GET /, internal data at /internal/*          │
                    └───────────────────────────────────────────────────────────────────┘
```

### State machine (the brief's four states)

| From | Event | To | Reason shown (example) |
|---|---|---|---|
| (new) | `POST /portals` | `integrating` | "Attaching: learning how to read this portal." |
| `integrating` | attach ok, checks pass | `serving` | "Serving 23 open tenders (23 new, 0 changed). Last read 10:42, all checks passed." |
| `integrating` | login or captcha | `failed` | "Blocked: tender documents need a login." |
| `serving` | read passes checks | `serving` | updated counts |
| `serving` | read fails checks | `healing` | "Repairing: no tender has a title (0 of 23)." Last correct tenders stay served. |
| `healing` | verified repair | `serving` | "Repaired: list moved from table to cards; 5 of 5 known tenders match." |
| `healing` | repair fails | `failed` | "Could not repair: ... A person is needed. Keeping the last 23 correct tenders." |
| any | portal unreachable after retries | `failed` | "Portal not reachable: HTTP 503. Trying again every 30 min." |
| `failed` | a later probe succeeds | `serving` | recovers without help |

Runs: the first attach is a `read`. Every repair is a `repair` run. `refresh` during a running job returns that job's `runId`.

## 3. Components

### Recipe (`src/shared/recipe.ts`, B)
An adapter as JSON, validated by zod. No code strings. It has a tier (feed, JSON API, HTML, browser; the most stable one wins), a time zone for local deadlines, the list request and pagination, field rules for the list and detail page, document hops for multi-step downloads, and the words that mean "no results" or "withdrawn". Because it is data, the Medic can patch it with a small diff, and a person can review it.

### Cartographer (B, uses the model)
1. Cheap discovery first: feeds, alternate links, the JSON API the page itself calls (network capture in Playwright), software fingerprint.
2. Follow summary pages to the real tender page (a brief trap).
3. Send the model a compressed page (accessibility tree or pruned DOM, repeated rows collapsed to two examples), never raw HTML.
4. Structured output: the Recipe schema. Dry-run with the Extractor and send exact errors back. At most 3 rounds.
5. Pin 3 to 5 golden records: real values that every future repair must reproduce.
6. Detect blocks (login forms, captcha widgets, 401/403) and report them in plain words. Try documents before declaring a captcha block: some portals show a captcha, yet the files download without it.

### Extractor (B, no model)
Runs a recipe through `ctx.http` or `ctx.browser`. Reads every list page, then detail pages only for new or changed tenders, so a refresh every few minutes stays cheap at 1 request per second. Normalizes dates with the portal's time zone, CPV codes without the check digit, and local procedure words. Returns diagnostics (field fill, page skeleton hash, empty-state text) for the Watch.

### Watch (C, no model)
Decides whether a read may be served: count against the baseline, field fill across the whole run, invariants (dates parse, deadline after publication, unique stable ids, valid CPV), golden-record recheck, and skeleton drift as an early warning. It also tells a real empty day ("Keine Ausschreibungen") from a broken list, and a block from an outage.

### Medic and Verifier (C, model for the patch only)
Triage with rules first. The model gets the old recipe, the failing checks and a structural diff of the old and new page, and returns a minimal patch. The patched recipe is run and must pass the Watch **and** reproduce the golden records before it serves anything. After 3 failed attempts it tries a fresh attach, then gives up with a clear reason. Every repair is stored as a new recipe version with a one-sentence summary and its cost.

### Documents (A)
Streams each file to disk with sha256 on the fly, never in memory. Unpacks ZIPs (each inner file becomes a document), leaves out anything over 250 MB (checked from `content-length` and while streaming, because ZIPs can exceed 1 GB), stores bytes by hash and serves them at `/files/{sha256}`. Browser downloads cover multi-step flows. Unchanged documents are never fetched twice.

### Politeness (A)
One gate per host, at least 1.1 s between requests, shared by HTTP and the browser (every browser request is routed through it; images, fonts and media are blocked). robots.txt is honored. No logins, no captcha solving, an honest User-Agent.

### Families (B, Should-have)
Fingerprint the software from URL paths, footer and generator tags. A portal on known software starts from the family recipe and attaches without a model call. This answers the brief's "Approach" question: the cost per portal falls as more portals are added.

## 4. Why this wins each judging point

| Judged on | Our answer |
|---|---|
| Attach | Most stable source first (JSON API over HTML), summary pages followed, documents including ZIPs and multi-step downloads, values left empty when unsure. |
| Notice | `serving` only after deterministic checks pass. Golden records catch plausible wrong values. Every state has a plain-language reason. |
| Repair | Minimal model patches, proven against golden records before serving. Last correct tenders served meanwhile. |
| Dashboard | One calm screen: state, reason, counts, last success; per portal, every read and repair with what changed and what it cost. |
| Approach | Reads cost $0 in model usage. Model cost only for attach and repair, measured per portal in the ledger. Families make each new portal cheaper. |

## 5. Stack

| Part | Choice | Why |
|---|---|---|
| Language | TypeScript, Node 22.13+ | Patterno's own backend language |
| Server | Fastify 5: API, files, static dashboard | Exact root paths, one process with the worker |
| Storage | SQLite via `node:sqlite`, file in `DATA_DIR` | Zero setup, one container |
| Browser | Playwright 1.65.1 Chromium, from the official image | Network capture, JS portals, downloads |
| Parsing | cheerio, jsonpath-plus | Deterministic reads |
| Schemas | zod 4 | API contract, recipe, model output |
| Model | OpenAI SDK, models set by env vars | Event credits; logged per call |
| Dashboard | React 19, Vite 8, Tailwind 4 | Built to static files, served at `/` |
| Container | `mcr.microsoft.com/playwright:v1.65.1-noble`, multi-stage | No browser download during the build |

Deliberately left out: Next.js, Supabase, n8n, user accounts, queues, Kubernetes, vector databases, agent frameworks. Each would be a part that could break during the test.

## 6. Cost model (for the README)

- **Read:** $0 in model usage, by design. Only HTTP at 1 request per second.
- **Attach:** a few model calls per portal (exploration, recipe, up to 3 corrections). Measured from the ledger.
- **Repair:** one triage call plus up to 3 patch calls. Measured from the ledger.
- **Per portal per month:** attach once, plus repairs times the expected number of portal changes. Show the formula and our measured numbers.

## 7. Risks

| Risk | Answer |
|---|---|
| A portal needs a login or shows a captcha | `failed` with a reason. Try documents first, because some download anyway. |
| The model proposes a wrong patch | Golden records must match, or nothing ships. |
| A real empty day looks like breakage | Empty-state text in the recipe and the Watch. |
| Large ZIPs | Streamed with a 250 MB cap, never in memory. |
| Base image Node too old for `node:sqlite` | The Dockerfile fails early; switch base or to better-sqlite3. |
| Refresh called every few minutes | Incremental reads: detail pages and documents only for new or changed tenders. |

## Sources
- Patterno challenge brief (PDF) and pitch, MAIN AI Hackathon 2026.
- [TED API](https://docs.ted.europa.eu/api/latest/index.html), [Datenservice Öffentlicher Einkauf](https://www.bescha.bund.de/DE/E-Beschaffung/Datenservice/Oeffentlicher-Einkauf_node.html), [DTVP](https://dtvp.de/vergabestellen/), [portal comparison](https://www.vergabe.bot/blog/vergabeportale-vergleich).
- Self-healing patterns: [Zyte](https://www.zyte.com/blog/what-is-a-self-healing-web-scraper/), [ScraperHub](https://github.com/ScraperHub/self-healing-scrapers-with-cloud-storage-fixtures-and-llm-fallback), [Stagehand](https://www.mintlify.com/browserbase/stagehand/concepts/how-stagehand-works).
- Patterno stack: [Founding Engineer post](https://applicant.notion.site/Founding-Engineer-Hamburg-Remote-31e2c0deef1c816bbc1af32da8cdcf30).
