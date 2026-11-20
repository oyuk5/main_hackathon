# Patterno brief: the requirements (source of truth)

Condensed from Patterno's official challenge PDF. If anything here conflicts with another doc, **this file wins**. If this file is unclear, ask Patterno at mentoring and write the answer under "Answers from Patterno".

## The three jobs
1. **Attach.** Given only the address of a portal it has never seen, deliver every open tender it lists and each tender's documents.
2. **Notice.** Know when a portal stops delivering correctly, and say so. If it cannot be repaired, say that too.
3. **Repair.** Get back to correct delivery after the portal has changed.

**Nobody may help the system while it runs.**

## How they judge
They run our container themselves, on portals it has never seen: private ones they built, and real ones.
- **Attach:** tenders and documents delivered correctly from an unseen portal.
- **Notice:** the state it reports matches what it delivers.
- **Repair:** correct delivery again after a portal has changed.
- **Dashboard:** an operator sees which portals deliver, which broke, and what the system did about it.
- **Approach:** how well it would work on many more portals, and what one portal costs in model usage.

## Rules
- Any language, framework and model. Read model keys from **environment variables**, name them in the README, and give the values at hand-in.
- Use an LLM to learn how a portal is read, to check it and to repair it. **Regular reads should ideally run without a model call.**
- **No steering.** No person and no service of ours may direct the system during the run.
- **Be polite to real portals:** at most **1 request per second per portal**, **no logins**, **no captcha solving**.

## What we hand in (deadline Saturday 10:30, BuilderBase)
- A Git repo with a **Dockerfile at its root**. `docker build .` must work on **linux/amd64** and build reasonably fast on small to medium machines. The default command starts the API and dashboard on **port 8080**.
- A **README**: how the system works on one page, which env vars it needs, and what one portal costs in model usage.
- A **video of at most 3 minutes** showing the system at work, including the dashboard.
- (MAIN, for every team) Project name, the code, and the 3-minute pitch video.

## API: exact answers
Every answer is JSON, except the dashboard and a document's bytes. A list is a JSON array. No authentication. An unknown id answers **404**. Every time is a date and time **with offset**, e.g. `2026-12-09T10:00:00+01:00`.

| Call | Answer |
|---|---|
| `POST /portals` body `{ "url": "…" }` | At once **201** `{ "id": "…" }`, then attach in the background. **The same address twice returns the same id.** |
| `GET /portals` | **200**, list. Each entry: `id`, `url`, `state`, `reason` (in words), `tenderCount`, `lastSuccessAt` or `null`. |
| `GET /portals/{id}` | One entry, same shape. |
| `DELETE /portals/{id}` | **204**. The system stops calling the portal within a minute. |
| `POST /portals/{id}/refresh` | At once **202** `{ "runId": "…" }`. **If a read is already running, answer with its runId.** They may call this every few minutes. |
| `GET /portals/{id}/tenders` | **200**, list of tenders. With `?changedSince=…`, only tenders whose `lastChangedAt` is later. |
| `GET /portals/{id}/runs` | **200**, list. Each run: `id`, `kind` (`read` or `repair`), `startedAt`, `finishedAt` or `null`, `result` (`ok`, `failed`, or `null` while running). **The first attach is a `read`.** |
| `GET /` | The dashboard. |

### Portal states
| State | Meaning |
|---|---|
| `integrating` | Being attached. Nothing delivered yet. |
| `serving` | Delivering correctly. |
| `healing` | Broken. A repair is running. **Keep serving the last correct tenders.** |
| `failed` | Cannot deliver. A person is needed. **A login or captcha block is `failed`, and `reason` says so.** |

### Every field of a tender
| Field | | Meaning |
|---|---|---|
| `id` | required | The portal's own identifier. Stays the same every read. |
| `url` | required | Address of the tender's page. |
| `title` | required | As the portal states it. |
| `buyerName` | required | The public body that buys. |
| `publicationDate` | required | A date, e.g. `2026-11-20`. |
| `submissionDeadline` | required | Date and time with offset. |
| `status` | required | `open`. `closed` once the deadline passed or the portal no longer lists it. `withdrawn` when the buyer cancelled it. |
| `documents` | required | List. Each file: `fileName`, `sizeBytes`, `sha256`, `path` on our API that returns its bytes (e.g. `/files/ab12`). **Unpack ZIP files.** May leave out a file over 250 MB, a ZIP included. |
| `lastChangedAt` | required | When we last saw this tender change. |
| `referenceNumber` | if shown | The buyer's file number. |
| `description` | if shown | What is bought. |
| `procedureType` | if shown | `open`, `restricted`, `negotiated` or `other`. |
| `contractNature` | if shown | `works`, `services` or `supplies`. |
| `cpvCodes` | if shown | List of strings, 8 digits, **no check digit**: `45000000`, not `45000000-7`. |
| `placeOfPerformance` | if shown | Object with `postalCode`, `city`, `countryCode` (two letters, e.g. `DE`). |

**Send `null` for a required field the portal does not show, and leave out the others. A wrong value is worse than a missing one.**

The machine-readable version is `src/shared/contract.ts`.

## Building a test set (they give no list)
- **Where to find portals:** ted.europa.eu (open recent notices for a country; the documents address in a notice is the portal). National sites: oeffentlichevergabe.de (DE), boamp.fr (FR), contrataciondelestado.es (ES), tenderned.nl (NL). Search in the local language: *Vergabeplattform Vergabeunterlagen*, *marchés publics DCE*, *licitaciones pliegos*, *przetargi dokumentacja*.
- **A good test set:** each portal has a public tender list and at least 5 open tenders whose documents download without login. At least **4 countries** and **3 different portal software packages** (same software often runs under different addresses: check the URL path or footer). Mix server-rendered pages, JavaScript apps (check the network tab for a JSON API) and **multi-step downloads**. Add 1 or 2 portals whose documents need a login or captcha, to test that we report the block. Keep a few portals unseen until the final test.

## Traps Patterno meets every week
- Links in notices often lead to a **summary page, not the tender**.
- Deadlines are shown in **local time**.
- **ZIP files can be larger than 1 GB.**
- Some portals **show a captcha, yet the documents download without it**.

## Prize
The winning system goes into production. The winning team is fast-tracked to an internship or a job at Patterno (English is fine).

## Answers from Patterno
_Write answers from mentoring here, with the date and who said it._

- Fri kickoff (team notes): they call our API from their own setup and grade it against portals they built, plus real ones. They will help the winning team run it in production; the visit to Hamburg is covered.

### Open questions (ask at mentoring, then move the answer above)
1. How often will they call `refresh`, and how long is the test run? (Sets our read interval and how many detail pages we can afford at 1 req/s.)
2. Do their private portals change **during** the test run, or are the changed versions separate portals?
3. Will our container reach their portals over the public internet, or a local network? Any proxy?
4. Does `closed` need to stay in `/tenders` once the portal stops listing it, and for how long?
5. Do they judge document **completeness** (every file) or a sample? How do they treat files we skipped over 250 MB?
6. Which model do they expect us to use at hand-in, and are event credits enough, or should we give our own key?
7. For the internship/job track: do engineering roles need German, or only go-to-market?
