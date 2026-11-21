# Never-seen gauntlet, 2026-11-21 (night run)

Ten real portals that Watchtower had never seen. Their hosts appear nowhere in `lab/portals.json`, `lab/demo/` or `src/attach/`. They cover 6 countries and 8 portal software packages. Each was attached **once**, through the public API (`POST /portals`), with no tuning. All traffic went through the normal polite client (≥1.1 s between requests per host, robots.txt honoured, honest User-Agent).

**How the portals were found.** Hosts came from TED API v3 notices since 2026-11-01 (fields `document-url-lot` and `buyer-profile`). Each portal was then opened by hand, about 1 request per second. The research checked for a public list with ≥5 open tenders and looked for one document that downloads without login. The brief's rule asked for public documents on every portal. Only 5 of the 10 met it:
- 5 had documents downloadable without login (verified).
- 3 need a login or registration for documents (KABEG, PROVIA, Norrbotten). They were kept as honest "should fail" cases.
- 2 could not be checked without JavaScript (AVM, Tarjouspalvelu).

Server: `night/bugs` at `6183eff`. From portal 2 on it ran at `91a28c9` (see the Mégalis note). Model: the `.env` models. Times are the first run's duration, from `GET /portals/{id}/runs`. Cost is the portal's own ledger, from `/internal/portals/{id}`.

| # | Portal | Country | Software | State | Tenders | Documents | Cost | Time | Honest reason (failures) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Mégalis Bretagne `marches.megalis.bretagne.bzh` | FR | Atexo LOCAL TRUST MPE | failed | 0 | – | $0.064 | 192 s | "Could not learn this portal in 4 drafts: the procedureType rule found no value on any of 3 tenders." |
| 2 | Kraj Vysočina `ezak.kr-vysocina.cz` | CZ | E-ZAK (QCM) | **serving** | 44 (22 open) | 44 of 44 tenders, 136 files | $0.080 | 384 s | – (75 more tenders get their documents in the next reads) |
| 3 | Pardubický kraj `zakazky.pardubickykraj.cz` | CZ | E-ZAK (QCM) | **serving** | 50 (50 open) | 50 of 50 tenders, 222 files | $0.028 | 303 s | – (181 more follow in the next reads) |
| 4 | AVM Venezia `portalegare.avmspa.it` | IT | Maggioli Appalti & Contratti | failed | 0 | – | $0.000 | 1 s | "The portal's robots.txt does not allow reading its tender list, so we stay away." (robots.txt is `Disallow: /`, checked) |
| 5 | IPZS `appalti.ipzs.it` | IT | TuttoGare | failed | 0 | – | $0.051 | 211 s | "Could not learn this portal in 4 drafts: the submissionDeadline rule matched on none of 3 tenders." |
| 6 | KABEG `kabeg.vemap.com` | AT | VEMAP | failed | 0 | – | $0.046 | 46 s | "Could not learn this portal in 4 drafts: there is no documents rule, so every tender would be served without its files." (documents need a registration) |
| 7 | PROVIA (ASFINAG/ÖBB) `provia.at` | AT | PROVIA (ÖBB P3) | failed | 0 | – | $0.040 | 68 s | "The JSON API lists the tenders and their IDs but exposes no tender-specific URLs…" (the model gave up) |
| 8 | Region Norrbotten `e-avrop.com` | SE | e-Avrop (Antirio) | failed | 0 | – | $0.000 | 1 s | "The portal's robots.txt does not allow reading its tender list, so we stay away." (robots.txt is `Disallow: /`, checked) |
| 9 | Tarjouspalvelu `tarjouspalvelu.fi` | FI | Cloudia Tarjouspalvelu (Mercell) | **serving** | 7 (7 open) | 0 (no documents rule found) | $0.081 | 115 s | – |
| 10 | acinGov `acingov.pt` | PT | acinGov (ACIN) | failed | 0 | – | $0.000 | 2 s | "Blocked: The portal answers 403 Forbidden: access needs a login or is refused." (it refuses our User-Agent; we do not disguise it) |

Total model cost for the ten first runs: **$0.39**.

**Spot check (served value vs. what the research saw on the portal):** Vysočina's tender "Lidský fibrinogen" is served with:
- buyer "Nemocnice Třebíč, příspěvková organizace"
- deadline `2026-12-10T10:00:00+01:00` (the portal shows 10.12.2026 10:00)
- document `Výzva Lidský fibrinogen sign.pdf`

All three match.

**Generic bug found and fixed: `91a28c9`.** Mégalis and e-Vergabe Bund (a hidden portal) both failed only because the last draft still held an **optional** rule that matched nothing. Since that commit, the last draft drops such rules and continues; the fields stay empty and are never guessed. Test: `cartographer-model.test.ts` › "a dead optional rule left in the last draft is dropped instead of failing the attach".

A second Mégalis run on the fix still failed ($0.055 extra). Its draft 4 had also dropped the required deadline rule, so the fix rightly stayed off. Mégalis's table above is the first run.

**Worth a look (not changed):**
- Draft 3 on Mégalis rejected a 2033 deadline as "implausible". Mégalis page 1 lists long-running dynamic purchasing systems (the research saw a 2032 deadline), so the plausibility window may reject true values.
- KABEG and Tarjouspalvelu both lack a documents rule, yet KABEG failed while Tarjouspalvelu was served without files. The documents check blocks only on some paths.
- 3 of the 7 failures are a portal refusing us (robots.txt twice, a 403 once). The fix there is asking the operator, not code.

Watchtower attached 3 of 10 never-seen real portals on its own.
