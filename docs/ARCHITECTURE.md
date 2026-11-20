# Watchtower

**Any tender portal in Europe. Connected in a minute. Repairs itself. Proves every repair.**

Patterno track, MAIN AI Hackathon 2026. Submission Saturday 10:30 on BuilderBase.

---

## 1. The problem from first principles

Patterno says it aggregates tenders from **4,500+ portals across Europe** ([Patterno](https://www.patterno.de/en/vergabe-portale), [KI-Syndikat review](https://www.ki-syndikat.de/tools/patterno/)). Today every portal gets a hand-written adapter. When a portal changes, the adapter "goes blind" and an engineer fixes it by hand (Patterno pitch).

So maintenance cost grows with the number of portals. At 4,500 portals, even rare breakage means something is broken every day. Hiring more engineers doesn't fix that. The only real fix is to make **cost per portal close to zero** and **breakage boring**.

Our research found three facts that shape the whole design.

### Fact 1: there are thousands of portals, but only a few kinds of portal software

Most German portals run on a small number of commercial e-procurement products. cosinex's "Vergabemarktplatz" (VMP) powers DTVP and several state portals, such as Lower Saxony and Brandenburg. Others run Healy Hudson, subreport ELViS, Vergabe24 or aumass ([DTVP](https://dtvp.de/vergabestellen/), [portal comparison](https://www.vergabe.bot/blog/vergabeportale-vergleich), [Lower Saxony overview](https://www.mw.niedersachsen.de/download/223791/Uebersicht_Vergabeplattformen.pdf)). You can see the software in the URLs, for example `/Satellite/public/company/project/CX.../announcements/` on cosinex portals.

**Consequence:** don't learn 4,500 websites. Learn a few dozen **platform families**. Once one cosinex portal is learned, the next one should connect in seconds, with no LLM.

### Fact 2: notices are moving to central registries, but documents stay on the portals

- **TED** publishes every EU tender above the thresholds, with an official, anonymous search API ([TED API docs](https://docs.ted.europa.eu/api/latest/index.html), [developers corner](https://ted.europa.eu/simap/developers-corner-for-reusers)).
- Germany's **Bekanntmachungsservice** at oeffentlichevergabe.de collects national notices and publishes them as open data in eForms-DE, OCDS and CSV ([Beschaffungsamt](https://www.bescha.bund.de/DE/E-Beschaffung/Datenservice/Oeffentlicher-Einkauf_node.html), [open data policy](https://oeffentlichevergabe.de/ui/en/Open-Data-Richtlinie)).
- But the **tender documents** (the PDFs that decide whether a company can win) still live on each portal. Many municipal portals also don't follow the national standards ([OECD](https://oecd.org/en/publications/public-procurement-in-germany_1db30826-en/full-report/component-9)).

**Consequence:** central registries are useful in two ways. They're a **coverage backbone**. They're also an **independent source of truth** that tells us when a portal adapter is quietly missing tenders. Portal adapters are still needed for documents and for portals the registries miss.

### Fact 3: the dangerous failure is the silent one

A scraper that returns zero results is easy to spot. A scraper that returns **plausible but wrong** values, such as yesterday's deadline or the buyer name in the title field, damages trust for weeks before anyone notices. Practitioners name this as the main risk of self-healing scrapers ([Zyte](https://www.zyte.com/blog/what-is-a-self-healing-web-scraper/)).

**Consequence:** self-healing without proof is a liability. Every repair must be **verified by code** before it serves a single tender.

### The principle

> **The LLM proposes. Code decides.**
>
> AI explores, writes and repairs adapters. Plain, deterministic code runs them, checks them and has the final say. Serving tenders never touches an LLM.

This matches what Patterno asked for in the pitch: LLMs for adapting and monitoring, no LLM for serving.

---

## 2. What the judges will see

Three moments, each under a minute.

1. **Connect.** Paste a portal URL. A live log shows the agent exploring. The tile turns green, with real tenders and documents. *Target: under 60 seconds.*
2. **Break and heal.** Press "Mutate" on a demo portal: rename classes, change pagination, move the URL. The tile goes red, then the repair appears as a readable diff with "verified against 5 known tenders". Green again. *Target: under 30 seconds, about one cent.*
3. **Scale.** Paste a second portal built on the same software family. It turns green in two seconds with **no LLM call and $0**. That's what 4,500 portals looks like.

Then one screen of numbers from our own chaos tests: detection rate, heal rate, time to heal, cost per heal and false-heal rate.

---

## 3. System overview

```
                      ┌──────────────────────── one container ───────────────────────┐
  POST /api/portals → │  Cartographer ──► Recipe vN ──► Runner ──► Postgres ──► API   │
                      │   (LLM, once)      (JSON)      (no LLM)     (tenders,          │
                      │        ▲                          │          documents,        │
                      │        │                          ▼          lineage)          │
                      │   Family library             Watchtower                        │
                      │   (cosinex, ...)          (checks, no LLM)                     │
                      │        ▲                          │ amber / red                │
                      │        │                          ▼                            │
                      │   learned families ◄──── Medic (LLM patch)                     │
                      │                               │                                │
                      │                         Verifier (no LLM)                      │
                      │                    pass: promote   fail: quarantine            │
                      │                                                                │
                      │  Registry oracle: TED + Bekanntmachungsservice → recall check  │
                      │  Dashboard (Next.js) · live events over SSE · Chaos lab        │
                      └────────────────────────────────────────────────────────────────┘
```

---

## 4. Components

### 4.1 Recipe: the adapter as data

An adapter is a **JSON recipe**, validated by a zod schema. The LLM never writes executable code. That makes recipes safe to run, easy to read in a code review, small to diff, and easy to patch.

```jsonc
{
  "portal": "vergabe-niedersachsen",
  "family": "cosinex-vmp",                 // null if unknown
  "version": 4,
  "source": { "tier": "json_api" },        // feed | json_api | html | browser
  "list": {
    "request": { "url": "https://…/search?page={page}", "method": "GET" },
    "pagination": { "type": "page_param", "start": 1, "stopWhen": "empty" },
    "items": "$.results[*]"                // JSONPath for JSON, CSS for HTML
  },
  "fields": {
    "externalId": { "from": "$.id" },
    "title":      { "from": "$.title" },
    "buyerName":  { "from": "$.authority.name" },
    "deadline":   { "from": "$.deadline", "parse": "date", "locale": "de-DE" },
    "cpv":        { "from": "$.cpvCodes[*]" },
    "detailUrl":  { "from": "$.link", "absolute": true }
  },
  "detail": {
    "fields":    { "description": { "css": "#beschreibung" } },
    "documents": { "css": "a[href$='.pdf'], a.download", "attr": "href" }
  },
  "politeness": { "minDelayMs": 1500, "respectRobots": true }
}
```

**Source tiers.** We always pick the most stable source the portal offers:

| Tier | What | Why it's ranked here |
|---|---|---|
| 1. Feed | RSS, Atom, OCDS or eForms XML | Built for machines. Almost never changes. |
| 2. JSON API | The XHR calls the portal's own frontend makes, captured with Playwright's network listener | Redesigns change the HTML, but usually keep the API. |
| 3. HTML | CSS selectors over plain HTTP | Fast, but breaks on redesigns. |
| 4. Browser | Headless Chromium render | Only when the content needs JavaScript. |

Most portals that "break" only break at tier 3. A tier-2 recipe often survives a full redesign untouched. This point goes in the pitch.

### 4.2 Family library: learn the software, not the website

- **Fingerprint** each new portal with cheap signals: URL patterns, cookie and script names, generator meta tags, footer text, characteristic CSS class names. No LLM.
- If the fingerprint matches a known family, start from the **family template** and fill in only the portal-specific parts (base URL, language). Dry-run it. If it passes, we're done: **seconds, zero LLM cost**.
- Every time the Cartographer learns a new portal from scratch, it **promotes the reusable part into a family template**. The system gets cheaper with every portal it learns.
- Hackathon scope: ship the **cosinex VMP** family (used by DTVP and several state portals) plus one family from Patterno's demo portals. Show the second-portal-in-two-seconds moment.

### 4.3 Cartographer: onboarding agent (LLM)

Input: a URL. Output: a working recipe and a set of golden records.

1. **Look for the easy wins:** `robots.txt`, sitemap, `<link rel="alternate">` feeds, OCDS endpoints, and the family fingerprint.
2. **Explore:** open the page in Playwright and record all network traffic. Find the listing, either from link text in German, Dutch, French, English and so on ("Ausschreibungen", "Aanbestedingen", "Avis", "Tenders"), or by letting the model choose the next click.
3. **Compress before you prompt:** send the model the accessibility tree and a pruned DOM (repeated rows collapsed to 2 examples, text trimmed), plus the captured JSON responses. Never send raw HTML. It's cheaper, faster and more accurate. Stagehand's design makes the same choice ([Stagehand](https://www.mintlify.com/browserbase/stagehand/concepts/how-stagehand-works)).
4. **Write the recipe** through structured output (the zod recipe schema compiled to a JSON schema).
5. **Dry run and correct:** the Runner executes it and the Watchtower checks the result. The model gets back exact errors ("deadline: 0/20 parsed; sample value '12.12.2026 10:00 Uhr'"). At most 3 rounds.
6. **Pin golden records:** store 3 to 5 extracted tenders with their exact field values. They become the proof for every future repair.

### 4.4 Runner: deterministic execution (no LLM)

- Runs each recipe on a schedule. Uses plain HTTP (`undici`) for tiers 1 to 3 and Playwright only for tier 4.
- Normalizes into the canonical schema (section 5), upserts by `(portalId, externalId)` and stores a content hash to detect changes and corrections.
- Downloads documents into storage addressed by SHA-256. Unchanged documents are never fetched twice.
- Is polite by default: honors `robots.txt`, rate-limits per host, backs off on errors, sends an honest User-Agent. **Never** bypasses logins or captchas. Those portals get the status `restricted` with an explanation. That keeps Patterno on the right side of every portal's terms.

### 4.5 Watchtower: health checks (no LLM)

| Check | What it catches |
|---|---|
| Status codes, timing, redirects | Portal down, blocking us, URL moved |
| Item count against a rolling baseline | Empty list after a redesign, broken pagination |
| Fill rate per field, **across the whole run** | A selector that matches nothing |
| Invariants: dates parse, deadline after publish date, CPV format, IDs unique, URLs resolve | A selector that matches the **wrong** element |
| Golden-record recheck | Plausible but wrong values |
| Structural fingerprint of the listing page | Layout change, flagged **before** data breaks |
| Document reachability | Moved document storage |
| **Registry recall** (4.7) | The portal quietly drops tenders |

States: **green** (healthy), **amber** (drift or partial loss: keep serving the last good data and start the Medic), **red** (broken: mark data stale and start the Medic), **restricted** (login or captcha: we don't go there).

### 4.6 Medic and Verifier: repair with proof

1. **Triage** without an LLM where possible: `network`, `url_moved`, `layout_drift`, `pagination_changed`, `field_renamed`, `source_changed` or `legitimately_empty`. "Legitimately empty" matters: a portal with no tenders today is not broken, so we check for its "no results" message and a working search first.
2. **Patch:** the model gets the current recipe, the failing checks, and a **structural diff** between the last good snapshot and the current page. It returns a minimal **JSON Patch**, not a rewrite. Small patches are easier to verify and to read.
3. **Shadow run:** the patched recipe runs without serving anything.
4. **Verify, with no LLM:** every Watchtower check must pass, **and** the golden records must come back with identical values. No pass, no promotion.
5. **Escalate:** up to 3 patch attempts, then a full Cartographer re-onboard, then quarantine with a plain-language diagnosis for a human.
6. **Record:** each promotion is a new recipe version with its diff, its trigger, its verification result and its cost. Every heal is reviewable afterward.

### 4.7 Registry oracle: an independent truth check

TED and the Bekanntmachungsservice notices include links back to the portal that hosts the documents (eForms BT-15, the documents URL). So for each portal we know roughly **which tenders it should be showing**.

- **Recall check:** the share of registry notices for this portal that our adapter also found. If recall drops from 98% to 60% while every other check is green, something is silently wrong. No other team will have this signal.
- **Coverage map:** count notices by documents-URL host to rank which portals matter most. The result is a coverage curve: "the top N portals cover X% of German notices". That answers Patterno's coverage question with measured data, and it tells them which portals to onboard next.
- **Hackathon scope:** load TED results and one daily Bekanntmachungsservice export, then compute the host ranking. *Verify the export endpoint in their Swagger docs first. Third-party wrappers mention `/api/notice-exports`.*

### 4.8 Chaos lab: proof before Patterno tests us

Patterno will change their demo portals on Saturday. We rehearse it first, and measure it.

- **Three demo portals** in the repo, each a different shape: a server-rendered table, a JS app over a JSON API, and paginated cards with PDF documents.
- **A mutator** with realistic changes: renamed classes, reordered columns, extra wrapper elements, pagination switched (pages → "load more" → infinite scroll), renamed JSON keys, a moved listing URL, date format changes, a cookie banner, and an empty-results day.
- **An eval runner:** mutate, detect, heal, verify, score. It runs as a script and from the dashboard.
- **The scoreboard:** detection rate, heal rate, median time to heal, LLM cost per heal, and **false heals, which must be 0**.

---

## 5. Canonical tender schema

Field names follow eForms business terms where they apply, so the data maps to the EU standard.

| Field | eForms | Notes |
|---|---|---|
| `externalId` | BT-04 procedure identifier | Else the portal's own ID |
| `title` | BT-21 | |
| `description` | BT-24 | |
| `buyerName` | BT-500 | |
| `cpv[]` | BT-262 | |
| `publishedAt` | BT-05 | ISO 8601 |
| `deadline` | BT-131 | ISO 8601 with timezone |
| `estimatedValue` | BT-27 | `{amount, currency}` |
| `placeOfPerformance` | NUTS | When available |
| `documentsUrl` | BT-15 | Also the key for the registry oracle |
| `documents[]` | | `{url, sha256, mime, bytes, fetchedAt}` |
| `portalId`, `sourceUrl`, `recipeVersion`, `firstSeenAt`, `lastSeenAt`, `contentHash` | | Lineage on every record |

Every tender can answer "where did you come from, and which version of which recipe extracted you".

---

## 6. API

Same container. OpenAPI spec at `/api/docs`. **Ask Patterno for their exact format and match it.**

| Endpoint | Purpose |
|---|---|
| `POST /api/portals` `{url, name?, country?}` | Onboard a portal. Returns `202` and a job ID. |
| `GET /api/portals` | All portals: status, tier, family, last run, counts, recall |
| `GET /api/portals/:id` | Health history, recipe versions and diffs, heal log |
| `POST /api/portals/:id/run` · `/heal` | Run or repair now |
| `GET /api/tenders?portal=&active=true&since=&cpv=&country=` | Active tenders, cursor pagination |
| `GET /api/tenders/:id` | One tender with documents and lineage |
| `GET /api/documents/:sha256` | Stored document |
| `GET /api/events` | Server-sent events for the live dashboard |
| `GET /api/health` | Container health |

---

## 7. Dashboard: designed, not assembled

Design principles: one screen, calm by default, loud only when something is wrong. Status is shown by color and motion, never only by text. Every number can be clicked through to its evidence.

- **Status wall:** one tile per portal with a status light, a 24-hour item-count sparkline, a tier badge (Feed, API, HTML, Browser), a family badge and the recall percentage. When everything is green, the screen should feel almost empty. That calm is the point.
- **Add portal:** a single input. The agent's steps stream in as a short live log that a judge can read.
- **Heal timeline:** red → triage → patch (a diff with old and new values) → verification (golden records ✓) → green. Each step shows its time and cost.
- **Chaos lab:** mutation buttons per demo portal, and the eval scoreboard.
- **Ledger:** total LLM spend, split into onboarding and heals, next to **$0 for serving**.
- **Coverage:** a map of Europe and the coverage curve from the registry oracle.

Use the `frontend-design` skill in `.claude/skills/` for the visual pass. Pick one typeface, one accent color and generous spacing. Avoid the default component-library look.

---

## 8. Tech stack

Matches Patterno's own stack: their engineering posts ask for TypeScript and PostgreSQL ([Founding Engineer post](https://applicant.notion.site/Founding-Engineer-Hamburg-Remote-31e2c0deef1c816bbc1af32da8cdcf30)).

| Part | Choice |
|---|---|
| Language | TypeScript end to end |
| App | Next.js 16: dashboard plus API route handlers |
| Worker | A separate Node process in the same container: scheduler, Runner, Cartographer, Medic |
| Browser | Playwright with Chromium (official Playwright base image) |
| Parsing | undici, cheerio, jsonpath-plus |
| Schemas | zod: recipe, tender, and LLM structured output |
| Database | Postgres through Drizzle. Embedded **PGlite** by default, or a real Postgres through `DATABASE_URL` |
| Documents | Local volume, addressed by SHA-256 |
| LLM | OpenAI (event credits). A strong model for Cartographer and Medic, a small one for triage. Log the cost of every call. |
| Shipping | One Dockerfile. `docker run -p 3000:3000 watchtower` starts everything. |

**What we deliberately don't build:** login or captcha bypass, user accounts, Kubernetes, a vector database, an agent framework, Supabase. Every part we skip is a part that can't break during the demo.

---

## 9. Plan

### Priorities

| Must (the demo fails without it) | Should (makes us win) | Could (if time allows) |
|---|---|---|
| Recipe schema and Runner | Chaos lab and scoreboard | Registry recall check |
| Cartographer for tiers 2 to 4 | Family library with cosinex | Coverage curve and map |
| Watchtower checks and states | Heal timeline with diffs | TED as an onboarded portal |
| Medic and Verifier with golden records | Cost ledger | Document change detection |
| API, status wall, one container | Polished visual design | |

### Team

| Person | Owns |
|---|---|
| A | Recipe schema, Runner, database, API, Dockerfile |
| B | Cartographer and family library |
| C | Watchtower, Medic, Verifier, registry oracle |
| D | Demo portals, mutator, dashboard, pitch video |

**Freeze the recipe schema and the tender schema in the first hour.** Everyone builds against them.

### Timeline (Friday to Saturday 10:30)

| By | Milestone |
|---|---|
| Fri 15:00 | Schemas frozen. Repo, Dockerfile, demo portal 1 live. |
| Fri 17:00 | **Walking skeleton:** a hand-written recipe → Runner → DB → API → a green tile. Ugly is fine. |
| Fri 20:00 | Cartographer onboards demo portals 1 and 2 by itself. |
| Fri 23:00 | Medic heals the first 3 mutation types, and the Verifier proves each heal. |
| Sat 01:00 | **Backup video recorded.** Clean `docker build` from scratch passes. |
| Sat 01:00 to 07:00 | Sleep in two shifts. The awake pair runs the chaos eval, adds the cosinex family and real portals. |
| Sat 08:30 | Code freeze. Build and run on a second laptop. |
| Sat 09:30 | Final 3-minute video. |
| Sat 10:00 | Submit. The form closes exactly at 10:30. |

---

## 10. Pitch (3 minutes)

1. **The problem in one number (15 s):** "Patterno reads 4,500 portals. Each one breaks eventually. Today a person fixes it."
2. **Connect (35 s):** paste a URL, green in under a minute.
3. **Break and heal (50 s):** mutate live, red, the repair as a diff, "verified against 5 known tenders", green.
4. **Scale (25 s):** a second portal of the same family, green in two seconds, $0.
5. **Proof (30 s):** the chaos scoreboard and the ledger. Serving costs $0 in LLM.
6. **Why Patterno can ship it Monday (25 s):** TypeScript and Postgres like their stack, recipes they can review, an eForms-aligned schema, one container.

---

## 11. Risks

| Risk | Answer |
|---|---|
| Login or captcha portal | `restricted` status with a reason. Never bypassed. |
| The LLM proposes a wrong patch | Nothing ships without golden-record verification. False heals must stay at 0. |
| A portal is legitimately empty | Triage confirms the empty-results state before calling it broken. |
| Saturday's changes are larger than our mutations | Fall back to a full re-onboard, then quarantine with a diagnosis. |
| The registry export endpoint differs | It's a "Could" item. Cut it and nothing else is affected. |
| The container fails on Patterno's machine | Pinned versions, a fresh build on a second laptop, `GET /api/health`. |

## 12. Questions for Patterno today

1. What exact request and response format will you call?
2. Do the demo portals have documents we must download?
3. What kinds of changes will you make on Saturday?
4. Will the container have internet access to real portals, or only to your demo portals?
5. How many demo portals, and do any need JavaScript rendering?

---

## Sources

- Patterno challenge slide and pitch recording, MAIN AI Hackathon 2026.
- Patterno scale: [Patterno portal overview](https://www.patterno.de/en/vergabe-portale), [KI-Syndikat review](https://www.ki-syndikat.de/tools/patterno/), [LinkedIn](https://linkedin.com/company/patterno).
- Platform software: [DTVP for contracting authorities](https://dtvp.de/vergabestellen/), [portal comparison](https://www.vergabe.bot/blog/vergabeportale-vergleich), [Patterno portal list 2026](https://www.patterno.de/de/resources/blog/vergabeportale-deutschland-ueberblick), [Lower Saxony platform overview](https://www.mw.niedersachsen.de/download/223791/Uebersicht_Vergabeplattformen.pdf).
- Central registries: [TED API](https://docs.ted.europa.eu/api/latest/index.html), [TED developers corner](https://ted.europa.eu/simap/developers-corner-for-reusers), [eForms reusers Q&A](https://op.europa.eu/en/web/ted-reusers-workshops/questions_and_answers_2024_04_17), [Datenservice Öffentlicher Einkauf](https://www.bescha.bund.de/DE/E-Beschaffung/Datenservice/Oeffentlicher-Einkauf_node.html), [open data policy](https://oeffentlichevergabe.de/ui/en/Open-Data-Richtlinie), [vergabe-api wrapper](https://github.com/applehorsefrog/vergabe-api).
- Fragmentation: [OECD, Public procurement in Germany](https://oecd.org/en/publications/public-procurement-in-germany_1db30826-en/full-report/component-9).
- Self-healing patterns: [Zyte](https://www.zyte.com/blog/what-is-a-self-healing-web-scraper/), [ScraperHub reference](https://github.com/ScraperHub/self-healing-scrapers-with-cloud-storage-fixtures-and-llm-fallback), [scrapemend](https://pypi.org/project/scrapemend/), [Stagehand caching](https://docs.stagehand.dev/v4/best-practices/caching), [how Stagehand works](https://www.mintlify.com/browserbase/stagehand/concepts/how-stagehand-works).
- Patterno stack: [Founding Engineer post](https://applicant.notion.site/Founding-Engineer-Hamburg-Remote-31e2c0deef1c816bbc1af32da8cdcf30).

Figures from vendors (portal counts, platform usage) are self-reported and unverified.
