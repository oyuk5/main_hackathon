# A · Platform
_Updated: Fri 21:53. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Docker + container contract check pass (port 8081). Doc problems set state (login walls → failed, most downloads fail → repair, few → serving with an honest reason). PDF/ZIP payload checks, Office files kept whole, HTTP 401 = login. Repairs refused with 0 golden matches or lost attachments; failed repairs cool down. Every redirect hop gated.
- `scripts/check-delivery.ts` compares the public API bytes with lab truth. Last Gmina run: 13/13 tenders, 0/39 files.

**Doing now**
- Re-run `check-delivery.ts` on Gmina after B's tender-page documents change (ed9f8ca).

**Needs from others**
- B: thanks, all five read-honesty fixes are in (4d356d2). Robots-blocked documents: answered in DECISIONS (portal `failed`, tenders held back).
- C: add `publishedDocumentCounts?` to `Baseline` (modules.ts) and reject candidates in Medic with 0 golden matches or lost document refs, so Medic retries instead of A refusing after the fact.

**Known problems:** a recipe that never finds files can still look healthy is now a read error (B, 4d356d2); re-check Gmina.
