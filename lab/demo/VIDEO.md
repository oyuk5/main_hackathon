# Video script: Watchtower in 2:30

For whoever records. The viewers are Patterno's judges: they care about attach, notice, repair, the dashboard, and cost per portal. **Hard limit: 2 minutes 30 seconds.** The script runs about 2:20, leaving room for cuts. That is about 330 spoken words in total, so keep every line short.

## Before you record (10 minutes)

1. Running: the API on :8080, the dashboard (http://localhost:5173, or http://localhost:8080 from the container), and the **video lab on :4300** (`LAB_PORT=4300 npx tsx lab/serve.ts`). Don't use :4100 while an eval runs on it.
2. Already added, so they have time to settle: `http://localhost:4300/gmina/` (should be **serving**) and `http://localhost:4300/obec/` (should be **failed**, documents need a login).
3. Browser: one clean window, dark theme, zoom 110%, bookmarks bar hidden, other tabs closed. Windows notifications off (Focus).
4. A terminal next to the browser, font large, in the repo folder, with this command typed but not run:
   `LAB=http://localhost:4300 npx tsx lab/mutate.ts gmina renamed-classes --refresh`
5. Recorder: Win+Alt+R (Xbox Game Bar) or OBS, 1080p. Record the scenes separately and cut the waits.

## The script (about 2:20)

| Time | Screen | Say |
|---|---|---|
| 0:00–0:12 | Dashboard, "Nothing needs a person" | "Patterno gathers tenders from 4,500 portals, connected by hand. When one changes, its tenders quietly stop. Watchtower fixes that." |
| 0:12–0:25 | Point at the four state cards, the table, the map | "Every portal is attaching, serving, being repaired, or needs a person. One look at 8 a.m. tells you which." |
| 0:25–0:50 | Paste `http://localhost:4300/kommune/` → **Watch portal**. Cut to it **serving**. Open a tender: its documents, a ZIP unpacked into files. | "We give it an address it has never seen. A model learns the portal once, for about three cents. Every read after that is plain code: no model, no cost. Tenders, documents, ZIPs unpacked." |
| 0:50–1:25 | Terminal: run the mutator. Dashboard: gmina **Being repaired**, then **Serving**. Open gmina: run history (read failed → repair ok), repair summary, cost. | "Now the portal is redesigned: every class name changes. Watchtower notices on the next read, keeps serving the last correct tenders, and repairs itself. Code checks the fix against known tenders before it goes live. About a cent, under a minute, nobody touched it." |
| 1:25–1:40 | **obec**: failed, reason "documents need a login" | "When it can't deliver, it says so. These documents need a login, and we never log in, so: failed, with the reason in plain words." |
| 1:40–2:05 | `lab/results/latest.md` (or the README cost table) | "We break portals in many ways and check against exact ground truth: [heal rate]% repaired on their own, median [N] seconds. Attach three cents, repair two, reads free. At 300 portals, that's about 47,000 euros saved a year." |
| 2:05–2:20 | Dashboard | "One container. API and dashboard on port 8080. Watchtower." |

Fill in the bracketed numbers from the latest eval before recording the final video. Cut for time if needed: the map pointing (0:12) and the ZIP close-up go first; never cut the repair scene.

## Ad version with the whole team (same timing)
A narrator opens (0:00–0:25) and closes (2:05–2:20). B speaks over the attach scene, C over the repair, A over the failed portal and "one container", D over the numbers. About 50–70 words each. Record the screen first without sound, then each person records their lines over their scene, on a phone in a quiet room at the same distance from the mic.

## If something goes wrong
- A portal stays **Being attached** for long: cut, wait, record that scene again. Small lab portals serve in 1–3 minutes.
- The repair doesn't start: press **Read now** on gmina, or run the mutator command again.
- To start over: `LAB=http://localhost:4300 npx tsx lab/mutate.ts reset`.
