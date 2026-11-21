# Pitch video: Watchtower in 2:30

For the team recording it. The viewers are Patterno's judges. **Hard limit 2:30.** The script runs about 2:31. One video serves as both the pitch and the demo (BuilderBase has a single "Pitch Video" field).

## Why it is built this way
- **It opens with Patterno's own sentence.** Their brief says: "Today we connect every new portal by hand. When a portal changes, its tenders can stop arriving without anyone noticing." We read it back to them word for word. People trust a solution to the problem in their own words.
- **It follows their scoring sheet in their order:** Attach, Notice, Repair, Dashboard, Approach. Each scene names its criterion out loud, so the judges can tick the boxes while they watch.
- **Show, don't claim.** Every claim happens live on screen at the same moment. No adjectives like "revolutionary".
- **The live repair is the peak,** right in the middle: the moment they will remember.
- **It ends on the strongest number** (money saved). People remember the peak and the end best.
- **It admits a limit on purpose:** the honestly failed portal. It quotes their own rule ("a wrong value is worse than a missing one") and makes every other claim more believable.
- **Their world, their language:** 4,500 portals, Hamburg, one line in German (Patterno is a German company and the dashboard speaks German).
- **Faces for 2 seconds each.** Judges back people they have seen, and the winning team gets job offers.
- **Only true claims.** They run our container themselves, so anything overstated would show up immediately.

## Before you record (15 minutes)
1. The eval must be finished. Then run `npx tsx lab/demo/prepare-video.ts` until it prints "Ready to record". It removes the eval's portals, resets the video lab, and checks that gmina is serving and obec is failed.
2. Running: the API on :8080 and the video lab (`LAB_PORT=4300 npx tsx lab/serve.ts`). **Record http://localhost:8080**, the container's own dashboard: that proves "one container".
3. Browser: one clean window, **dark theme**, zoom 110%, bookmarks bar hidden, no other tabs. Windows notifications off (Focus).
4. Terminal next to the browser, large font, in the repo folder, this command typed but not run:
   `LAB=http://localhost:4300 npx tsx lab/mutate.ts gmina renamed-classes --refresh`
5. Have `lab/demo/video-import.xlsx` ready in a file window for the import shot.
6. Record the screen first, without sound, one scene at a time (Win+Alt+R or OBS, 1080p). Cut out all waiting. Then record the voices over the finished cut.

## The script

| Time | Who | Screen | Say |
|---|---|---|---|
| 0:00–0:10 | Narrator | Black, then the quote on screen in white | "'Today we connect every new portal by hand. When a portal changes, its tenders can stop arriving without anyone noticing.' Your own brief." |
| 0:10–0:19 | Narrator | Dashboard: "1 portal needs a person", the state cards, the map | "This is Watchtower at eight in the morning: every portal serving, repairing, or needing a person, and why." |
| 0:19–0:50 | **B** (face 2 s) | Paste `http://localhost:4300/kommune/` → **Watch portal** → cut to **Serving** → open a tender: documents, the ZIP unpacked into files | "**Attach.** One address it has never seen. A model studies the portal once, for about three cents. Then every read is plain code: no model, zero cost. Every tender, every document, ZIPs unpacked, local deadlines. Always polite: under one request per second, no logins." |
| 0:50–1:25 | **C** (face 2 s) | Run the mutator in the terminal → gmina turns **Being repaired** → **Serving** → open gmina: run history (read failed, repair ok), repair summary, cost | "**Repair.** Now we break it: a full redesign, every class name changed. Watchtower notices on the next read and keeps serving the last correct tenders. It repairs itself, and code checks the fix against tenders it already knows before it goes live. In about a minute. About a cent. Nobody touched it." |
| 1:25–1:40 | **A** (face 2 s) | obec: **failed**, reason "Documents need a login"; Issues tab | "**Notice.** Some portals hide documents behind a login. We never log in: Watchtower says failed, and why. Your rule: a wrong value is worse than a missing one." |
| 1:40–1:49 | **D** (face 2 s) | Fast cuts, about 3 s each: **Import list** with `video-import.xlsx` (preview, "already watched", duplicates merged) → **EN/DE** switch | "**Dashboard.** Add a whole spreadsheet of portals at once. Auch auf Deutsch." |
| 1:49–2:09 | **D** | README "Evidence by judging criterion" (the Attach and Repair paragraphs), then `docs/SAVINGS.md` table | "**Approach.** Eight portals we built, in eight countries, checked against exact ground truth: 95 percent of fields right, zero wrong values. Eleven of thirteen breaking changes repaired themselves, median sixteen seconds. A second portal on the same software costs nothing: no model call. At 300 portals, we estimate forty-eight thousand euros saved a year." |
| 2:09–2:31 | Narrator | Dashboard with every portal green (remove obec in the dashboard right before this shot), then the four faces with names, then "Watchtower" | "You asked for a dashboard with a lot of green lights. Here it is: one container, port 8080, ready for production. We're Ivan, Ilia, Ilie and Valentine. This is Watchtower." |

The Approach numbers come from the README: 95 % and zero wrong values from the November 21, 03:20–03:48 CET attach-only eval of all eight lab portals; 11 of 13 repaired, median 16 s, from the November 20, 22:28 CET full lab run; €48,000 from `docs/SAVINGS.md`. Say only these numbers.

**If you are over 2:30, cut in this order:** the EN/DE shot, the ZIP close-up, the map. Never cut the repair scene or the opening quote.

## Recording the voices
Each person records their own lines over their own scene: phone voice memo, quiet room, phone about 20 cm away, same for everyone. Two takes each, keep the better one. Speak a little slower than feels natural. If one person sounds much quieter, one narrator reads every line instead. Clear sound beats more voices.

## Every feature, and where it is shown
| Feature | Scene |
|---|---|
| Attach an unseen portal (state integrating → serving) | B |
| Tenders with documents, ZIP unpacked, local deadlines | B |
| Notice a change, keep serving while healing, repair itself, verified | C |
| Run history, repair summary, model cost per portal | C |
| Honest failure with a plain-words reason (login wall) | A |
| Issues tab: what needs a person | A |
| Bulk import (Excel/CSV/JSON), duplicates merged, already-watched marked | D |
| German / English | D |
| The public API (JSON) | D |
| Eval scoreboard, cost per attach and repair, savings | D |

## If something goes wrong
- A portal stays **Being attached**: cut, wait, record that scene again. Lab portals serve in 1–3 minutes.
- The repair doesn't start: press **Read now** on gmina, or run the mutator command again.
- To start over: `LAB=http://localhost:4300 npx tsx lab/mutate.ts reset`, then `npx tsx lab/demo/prepare-video.ts`.
