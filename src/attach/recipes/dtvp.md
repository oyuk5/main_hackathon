# DTVP recipe (draft, hand-verified 2026-11-21, not registered in known.ts)

Portal: https://www.dtvp.de/Center/company/announcements/categoryOverview.do?method=showCategoryOverview
(Deutsches Vergabeportal, cosinex Vergabemarktplatz). robots.txt only disallows `/wp/wp-admin/`.
Explored with about 140 requests in total at ≤ 1 req/s (that count includes the cookie-banner host
`cookies.cosinex.de` and the tracker `load.s.dtvp.de` that the page loads). No login, no captcha.

## How the list is reached
- The start page only shows CPV category counts. The real search is a jQuery app (`TenderSearch` in
  `/Center/assets/scripts/search-min.js`): it POSTs JSON to `/Center/api/v2/project/search` and draws
  the rows with a Handlebars template into `#listTemplate`.
- **The JSON API cannot be used over plain HTTP:** a cold POST answers
  `403 {"message":"invalid token, try to reload the page"}`. The page's own first POST gets the same 403,
  reloads itself, and the second POST (now with the session cookie) answers 200. The browser does that
  dance on its own, so the browser tier works and the jsonApi tier does not.
- **No form steps are needed:** the search page restores a search from its URL hash, which is the
  search form as Base64 JSON (`Base64.encodeURI(JSON.stringify(form))`). The recipe's list URL is
  `/Center/common/project/search.do?method=showExtendedSearch&fromExternal=true#<hash>` with
  `{"cpvCodes":[],"contractingRules":["VOL","VOB","VSVGV","SEKTVO","OTHER"],"publicationTypes":["Tender"],
  "location":{},"pageNumber":1,"searchText":"","sort":{"order":[{"property":"PROJECT_PUBLICATION_DATE_LNG","direction":"DESC"}]}}`
  (only calls for tenders, `Tender`. Not `ExAnte` or `ExPost`. Newest first). Answer: 15,761 hits, 20 per page, 789 pages.
- Paging: `clickNext` on `#nextPage.browseForward` (on the last page the class becomes
  `browseForwardGhost`, so the selector stops matching). Each click is one API POST.
- Empty result text: "Es wurden keine passenden Bekanntmachungen gefunden."

## What it reads (live, 2 pages, 0 model calls, fieldFill 40/40 for every list field)
| id | title | buyerName | publicationDate | submissionDeadline |
|---|---|---|---|---|
| 2655644 | Tragwerksplanung | Gemeinde Zetel | 2026-11-20 | 2026-11-30T09:00:00+01:00 |
| 2655643 | Schnittstelle Bahnhof Bitterfeld Objekt 1+5: Vorplatz+ZOB | Stadt Bitterfeld-Wolfen | 2026-11-20 | 2026-12-01T09:00:00+01:00 |
| 2655641 | Sanierung Gleisanlagen Lange Straße zwischen Radeklint und Haus Nr. 4 | Braunschweiger Verkehrs-GmbH | 2026-11-20 | 2027-01-20T08:00:00+01:00 |

- `id` is DTVP's project id (`pid`). The deadline comes from the `abbr[title]` ("30.11.2026 um 09:00 Uhr"),
  local time in Europe/Berlin.
- `url` is built as `/Center/public/company/projectForwarding.do?pid={id}`. The search gives
  `/Center/secured/...?pid=` links, and **those always go to the Keycloak login** (`id.dtvp.de`), even for
  public tenders. The `/public/` variant goes to the tender's public Satellite page
  (`/Satellite/public/company/project/<CXP id>/de/overview`) **when the tender is public**. For a
  non-public tender it also goes to the login.
- Cost: one list read of 2 pages was 75 requests and 54 s, because the page loads about 25 scripts and styles and
  the 403 makes it load twice. Each further page is about 1 request. With `maxPages` 50 a read sees the
  1,000 newest of about 15,800 open tenders. **Known problem:** older open tenders are never listed, and they
  drop out of the list as newer ones arrive (same issue as TenderNed's demo limit).

## Detail page and documents
Checked offline against saved copies of the real pages, not live, to stay within the request budget:
- Detail (public Satellite overview): `referenceNumber` = "Ausschreibungs-ID" (e.g. `CXP4YM04YA7`),
  `cpvCodes` from "Auftragsgegenstand" (`34992200`, `45316213`, …).
- Documents: hop to `./documents` ("Teilnahmeunterlagen"), files are `a[href*='/documents/']`, without the
  `archive/…zip` that bundles them all. **For public tenders, the files download without a login.** Checked live:
  `…/documents/address/TNW_10_….pdf` answered 200 `application/pdf` (`%PDF-1.5`), and a stale
  `;jsessionid=` in the file URL still works from a new session. This contradicts the lab note that DTVP documents need a login.
  That note holds for **non-public** tenders: their tender page is the login page, so the detail fields
  are null and `documentRefs` is `[]`. The Extractor does not turn that login page into a block on its own.
- Of the first 3 search hits, 2 were checked and both are login-only (2655644, 2655641). From the CPV 45
  category table, about half of the tenders were `/public/`. So many DTVP tenders will have no documents.
- Cost per tender with detail and documents in the browser tier: the Satellite pages load their own
  styles and scripts, so expect roughly 20–40 requests per tender. Keep detail fetches capped.
