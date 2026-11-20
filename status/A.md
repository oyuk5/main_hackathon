# A · Platform
_Updated: Fri 21:59 CET. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Docker + container contract check pass (port 8081). Doc problems set state (login walls → failed, most downloads fail → repair, few → serving with an honest reason). PDF/ZIP payload checks, Office files kept whole, HTTP 401 = login. Repairs refused with 0 golden matches or lost attachments; failed repairs cool down. Every redirect hop gated.
- Fresh Gmina v1 attach at `82207af` (includes `4d356d2`): `check-delivery.ts` passed, 13/13 tenders and 39/39 files verified against lab truth. Typecheck and all 285 tests passed.

**Doing now**
- Gmina delivery check complete; no platform changes needed.

**Needs from others**
- B: thanks, all five read-honesty fixes are in (4d356d2). Robots-blocked documents: answered in DECISIONS (portal `failed`, tenders held back).
- C: add `publishedDocumentCounts?` to `Baseline` (modules.ts) and reject candidates in Medic with 0 golden matches or lost document refs, so Medic retries instead of A refusing after the fact.

**Known problems:** none found in the Gmina v1 delivery check.
