# Pitch video: Watchtower in 2:30

For the team recording it. The viewers are Patterno's judges. **Hard limit 2:30.** The script runs about 2:29. One video serves as both the pitch and the demo (BuilderBase has a single "Pitch Video" field). **One narrator** over the screen; the team is on camera only at the close (and, optionally, at the opening).

## Why it is built this way
- **It opens with Patterno's own sentence.** Their brief says: "Today we connect every new portal by hand. When a portal changes, its tenders can stop arriving without anyone noticing." We read it back to them word for word. People trust a solution to the problem in their own words.
- **It follows their scoring sheet in their order:** Attach, Notice, Repair, Dashboard, Approach. Each scene names its criterion out loud, so the judges can tick the boxes while they watch.
- **Show, don't claim.** Every claim happens live on screen at the same moment. No adjectives like "revolutionary".
- **The live repair is the peak,** right in the middle: the moment they will remember.
- **It ends on the strongest number** (money saved). People remember the peak and the end best.
- **It admits a limit on purpose:** the honestly failed portal. It quotes their own rule ("a wrong value is worse than a missing one") and makes every other claim more believable.
- **Their world, their language:** 4,500 portals, Hamburg, one line in German (Patterno is a German company and the dashboard speaks German).
- **The team on camera at the end.** Judges back people they have seen, and the winning team gets job offers. One calm voice in between sounds more professional than four.
- **Only true claims.** They run our container themselves, so anything overstated would show up immediately.

## Before you record (15 minutes)
1. Run `npx tsx lab/demo/prepare-video.ts` until it prints "Ready to record". It removes the eval's portals, resets the video lab, and checks that gmina is serving and obec is failed.
2. Running: the API on :8080 and the video lab (`LAB_PORT=4300 npx tsx lab/serve.ts`). **Record http://localhost:8080**, the container's own dashboard: that proves "one container".
3. Browser: one clean window, **dark theme**, zoom 110%, bookmarks bar hidden, no other tabs. Notifications off (Focus / Do Not Disturb).
4. Terminal next to the browser, large font, in the repo folder, this command typed but not run:
   `LAB=http://localhost:4300 npx tsx lab/mutate.ts gmina renamed-classes --refresh`
5. Have `lab/demo/video-import.xlsx` ready in a file window for the import shot.
6. Record the screen first, without sound, one scene at a time, 1080p (Mac: Cmd+Shift+5, "Show Mouse Clicks" on; Windows: Win+Alt+R or OBS). Cut out all waiting. Then record the voice over the finished cut.

## The script

| Time | Screen | Narrator says |
|---|---|---|
| 0:00–0:10 | Black, then the quote on screen in white. *Optional:* the narrator on camera for this line instead (see "Camera shots"). | "'Today we connect every new portal by hand. When a portal changes, its tenders can stop arriving without anyone noticing.' Your own brief." |
| 0:10–0:18 | Dashboard: "1 portal needs a person", the state cards, the map | "This is Watchtower at eight in the morning: every portal serving, repairing, or needing a person, and why." |
| 0:18–0:49 | Paste `http://localhost:4300/kommune/` → **Watch portal** → label "sped up" → **Serving** → open a tender: documents, the ZIP unpacked into files | "**Attach.** One address it has never seen. A model studies the portal once, for about three cents. Then every read is plain code: no model, zero cost. Every tender, every document, ZIPs unpacked, local deadlines. Always polite: at most one request per second, no logins." |
| 0:49–1:24 | Run the mutator in the terminal → gmina turns **Being repaired** → **Serving** → open gmina: run history (read failed, repair ok), repair summary, cost | "**Repair.** Now we break it: a full redesign, every class name changed. Watchtower notices on the next read and keeps serving the last correct tenders. It repairs itself, and code checks the fix against tenders it already knows before it goes live. In about a minute. About a cent. Nobody touched it." |
| 1:24–1:39 | obec: **failed**, reason "Documents need a login" (zoom in); Issues tab | "**Notice.** Some portals hide documents behind a login. We never log in: Watchtower says failed, and why. Your rule: a wrong value is worse than a missing one." |
| 1:39–1:48 | Fast cuts, about 3 s each: **Import list** with `video-import.xlsx` (preview, "already watched", duplicates merged) → **EN/DE** switch | "**Dashboard.** Add a spreadsheet of portals at once. Auch auf Deutsch." |
| 1:48–2:08 | README "Evidence by judging criterion" (the Attach and Repair paragraphs) and the cost table, then `docs/SAVINGS.md` table. The numbers also as big white captions. | "**Approach.** Eight portals we built, in eight countries, checked against ground truth: 95 percent of fields right, zero wrong values. Eleven of thirteen breaking changes repaired themselves, median sixteen seconds. A second portal on the same software costs nothing: no model call. At 300 portals, we estimate forty-eight thousand euros saved a year." |
| 2:08–2:20 | Dashboard with every portal green (remove obec in the dashboard right before this shot) | "You asked for a dashboard with a lot of green lights. Here it is: one container, port 8080, ready for production." |
| 2:20–2:29 | **Camera: the team shot** (see below), names and roles as captions, then "Watchtower" | "We're Ivan, Ilia, Ilie and Valentine. This is Watchtower." |

The Approach numbers come from the README: 95 % and zero wrong values from the November 21, 03:20–03:48 CET attach-only eval of all eight lab portals; 11 of 13 repaired, median 16 s, from the November 20, 22:28 CET full lab run; €48,000 from `docs/SAVINGS.md`. Say only these numbers. The "second portal on the same software" line goes over the cost table only: family reuse is in the code but was not shown in the lab, so don't try to show it live.

**If you are over 2:30, cut in this order:** the EN/DE shot, the ZIP close-up, the map. Never cut the repair scene, the opening quote or the team shot.

## Camera shots
1. **The team shot (2:20–2:29), required.** All four side by side, looking into the camera. One person says the line. Captions under each face: name and role (Platform, Attach, Repair, Dashboard). Phone on a stand at eye level, about 1.5 m away, facing a window, plain background. Three takes, keep the best. About 5 minutes.
2. **The opening, optional.** The narrator on camera for the first line, then cut to the dashboard. If it doesn't look good, use the black screen with white text.

## Recording the voice
One narrator, the calmest voice, reads every line. Phone voice memo, quiet room, phone about 20 cm away. Two takes, keep the better one. Speak a little slower than feels natural. Then run the recording through **Adobe Podcast "Enhance Speech"** (free, podcast.adobe.com/enhance): it makes a phone recording sound like a studio mic.

## Editing (CapCut, free)
- **Auto captions**, then fix the words it gets wrong. Many judges watch muted. Numbers as big white captions.
- **Remove silences** in the voice track.
- **Speed up the waits** and label them "sped up".
- **Zoom in** on what matters: the state, the reason, the repair summary. Never show the full screen at small size.
- Quiet royalty-free music from CapCut's library under the voice, louder only in the last 3 seconds.
- Export 1080p, check the length is under 2:30. Videos don't go in git.
- **No AI-generated footage or AI voices** (Runway, ElevenLabs and the like): the real screen recording is the proof, and anything that looks generated makes the judges wonder what else is staged. The AI the judges should notice is the product's own: the model studying the portal and repairing it live.

## Every feature, and where it is shown
| Feature | Scene |
|---|---|
| Attach an unseen portal (state integrating → serving) | Attach |
| Tenders with documents, ZIP unpacked, local deadlines | Attach |
| Notice a change, keep serving while healing, repair itself, verified | Repair |
| Run history, repair summary, model cost per portal | Repair |
| Honest failure with a plain-words reason (login wall) | Notice |
| Issues tab: what needs a person | Notice |
| Bulk import (Excel/CSV/JSON), duplicates merged, already-watched marked | Dashboard |
| German / English | Dashboard |
| Eval results, cost per attach and repair, savings | Approach |

## If something goes wrong
- A portal stays **Being attached**: cut, wait, record that scene again. Lab portals serve in 1–3 minutes.
- The repair doesn't start: press **Read now** on gmina, or run the mutator command again.
- To start over: `LAB=http://localhost:4300 npx tsx lab/mutate.ts reset`, then `npx tsx lab/demo/prepare-video.ts`.
