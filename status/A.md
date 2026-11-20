# A · Platform

_Updated: Fri 17:01. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Docker amd64 build passes `test:contract`. Documents: browser `clickPath` downloads, nested ZIPs, cap, login/captcha traps, retry next read.
- DELETE closes browser context and HTTP downloads at once (`documents.test.ts`).

**Doing now**
- Task 5: review `reason` strings with C.

**Needs from others**
- C: 15 min to review reason strings. B: a real recipe, so README cost numbers come from the ledger.

**Known problems**
- Mac with `npm run dev` on :8080: run the container with `-p 8081:8080`.
