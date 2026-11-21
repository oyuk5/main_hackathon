# A · Platform
_Updated: Sat 01:47. Only A and A's agent write here. Keep it under 15 lines and true._

**Done**
- Hand-in path proven: fresh-clone `docker build --platform linux/amd64` (20 s) and container pass all 16 contract checks; dashboard opens with no login. 370 tests pass.
- Requirements audit (Cline): 20 brief requirements checked with tests or live checks; 18 pass, list captcha on HTTP 429 and empty optional fields fixed. Clerk sign-in removed (brief: no authentication).
- Cross-area fixes with owners' OK: empty-day wording, document-link probe, Medic retries, no repair that drops a cancellation. Attach rechecks 100% on gmina, stadtwerke, ville, 0 wrong values.

**Doing now:** video and model key for Patterno (with spending limit).

**Needs from others**
- D: video (3 min or less) recorded on the Docker build; commit a final `lab/results/latest.md` if you rerun the eval.
- Everyone: no pushes after 08:30 without a Docker contract check.

**Known problems:** large portals take minutes to the first tenders (TenderNed: 36 after ~14 min; in README). Live 1 req/s peak of 2 seen only with several local servers reading the same lab host.
