# Video script: Watchtower in 3 minutes

For whoever records. The viewers are Patterno's judges: they care about attach, notice, repair, the dashboard, and cost per portal.

## Before you record (10 minutes)

1. Running: the API on :8080, the dashboard (http://localhost:5173, or http://localhost:8080 from the container), and the **video lab on :4300** (`LAB_PORT=4300 npx tsx lab/serve.ts`). Don't use :4100 while an eval runs on it.
2. Already added, so they have time to settle: `http://localhost:4300/gmina/` (should be **serving**) and `http://localhost:4300/obec/` (should be **failed**, documents need a login).
3. Browser: one clean window, dark theme, zoom 110%, bookmarks bar hidden, other tabs closed. Windows notifications off (Focus).
4. A terminal next to the browser, font large, in the repo folder, with this command typed but not run:
   `LAB=http://localhost:4300 npx tsx lab/mutate.ts gmina renamed-classes --refresh`
5. Recorder: Win+Alt+R (Xbox Game Bar) or OBS, 1080p. Record the scenes separately and cut the waits.

## The script (about 2:50)

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | Dashboard, "Nothing needs a person" | "Patterno gathers tenders from 4,500 portals, connected by hand. When a portal changes, its tenders quietly stop. Watchtower connects portals on its own, notices when one breaks, and repairs it." |
| 0:15–0:35 | Point at the four state cards, the table, the map, "Model usage so far" | "Every portal is in one of four states: being attached, serving, being repaired, or needs a person. An operator sees at 8 a.m. what delivers and what doesn't." |
| 0:35–1:05 | Paste `http://localhost:4300/kommune/` into the address field → **Watch portal**. Cut to it **serving**. Open it: tenders, then one tender's documents (a ZIP is unpacked into its files). | "We give it only an address it has never seen. A model learns how to read the portal once, about three cents. After that, every read is plain code: no model, zero cost. It delivers every open tender with its documents, ZIPs unpacked, deadlines in local time." |
| 1:05–1:50 | Terminal: run the mutator command. Dashboard: gmina turns **Being repaired**, then back to **Serving**. Open gmina: run history (read failed → repair ok), the repair summary, the cost of the repair. | "Now the portal changes, like a redesign: every class name is different. Watchtower notices on the next read, keeps serving the last correct tenders, and repairs itself: the model patches the recipe, and code checks it against tenders it already knows before anything goes live. About one cent, under a minute, nobody touched it." |
| 1:50–2:10 | **obec**: failed, reason "documents need a login". Optional: Platforma Zakupowa failed because robots.txt blocks downloads. | "When it can't deliver, it says so. This portal hides documents behind a login; we don't log in, so it's failed, with the reason in plain words. A wrong value is worse than a missing one." |
| 2:10–2:25 | Optional: **Import list**, drop `lab/demo/portals.xlsx`, show the preview. Flip **EN/DE**. | "Operators can add hundreds of portals from a spreadsheet, in English or German." |
| 2:25–2:50 | `lab/results/latest.md` (or the README cost table) | "Our eval breaks portals in many ways and checks the result against exact ground truth. [Heal rate]% of breaking changes repaired by themselves, median [N] seconds. Attach about three cents per portal, a repair about two cents, regular reads free. At 300 portals that saves about 47,000 euros a year." |
| 2:50–3:00 | Dashboard | "One container, API and dashboard on port 8080. Watchtower." |

Fill in the bracketed numbers from the latest eval before recording the final video.

## If something goes wrong
- A portal stays **Being attached** for long: cut, wait, record that scene again. Small lab portals serve in 1–3 minutes.
- The repair doesn't start: press **Read now** on gmina, or run the mutator command again.
- To start over: `LAB=http://localhost:4300 npx tsx lab/mutate.ts reset`.
