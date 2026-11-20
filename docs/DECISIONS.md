# Decisions

One line per decision that affects more than one area. **Append only**: never rewrite or delete a line; if a decision changes, add a new line that says so.
Format: `Day HH:MM · who · decision · why`

- Fri 15:30 · team · TypeScript, Fastify, SQLite, Playwright in one container; no Next.js, Supabase or n8n · fewer parts that can break during Patterno's test (see ARCHITECTURE §5)
- Fri 15:30 · team · Recipes are JSON data, never code; the model proposes, code decides · cheap reads, small verifiable patches
- Fri 16:45 · team · Agents coordinate through the repo: `src/shared/modules.ts` is the contract, each person writes only `status/<letter>.md`, decisions go here · no merge conflicts on one shared context file
- Fri 16:59 · A · A tender whose document fetch had problems is stored without its refs hash, so its documents are fetched again on the next read · a failed download must not leave a tender without documents forever
- Fri 16:59 · A · Aborting a job (DELETE) closes its browser context at once, so `ctx.browser` calls throw mid-click or mid-download · DELETE must stop all traffic within a minute; code using `ctx.browser` should treat a throw after abort as normal
- Fri 16:59 · A · `npm test` includes real Chromium tests; run `npx playwright install chromium` once per machine · Playwright 1.65.1 needs Chromium build 1255, so older local installs fail
- Fri 17:29 · A · Models: `MODEL_SMART=gpt-6.2-sol` (attach, repair), `MODEL_FAST=gpt-6-luna` (triage); prices 2/10 and 0.10/0.50 USD per million tokens · Sol is near Astra's quality at a quarter of the price; tested with the team key
- Fri 17:29 · A · A tender missing from a read is marked `closed` only when the read saw the whole list (not capped by `maxPages`, not aborted) or its deadline has passed · a capped read does not see older tenders, and closing them would serve a wrong status
- Fri 17:35 · A · Each read downloads documents for at most `DOC_REFS_PER_READ` (300) refs, newest open tenders first; a new tender is stored and served only once its documents are in; while any are pending the next read follows in 1 min · a first read of TenderNed (~30k requests) would otherwise keep the portal `integrating` for about 8 hours
- Fri 17:41 · A · A tender whose `id` is empty or whose `url` is not an absolute URL is left out of delivery (logged as a warning); a deadline without offset is served as `null` and never closes a tender · the contract requires both fields, and B's Extractor must resolve relative links
