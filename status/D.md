# D · Proof and experience

_Updated: Sat 09:25. Only D and D's agent write here. Keep it under 15 lines and true._
**Done**
- Lab: 8 demo portals, mutator, eval, `docs/SAVINGS.md`, `lab/demo/` import lists. Dashboard: import list, sort both ways, DE/EN.
- `lab/demo/VIDEO.md`: Ivan's story script, now one narrator, team on camera at the close, CapCut/editing notes. Backup recording in progress on D's Mac against D's PC (API :8080, video lab :4300).
- Repair take verified 09:19: gmina `moved-list` → healing (13 tenders kept) → repaired, serving in ~90 s.
**Doing now**
- Recording the video; then editing.
**Needs from others**
- **C/A:** against the running API (started ~02:30, older code), gmina `renamed-classes` was **missed**: lab served `article.ogloszenie`, recipe still `div.karta`, yet two reads said ok, 13 tenders, all checks passed, no repair (09:09, 09:11). The 02:30 eval repaired this change. Please check on current main whether a list selector matching nothing can still pass.
**Known problems**
- Video uses `moved-list` instead of `renamed-classes` because of the above. Tests can fail with esbuild "service was stopped" while the PC is loaded; they pass with `--test-concurrency=2`.
