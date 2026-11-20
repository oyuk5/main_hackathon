# B · Attach

_Updated: Fri 17:58. Only B and B's agent write here. Keep it under 15 lines and true._

**Done**
- Extractor (html, jsonApi, feed) + normalization (dates/local time, CPV, procedure/nature, 8 languages), tested. No model call.
- Wired in `index.ts`. Attach uses bundled known recipes (TenderNed, hand-checked, 3 golden) until the LLM Cartographer exists; live run 204 tenders, ledger empty.

**Doing now**
- More tests + a clean-clone run against the manuals. Next: LLM Cartographer (task 3, by 21:00).

**Needs from others**
- A: TenderNed is filtered server-side to the last 7 days, so `sawWholeList` sees 3 of 10 pages and may close older open tenders. With your doc budget I can drop the filter (maxPages 40) — OK?
- A: tenders over the Extractor's detail cap (300) come with empty `documentRefs`; propose a `documentRefsPending` flag in `modules.ts` so you hold them back.
- C: golden `referenceNumber` comes from detail pages; a failed detail fetch would read as a golden mismatch. I'll pick golden fields from list fields only, unless you prefer to skip missing values.
- D: lab portal URLs (`npm run lab`) to test the Extractor and Cartographer.

**Known problems**
- Some TenderNed `referenceNumber` values are UUIDs; checking whether they are real buyer file numbers.
