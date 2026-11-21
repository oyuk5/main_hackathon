# Coverage: which portals European tenders actually point to

**Sample.** TED API v3 (`POST https://api.ted.europa.eu/v3/notices/search`), queried 2026-11-21 at about 05:05 CET. Query: `publication-date>=20261110 AND publication-date<=20261120 AND notice-type IN (cn-standard)`. It matched 15,542 contract notices. We took the first 2,000 in the API's default order (8 pages of 250, 1 request per second). They are publication numbers 779190-2026 to 783314-2026, from 33 buyer countries. Top countries: DEU 390, POL 383, FRA 271, CZE 95, ESP 95, ITA 62.

**Method.**
- For each notice, the first `document-url-lot` address is the portal where the documents are.
- 1,921 of 2,000 notices have one.
- Each address went through `fingerprint()` from `src/attach/families.ts`, with the URL only and no page fetched. That finds a family only when the host or path gives it away. Families recognised by page content (for example cosinex installs) are missed, so the family share is a **lower bound**.
- Addresses with no family are grouped by registrable domain. Each domain counts as its own "software" unless several hosts share it.

The scripts are `ted.mts` and `cov.mts`. They were run from the night run's scratchpad and are not committed.

## Measured

| | |
|---|---|
| Notices with a document address | 1,921 of 2,000 |
| Distinct portal hosts | 356 |
| Hosts with only one notice in the sample | 204 |
| Groups (families + remaining domains) | 205 |
| Notices on a family that `families.ts` recognises from the URL alone | 331 (17.2 %), in 8 families |
| Notices covered by the top 10 groups | 700 (36.4 %) |
| Groups that span 2 or more hosts | 29 groups, 181 hosts, 438 notices (22.8 %) |

Top 10 groups (notices, hosts):
1. Open Nexus platformazakupowa (family): 113, 1
2. ezamowienia.gov.pl: 102, 1
3. marches-publics.info: 89, 1
4. ezamawiajacy.pl: 71, **51** (one subdomain per buyer)
5. dtvp.de: 65, 2
6. e-licitatie.ro: 60, 1
7. eojn.hr: 58, 1
8. PLACSP (family): 55, 1
9. Healy Hudson e-Vergabe (family): 47, **20**
10. eop.bg: 40, 1

The other recognised families: achatpublic.com 30 notices on 4 hosts, Mercell 27 on 3, Deutsche eVergabe 26 on 2, Vortal 20 on 1, Atexo MPE 13 on 1. Not in `families.ts`, yet clearly one software on many hosts: e-marchespublics.com (20 notices, 15 hosts) and logintrade.net (19, 15).

## What it means for cost

| Operation | Model cost | Basis |
|---|---:|---|
| Attach, real never-seen portals | $0.039 average | tonight's gauntlet: $0.39 for 10 first runs ([GAUNTLET.md](GAUNTLET.md)) |
| Attach, lab portals | $0.029 average | the README table |
| Family attach | $0 | the README: a reused recipe that passes its trial makes no model call |

In this sample, at least 17 % of notices are on software our fingerprints already recognise from the address alone. At least 23 % are on software that runs many hosts. For those, every portal after the first on the same software attaches with no model call ($0 instead of about $0.03–0.04), so the model cost of covering them grows with the number of software packages, not the number of portals.
