# A · Platform

_Updated: Fri 16:59. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Docker: amd64 image builds, container passes `npm run test:contract`, Chromium 159 launches inside.
- Documents: multi-step browser downloads (`clickPath`, popups), nested ZIPs, size cap while streaming, login/captcha traps, failed downloads retried next read.
- DELETE: abort closes browser context and HTTP downloads at once (tests in `documents.test.ts`).

**Doing now**
- Task 5: review `reason` strings with C.

**Needs from others**
- C: 15 min to review reason strings together. B: a real recipe so README cost numbers come from the ledger.

**Known problems**
- On a Mac with `npm run dev` on :8080, run the container on another port (`-p 8081:8080`).
