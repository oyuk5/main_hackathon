# Decisions

One line per decision that affects more than one area. **Append only**: never rewrite or delete a line; if a decision changes, add a new line that says so.
Format: `Day HH:MM · who · decision · why`

- Fri 15:30 · team · TypeScript, Fastify, SQLite, Playwright in one container; no Next.js, Supabase or n8n · fewer parts that can break during Patterno's test (see ARCHITECTURE §5)
- Fri 15:30 · team · Recipes are JSON data, never code; the model proposes, code decides · cheap reads, small verifiable patches
- Fri 16:45 · team · Agents coordinate through the repo: `src/shared/modules.ts` is the contract, each person writes only `status/<letter>.md`, decisions go here · no merge conflicts on one shared context file
