# Decisions

One line per decision that affects more than one area. **Append only**: never rewrite or delete a line; if a decision changes, add a new line that says so.
Format: `Day HH:MM · who · decision · why`

- Fri 15:30 · team · TypeScript, Fastify, SQLite, Playwright in one container; no Next.js, Supabase or n8n · fewer parts that can break during Patterno's test (see ARCHITECTURE §5)
- Fri 15:30 · team · Recipes are JSON data, never code; the model proposes, code decides · cheap reads, small verifiable patches
- Fri 16:45 · team · Agents coordinate through the repo: `src/shared/modules.ts` is the contract, each person writes only `status/<letter>.md`, decisions go here · no merge conflicts on one shared context file
- Fri 16:59 · A · A tender whose document fetch had problems is stored without its refs hash, so its documents are fetched again on the next read · a failed download must not leave a tender without documents forever
- Fri 16:59 · A · Aborting a job (DELETE) closes its browser context at once, so `ctx.browser` calls throw mid-click or mid-download · DELETE must stop all traffic within a minute; code using `ctx.browser` should treat a throw after abort as normal
- Fri 16:59 · A · `npm test` includes real Chromium tests; run `npx playwright install chromium` once per machine · Playwright 1.65.1 needs Chromium build 1255, so older local installs fail
