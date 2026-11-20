# Recipe drafts for person B

Drafts made by person A while testing real portals end to end. They are inputs for B, not used by the app.

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
