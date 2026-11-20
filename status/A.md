# A · Platform
_Updated: Fri 20:45 CET. Only A and A's agent write here._

**Done**
- Docker build and container contract check pass on port 8081. B reports failed document listings already set `documentRefsPending` in `src/attach/extractor.ts`.
- API lifecycle tests cover DELETE, login walls, repair publication, and ZIP bytes/hashes. Partial downloads never replace the affected tender; pending updates and retries use the one-minute follow-up.
- Platform validates PDF/ZIP payloads, preserves Office containers, identifies document 401, and blocks repairs with zero golden matches or dropped known attachments; failed repairs cool down.

**Doing now**
- `scripts/check-delivery.ts` verifies public API bytes against lab truth. Latest Gmina: 13/13 tenders, 0/39 files, 28 s, $0.024408.

**Needs from others**
- C: add optional `publishedDocumentCounts?: Readonly<Record<string, number>>` to `Baseline` in `modules.ts` and use it in Medic (A already passes it to `medic.repair`).
- B: document evidence, partial crawl, source deadline/award checks, detail-cache refresh and unsupported-site reasons. C: reject unsafe candidates inside Medic so it can try again. D: real mutation run and UI proof; use genuine Office fixtures before enforcing Office magic.

**Known problems:** A recipe that never discovers existing files can still appear healthy.
