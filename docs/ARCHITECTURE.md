# Watchtower: architecture and build plan

Patterno track, MAIN AI Hackathon 2026. Submission Saturday 10:30 on BuilderBase.

## What Patterno asked for

From the Patterno pitch and slides:

1. Give the system a portal URL. It works out by itself how to read tenders and their documents.
2. It serves active tenders through an API that Patterno calls.
3. It watches every portal, notices when one breaks or looks off, and repairs itself.
4. A dashboard shows all portals and their health ("a dashboard with a lot of green lights").
5. Everything ships as one container that runs the API and the dashboard.
6. Use LLMs for adapting and monitoring. Serve tenders **without** an LLM, so it stays cheap.
7. They grade it live on demo portals they built, and they change those portals on Saturday.
8. Bonus: which portals give the most coverage across Europe.

## The core idea

**The LLM writes a recipe once. Plain code runs it forever. When the recipe breaks, the LLM patches it, and plain code proves the patch before it goes live.**

Most teams will put an LLM in the extraction loop ("send HTML to GPT, get JSON"). That is slow, expensive, and silently wrong when the model guesses. Patterno said in the pitch that they want the opposite. Our design makes the LLM a mechanic, not the engine.

```
           onboarding (LLM)                     every run (no LLM)
URL --> Cartographer --> Recipe v1 --> Runner --> Tenders + Documents --> API
                                         |
                                         v
                                 Watchtower checks
                                 green | amber | red
                                         |
                                  amber/red only
                                         v
                       Medic (LLM) --> Recipe v2 candidate
                                         |
                              Shadow run + Verifier (no LLM)
                              pass --> promote v2    fail --> quarantine + alert
```

## Components

### 1. Recipe (the adapter as data, not code)

A recipe is a JSON document validated by a zod schema. The LLM never writes executable code. That makes adapters safe to run, easy to diff, and easy for the LLM to patch.

```jsonc
{
  "portal": "vergabe-hamburg",
  "version": 3,
  "source": { "kind": "json_api" },          // feed | json_api | html | browser
  "list": {
    "request": { "url": "https://.../api/search?page={page}", "method": "GET" },
    "pagination": { "type": "page_param", "start": 1, "stopWhen": "empty" },
    "items": "$.results[*]"                  // JSONPath, or CSS for html
  },
  "fields": {
    "externalId": { "from": "$.id" },
    "title":      { "from": "$.title" },
    "buyer":      { "from": "$.authority.name" },
    "deadline":   { "from": "$.deadline", "parse": "date", "locale": "de-DE" },
    "cpv":        { "from": "$.cpvCodes[*]" },
    "detailUrl":  { "from": "$.link", "absolute": true }
  },
  "detail": {
    "fields": { "description": { "css": "#beschreibung" } },
    "documents": { "css": "a[href$='.pdf'], a.download", "attr": "href" }
  },
  "politeness": { "minDelayMs": 1500, "respectRobots": true }
}
```

**Source tiers.** The Cartographer always tries the most stable source first:

1. **Feed**: RSS, Atom, OCDS or eForms XML. These almost never break.
2. **JSON API**: the XHR calls the portal's own frontend makes. We capture them during exploration with Playwright's network listener. These are far more stable than the DOM.
3. **Server-rendered HTML**: CSS selectors over plain HTTP.
4. **Browser**: a headless Playwright render, only when the content needs JavaScript.

A portal that redesigns its HTML often keeps its JSON API, so tiers 1 and 2 heal themselves without any LLM involved. This point goes in the pitch.

### 2. Cartographer (LLM onboarding agent)

Input: a portal URL. Output: Recipe v1 plus a set of golden records.

1. Fetch `robots.txt`, the sitemap and the page head. Look for feed links.
2. Open the page in Playwright and record all network traffic. Find the search or listing page, either from links or by letting the model click "Ausschreibungen", "Tenders", "Aanbestedingen" and so on.
3. Give the model a **compressed view** of the page: the DOM with text trimmed, repeated sibling structures collapsed, and the captured JSON responses. Do not send raw HTML.
4. The model returns a recipe through structured output (zod schema → JSON schema).
5. **Dry run** the recipe with the Runner. Check it with the Watchtower rules. If it fails, send the errors back to the model (at most 3 rounds).
6. Save 3 to 5 extracted tenders as **golden records**: real values we later use to prove that a repaired recipe extracts the same data.

### 3. Runner (deterministic, no LLM)

- Runs a recipe on a schedule (every N minutes per portal, configurable).
- Uses plain HTTP with `undici` for feed, JSON and HTML. Uses Playwright only for the `browser` tier.
- Normalizes everything into the canonical tender schema (below).
- Upserts by `(portal, externalId)`. Content-hashes each tender to detect changes and corrections.
- Downloads documents, stores them by SHA-256, and records size and MIME type. Unchanged documents are not downloaded again.
- Is polite: honors `robots.txt`, rate-limits per host, sends an honest User-Agent, and never bypasses captchas or logins. Portals that need a login get the status `restricted`, not a workaround.

### 4. Watchtower (health checks, no LLM)

Every run produces a health report. Each check is a few lines of code:

| Check | Catches |
|---|---|
| HTTP status and timing | Portal down, blocked, URL moved |
| Item count vs rolling baseline | Empty list after a redesign, broken pagination |
| Fill rate per field | A selector that now matches nothing |
| Value validity (dates parse, deadline after publish date, CPV format, URLs resolve) | A selector that matches the **wrong** element |
| Golden record recheck | Plausible but wrong values (the most dangerous failure) |
| Structural fingerprint of the list page | Early warning of a layout change, before data breaks |
| Document link reachability | Moved or renamed document storage |

Status: **green** means all checks pass. **Amber** means drift or partial loss, so we keep serving the last good data and start the Medic. **Red** means broken, so the data is marked stale and the Medic starts.

Checking each field across the whole run, not per page, catches the case where a cached selector still matches but returns wrong values. Zyte and others describe this as the main risk of self-healing scrapers.

### 5. Medic (LLM repair, verified by code)

1. **Triage**: classify the failure from the health report: `network`, `url_moved`, `layout_drift`, `pagination_changed`, `field_renamed`, `source_changed`, or `legitimately_empty`. Cheap rules come first, and the LLM is only used when they're ambiguous.
2. **Patch**: give the model the old recipe, the failing checks, and a **structural diff** between the last good snapshot and the current page. Ask it for a minimal patch to the recipe as a JSON Patch, not a full rewrite.
3. **Shadow run**: run the patched recipe without serving its output.
4. **Verify (no LLM)**: the patch must pass every Watchtower check **and** reproduce the golden records' values. If it doesn't, the Medic retries (at most 3 attempts), then falls back to a full Cartographer re-onboard.
5. **Promote or quarantine**: if it passes, the new version goes live with a stored diff. If it fails, the portal stays red with a plain-language diagnosis.

Every heal is a versioned recipe with a diff. The dashboard shows "the portal changed X, so we changed Y, verified against 5 golden records, cost $0.004."

### 6. Chaos lab (our proof that it works)

Patterno will change their demo portals on Saturday. We rehearse that ourselves first:

- Build 3 small **demo portals** in the repo: a plain HTML table, a JS-rendered list with a JSON API, and a paginated card layout with PDF documents.
- Build a **mutator** that applies realistic changes: renamed CSS classes, reordered columns, new wrapper divs, different pagination (pages → "load more" → infinite scroll), renamed JSON keys, a moved listing URL, and German date formats switched to ISO.
- Run an **eval**: mutate, wait for the Watchtower to detect it, let the Medic heal it, then score the result.

Show the scoreboard in the dashboard and the pitch: **detection rate, heal rate, median time to heal, LLM cost per heal, and false-heal rate (should be 0)**. Few teams will walk in with measured numbers, and Patterno's own test is a hidden version of this same lab.

## Canonical tender schema

Field names follow eForms business terms where possible, so the data matches what the EU standard uses:

| Field | eForms term | Notes |
|---|---|---|
| `externalId` | BT-04 procedure identifier (if present) | Else the portal's own ID |
| `title` | BT-21 title | |
| `description` | BT-24 description | |
| `buyerName` | BT-500 organisation name | |
| `cpv` | BT-262 main classification | Array of CPV codes |
| `publishedAt` | BT-05 dispatch date | ISO 8601 |
| `deadline` | BT-131 tender deadline | ISO 8601 with timezone |
| `estimatedValue` | BT-27 estimated value | Amount and currency |
| `placeOfPerformance` | NUTS code | When available |
| `documentsUrl` | BT-15 documents URL | |
| `documents[]` | | `{url, sha256, mime, bytes, fetchedAt}` |
| `sourceUrl`, `portalId`, `recipeVersion`, `firstSeenAt`, `lastSeenAt`, `contentHash` | | Lineage for every record |

Every tender records which recipe version extracted it. That gives full lineage, which is an easy professional win.

## API

Served from the same container. OpenAPI spec at `/api/docs`.

| Method and path | Purpose |
|---|---|
| `POST /api/portals` `{ url, name?, country? }` | Onboard a new portal. Returns `202` with a job ID. |
| `GET /api/portals` | All portals with status, last run, item count, recipe version |
| `GET /api/portals/:id` | Health history, recipe versions and diffs, heal log |
| `POST /api/portals/:id/run` | Run now |
| `POST /api/portals/:id/heal` | Force a Medic pass |
| `GET /api/tenders?portal=&active=true&since=&cpv=` | Active tenders, paginated |
| `GET /api/tenders/:id` | One tender with its documents |
| `GET /api/documents/:sha256` | The stored document file |
| `GET /api/events` | Server-sent events: live log for the dashboard |
| `GET /api/health` | Container health |

**Ask Patterno** for the exact request and response format they will call. Match it exactly.

## Dashboard

One screen, built for the "lots of green lights" moment:

- A **portal grid**: one tile per portal with a status light, last run, tender count, a 24-hour sparkline of item counts, and the source tier (feed, API, HTML or browser).
- An **"Add portal"** box: paste a URL and watch the Cartographer work live (steps streamed over SSE).
- A **heal timeline** per portal: red → triage → patch diff → verification → green, with the time and cost of each step.
- A **Chaos lab** tab: buttons to mutate a demo portal live in front of the judges, plus the eval scoreboard.
- A **cost meter**: total LLM spend for onboarding and heals vs $0 for serving.
- A **Europe coverage** view: which countries and how many active tenders each portal adds.

## Coverage strategy (the bonus question)

- **TED** (EU journal) covers every above-threshold tender in the EU. It has an official, anonymous search API (`POST https://api.ted.europa.eu/v3/notices/search`). One recipe covers all of Europe above the thresholds. Onboard it first.
- **Below-threshold** tenders only appear on national and regional portals. Germany alone has an estimated 180+ platforms (Patterno's own figure). That is where self-onboarding pays off.
- Good next portals: **TenderNed** (NL, has a public JSON API), **BOAMP** (FR, open-data API on Opendatasoft), **evergabe-online.de** (German federal platform), **DTVP** and **Subreport** (large German private platforms), and **Vergabe Hamburg**.
- **Deduplicate** tenders that appear on both TED and a national portal (match on procedure ID, then buyer + title similarity). Show "X% unique tenders added per portal". That turns the coverage question into a number.

## Tech stack

Matches Patterno's own stack (their engineering job posts ask for TypeScript and PostgreSQL), so the code is easy for them to adopt.

| Part | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | Patterno's backend language |
| App | Next.js 16 (dashboard and API route handlers) | One process for UI and API |
| Worker | Node process in the same container (scheduler + Runner + Medic) | Keeps long jobs out of request handlers |
| Browser | Playwright (Chromium) | Exploration, network capture, JS rendering |
| HTTP and parsing | undici, cheerio, jsonpath-plus | Fast deterministic tier |
| Validation | zod (recipe schema, tender schema, LLM structured output) | One source of truth |
| Database | PostgreSQL via Drizzle. **PGlite** embedded by default, `DATABASE_URL` for a real Postgres | One container, still Postgres |
| Documents | Local volume, content-addressed by SHA-256 | Simple, deduplicated |
| LLM | OpenAI (credits provided). A larger model for Cartographer and Medic, a small one for triage | LLM only where needed |
| Container | One Dockerfile, based on the official Playwright image, with `docker run -p 3000:3000` | What Patterno asked for |

Supabase is not needed for this track. Patterno must run the container on their own machines, so the database lives inside it.

## Team split (4 people)

| Person | Owns | First milestone |
|---|---|---|
| A | Recipe schema, Runner, DB, API | A hand-written recipe for one demo portal serves tenders through the API |
| B | Cartographer | Turns a URL into a working recipe for 2 demo portals and TED |
| C | Watchtower checks, Medic, Verifier | Detects and heals a renamed CSS class |
| D | Demo portals, mutator, dashboard, pitch video | 3 demo portals live and the portal grid showing real status |

Freeze the recipe schema and the canonical tender schema in the first hour. All four parts depend on them.

## Timeline (Friday to Saturday 10:30)

| By | Milestone |
|---|---|
| Fri 15:00 | Schemas frozen. Repo, Dockerfile and demo portal 1 running. |
| Fri 17:00 | One recipe runs end to end: demo portal → Runner → DB → API → dashboard tile. **Ugly is fine.** |
| Fri 20:00 | Cartographer onboards demo portals 1 and 2 and TED by itself. Watchtower checks green. |
| Fri 23:00 | Medic heals the first 3 mutation types and the Verifier proves them. |
| Sat 01:00 | **Record a backup video.** Commit. Container builds clean from scratch. |
| Sat 01:00 to 07:00 | Sleep in shifts. Whoever is awake runs the chaos eval and onboards real portals. |
| Sat 08:30 | Code freeze. Fresh `docker build` and run on a second laptop. |
| Sat 09:30 | Final 3-minute video recorded. |
| Sat 10:00 | Submit (form closes exactly at 10:30). |

## Pitch outline (3 minutes)

1. **Problem (20 s):** 180+ German portals, connected by hand, and adapters that go blind when a portal changes.
2. **Live add (40 s):** paste a portal URL and watch the Cartographer turn it green.
3. **Live break and heal (60 s):** press "mutate" in the Chaos lab, watch it go red, watch the Medic patch it, see the diff and "verified against 5 golden records", then green again.
4. **Proof (30 s):** the eval scoreboard (heal rate, time to heal, cost per heal, zero false heals) and the cost meter (serving is $0 LLM).
5. **Why it fits Patterno (30 s):** TypeScript and Postgres like their stack, recipes as data they can review, eForms-aligned schema, ready for production.

## Risks and answers

| Risk | Answer |
|---|---|
| A portal needs a login or has a captcha | Mark it `restricted` and explain why. Never bypass it. This also protects Patterno legally. |
| The LLM proposes a wrong patch | The Verifier must reproduce the golden records, or nothing ships. |
| Legitimately empty portal (no tenders today) | Triage checks for the "no results" text and a working search before calling it broken. |
| Their Saturday changes are bigger than our mutations | The Medic falls back to a full re-onboard with the Cartographer. |
| The container fails on their machine | Build it fresh on a second laptop before submitting. Pin all versions. |

## Questions to ask Patterno today

1. What exact API request and response format will you call?
2. Do the demo portals have documents (PDFs, ZIPs) we must fetch?
3. What kinds of changes will you make on Saturday: layout, URLs, pagination, rendering?
4. Do you run our container with network access to real portals, or only to your demo portals?
5. Is the internship or job fast track open for engineering roles in English? (Answered: English is fine.)

## Sources

- Patterno challenge slide and pitch recording (MAIN AI Hackathon 2026).
- TED Search API: [docs.ted.europa.eu/api](https://docs.ted.europa.eu/api/latest/index.html), [developers corner](https://ted.europa.eu/simap/developers-corner-for-reusers), [eForms reusers Q&A](https://op.europa.eu/en/web/ted-reusers-workshops/questions_and_answers_2024_04_17).
- German platform landscape: [OECD, Public procurement in Germany](https://oecd.org/en/publications/public-procurement-in-germany_1db30826-en/full-report/component-9), [Lower Saxony platform overview](https://www.mw.niedersachsen.de/download/223791/Uebersicht_Vergabeplattformen.pdf), [Patterno platform glossary](https://www.patterno.de/en/resources/akademie/glossar/vergabeplattform).
- TenderNed and BOAMP access: [n8n TenderNed workflow](https://n8n.io/workflows/10076-automate-dutch-public-procurement-data-collection-with-tenderned/), [TenderNed terms of use](https://www.tenderned.nl/cms/nl/node/689), [EU Public Tenders Monitor (TED and BOAMP)](https://apify.com/far003/eu-public-tenders.md).
- Self-healing scraper patterns: [Zyte, What is a self-healing web scraper](https://www.zyte.com/blog/what-is-a-self-healing-web-scraper/), [ScraperHub reference repo](https://github.com/ScraperHub/self-healing-scrapers-with-cloud-storage-fixtures-and-llm-fallback), [scrapemend](https://pypi.org/project/scrapemend/).
- Patterno stack: [Founding Engineer job post](https://applicant.notion.site/Founding-Engineer-Hamburg-Remote-31e2c0deef1c816bbc1af32da8cdcf30).
