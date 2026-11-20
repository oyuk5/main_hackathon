# TenderNed recipe (hand-verified 2026-11-20)

Portal: https://www.tenderned.nl/aankondigingen/overzicht (NL national portal). Public JSON API under
`/papi/tenderned-rs-tns/v2/`, no login. robots.txt (redirects to `/cms/robots.txt`) disallows only `/cms/*`,
`/core/`, `/profiles/`, admin and user paths; `/papi/` is allowed. Probed with about 35 requests at ≤ 1 req/s.
Fixtures in `tenderned.fixtures/`: 3 list items (two open AAO, one ended early), detail and documenten of 450237.

## Decisions
1. **Open calls only, filtered server-side.** `publicatieType=AAO` (Aankondiging opdracht) is the call for
   tenders. Other `typePublicatie.code` values: REC rectification, AGO award, VAK prior information,
   MAC market consultation, VBE ended early. The `publicatieType=AAO` filter also returns AAO notices that
   were later ended early: they show up as `typePublicatie.code = VBE` with `isVroegtijdigeBeeindiging: true`
   (that is how the withdrawn ones come in). `sluitingsDatumVanaf=YYYY-MM-DD` keeps tenders whose deadline is on or after
   that date. `typePublicatie=`, `sort=` and `sluitingsDatumVanaf=today` don't work (ignored, ignored, 404).
   Repeat `publicatieType=` to ask for several types; a comma list gives 422.
   The URL uses `sluitingsDatumVanaf={today}` (the Extractor fills in today's date in Europe/Amsterdam;
   the literal word `today` gives 404).
   **DEMO LIMIT: only calls published in the last 7 days.** `publicatieDatumVanaf=YYYY-MM-DD` works
   (inclusive; checked 2026-11-20: 2,927 open AAO without it, 204 with `2026-11-13`, last page all
   `2026-11-13`). `publicatieDatumVan=` is ignored. The URL adds `&publicatieDatumVanaf={daysAgo:7}`,
   because a full first read of all 2,927 takes about 8 h at 1 req/s (team lead's decision).
   **Known problem:** open tenders published more than 7 days ago are never delivered, and a tender we
   stored earlier drops out of the list once it is older than 7 days although it is still open. If the
   watcher treats "no longer listed" as `closed`, those tenders wrongly become `closed`. Remove the
   `publicatieDatumVanaf` parameter after the demo (long DAS/qualification systems run until 2029–2050).
2. **Size and pages.** The API's maximum `size` is 100 (101 gives 400). Open AAO total (`totalElements`) = **2,927**
   (about 1,100 published in the last 6 weeks, the rest long-running DAS/qualification systems), so 30 pages.
   With the 7-day demo limit it is about 200 (3 pages); `maxPages` 10 leaves room. Results are newest-published first.
   Cost: a list pass is about 30 requests (≈ 35 s). A first full attach also needs per tender 1 detail +
   1 documenten + N files (3–12 seen) ≈ 2,927 × ~10 ≈ 30k requests ≈ 8 h at 1 req/s. The Extractor must
   deliver list fields first and fetch details/documents gradually, newest first. Steady state ≈ 35 new
   tenders/day ≈ 30 + 35 × ~10 ≈ 400 requests/day.
3. **Detail.** `GET /papi/tenderned-rs-tns/v2/publicaties/{id}` works (checked 450237, 450165, 450192).
   `cpvCodes[*].code` is already 8 digits with no check digit (`parse: cpv` kept as a guard).
   `referentieNummer` is the buyer's file number (e.g. `SRA2601`) and is sometimes missing (450165), so it's left out then.
   **`kenmerk` is not used**: it is TenderNed's own case number (an integer), not the buyer's reference.
   Title/buyer/deadline in the detail match the list. The detail's `publicatieDatum` has a time without
   offset (`2026-11-20T06:53:59.716312`). The list's date-only value is used.
   **Place of performance is not included**: the detail has only `nutsCodes` (e.g. NL224 Zuidwest-Gelderland) or
   `plaatsVanUitvoeringDienstenAndere = LND` ("anywhere in the country"), never a city/postcode.
4. **Documents.** The hop `…/publicaties/{id}/documenten` works. `documenten[*].links.download.href` is root-relative
   (`/papi/…/documenten/15314798/content`) and resolves correctly against the documenten URL. The download sends
   `Content-Disposition: attachment; filename="08 Vragenformulier nota van inlichtingen.xlsx"` (use it for
   fileName: `documentNaam` has no extension). `grootte` = size in bytes. There is also a "download all" ZIP at
   `links.downloadZip.href` (`…/documenten/zip`, `filename="Alle documenten.zip"`, chunked, no length) that would
   save requests (1 instead of N), but its contents weren't checked, so per-file downloads are kept. Individual files can be
   ZIPs too (a 45 MB `Bijlage 10` seen). The list includes the notice PDF itself (category ANK).
5. **Withdrawn.** Signals: `isVroegtijdigeBeeindiging: true` and `typePublicatie.code/omschrijving =
   VBE / "Vroegtijdige beëindiging"` on the list item. The detail's `isVroegtijdigBeeindigd` was `null` on open
   tenders. The recipe uses the `withdrawn` field rule `{"jsonPath": "$.isVroegtijdigeBeeindiging"}`
   (true marks the tender withdrawn). `withdrawnText` is empty: it matches all text of the item, including
   the description, so a phrase match there could wrongly withdraw a tender.
6. **url.** `link.href` is already the human page `https://www.tenderned.nl/aankondigingen/overzicht/{id}`
   (detail's `urlDigitaalSysteem` is the same), so it's kept. Fallback if it ever changes:
   `{"const": "https://www.tenderned.nl/aankondigingen/overzicht/{id}"}`.
7. **Dates.** `publicatieDatum` (list) = `YYYY-MM-DD`. `sluitingsDatum` = `YYYY-MM-DDTHH:mm:ss` with **no offset**,
   in Dutch local time (round local hours like 12:00, 09:30, and `23:59:59` cut-offs), so Europe/Amsterdam:
   `2026-12-18T12:00:00` → `2026-12-18T12:00:00+01:00`. Some open items have no `sluitingsDatum` (→ null).
   For restricted procedures (NOP) the deadline is probably the request-to-participate deadline.

## Values the normalizer must map (`procedure.omschrijving`, `typeOpdracht.omschrijving`)
Openbaar → open · Niet-openbaar → restricted · Mededingingsprocedure met onderhandeling → negotiated ·
Onderhandelingsprocedure zonder voorafgaande oproep tot mededinging → negotiated · Concurrentiegerichte
dialoog → other · Open House → other · Marktconsultatie → other (or leave out). Some items have no procedure
(`code NA`), so leave it out. Werken → works · Diensten → services · Leveringen → supplies.

## Schema features used
- `{today}` / `{daysAgo:N}` placeholders (portal-local `YYYY-MM-DD`) in `RequestSpec`.
- The `withdrawn` field rule instead of text matching on JSON.

## Golden records (hand-checked against list + detail)
| id | title | buyerName | publicationDate | submissionDeadline | referenceNumber |
|---|---|---|---|---|---|
| 450237 | Verkenning route S106 | Gemeente Rijswijk | 2026-11-20 | 2026-12-18T12:00:00+01:00 | SRA2601 |
| 450165 | Levering van bedrijfswagens | Gemeente Zaltbommel | 2026-11-20 | 2027-01-11T10:00:00+01:00 | (none) |
| 450192 | AS6700 inspecties | Hoogheemraadschap Hollands Noorderkwartier | 2026-11-20 | 2026-12-17T09:30:00+01:00 | 26.0979351 |

Further values: 450237 services/open, CPV 71311300, 71311210, 71410000, 3 documents. 450165 supplies/open, CPV 34144700,
34136000, 34144900, 10 documents. 450192 services/open, CPV 90000000, 12 documents. 449873 (Provincie Overijssel,
"Dagelijks onderhoud Vaarwegen (2027-2033)") is `withdrawn` (VBE, ended early).
