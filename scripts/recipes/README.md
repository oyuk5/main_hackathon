# Recipe drafts for person B

Drafts made by person A while testing real portals end to end. They are inputs for B, not used by the app.

Make more with `npx tsx --env-file=.env scripts/draft-recipe.ts <list URL> [...]` (set `DATA_DIR` to a scratch folder).
It explores the page in the polite browser, asks `MODEL_SMART` for a recipe (up to 3 calls), and keeps a draft only when
the list rules find tenders on the live portal without the model.

## Results so far (as of Fri 17:25)

| Portal | Country | Result | Model calls | Cost |
|---|---|---|---|---|
| TenderNed | NL | jsonApi draft, hand-checked, document download verified | 1 | $0.014 |
| e-Zamówienia (BZP board) | PL | jsonApi draft, 10 live items, 9 fields mapped (no `url`) | 1 | $0.039 |
| DTVP (cosinex) | DE | no draft: the search page shows a form, not a list | 3 | $0.018 |
| e-Vergabe (Bund) | DE | no draft: list URL answers HTTP 400 without a session cookie | 3 | $0.055 |
| BOAMP | FR | not tried: robots.txt disallows `/api/`, which the site needs | 0 | $0 |
| TED search | EU | not tried: robots.txt disallows `/*/search/result?` | 0 | $0 |

A working attach on a JSON-API portal costs about **$0.01–0.04** in one call; a portal the model cannot read costs up to about $0.06 before it gives up.

## tenderned.draft.json
TenderNed (https://www.tenderned.nl/aankondigingen/), public JSON API, robots.txt allows `/papi/`.
Drafted by `gpt-6.2-sol` from real responses (1 call, 3,020 in / 800 out tokens, $0.014), then checked by hand:
all list and detail rules resolve on 3 real tenders, and one real document (196,333 bytes) came through `documentFetcher` with sha256.

Fixed by hand:
- `procedureType` and `contractNature` now use `parse`; the raw values are Dutch
  (Openbaar → open, Niet-openbaar → restricted, Onderhandelingsprocedure… → negotiated; Werken → works, Diensten → services, Leveringen → supplies).
- Removed `placeOfPerformance`: the API gives a NUTS region name, not a city, and a wrong value is worse than none.

Open for B:
- The list mixes all publication types (e.g. `typePublicatie.code` REC = rectification) and closed tenders. Decide the filter for open calls.
- `maxPages` 50 × 50 = 2,500 of about 147,000 publications at 1 request/second. The newest come first.
- `detail.urlFrom` and the documents hop use a URL template with `{id}`; adjust to how the Extractor reads them.
- `withdrawnText` is a guess; the API also has `isVroegtijdigeBeeindiging` (true when ended early).
- `referenceNumber` (`kenmerk`) is a number in the JSON; the contract needs a string.

## ezamowienia.gov.pl.draft.json
Poland's procurement board (`mo-board/api/v1/Board/Search`), found by the model from the page's own JSON calls.

Open for B:
- No `url` field: the contract needs the tender's human page. Find its pattern from the tender id.
- `publicationDateFrom` is a fixed date in the list URL; it must slide (e.g. last 30 days).
- `procedureType` maps a code ("2.1"); `cpvCodes` carry a check digit and a label ("71322000-1 (Usługi…)"), so `parse: "cpv"` must strip them.
- `submissionDeadline` was filled for 2 of 5 items; check whether the detail answer has it.
- Documents not checked yet.
