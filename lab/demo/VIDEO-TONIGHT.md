# Backup video, tonight (rough cut, about 2:20)

For whoever records tonight, alone. This is insurance: if the morning shoot fails, this goes in. One person, screen plus voice. Speak while you click, or record silently and talk over it afterwards. Imperfect is fine; under 2:30 is not optional.

## Setup (5 minutes)
- **Running already:** the API on :8080, the video lab on :4300, and the eval on :4100. **Don't touch anything on :4100.** The eval's portals also appear in the table as "gmina (lab)", "polder (lab)" and so on. Ours are the ones on port **4300**: when you open a portal, the address at the top of its panel shows the port.
- Browser: open **http://localhost:8080** (the container's own dashboard), dark theme (moon icon, top right), zoom 110%, close every other tab, hide the bookmarks bar.
- Windows: Focus on (no notifications). Recorder: **Win+Alt+R** starts and stops (Xbox Game Bar), or OBS.
- Terminal next to the browser, large font, in the repo folder, with this typed but **not run**:
  `LAB=http://localhost:4300 npx tsx lab/mutate.ts gmina renamed-classes --refresh`
  (in Git Bash; in PowerShell type `$env:LAB="http://localhost:4300"; npx tsx lab/mutate.ts gmina renamed-classes --refresh`)
- File Explorer open at `lab\demo`, showing `video-import.xlsx`.

Record each scene as its own clip. Stop recording during any wait, and start again when the screen is ready.

## Scenes

### 1 · The problem (0:00–0:15)
**Show:** the dashboard, top of the page. Hold still; move the mouse slowly over the headline and the state cards.
**Say:** "Patterno gathers tenders from 4,500 portals, and today every new portal is connected by hand. When a portal changes, its tenders stop arriving and nobody notices. This is Watchtower: it connects portals on its own, watches them, and repairs them."

### 2 · Attach a portal it has never seen (0:15–0:45)
**Show:**
1. Click the address field at the top, type `http://localhost:4300/kommune/`, click **Watch portal**.
2. The portal's panel opens: state **Being attached**. **Stop recording.**
3. Wait 1–3 minutes until it says **Serving**. **Start recording.**
4. In the panel: point at **Open tenders**, **How it is read** (the learned recipe) and **Model cost**.
5. In the browser address bar, the end of the address shows the portal id (`#/p/p_...`). Open a new tab: `http://localhost:8080/portals/<that id>/tenders`. Firefox shows the JSON nicely: scroll through one tender, its deadline with offset, its documents list.
**Say:** "We give it one address it has never seen. A model studies the portal once, for a few cents. After that, every read is plain code: no model, no cost. Here is what our API returns: every open tender with its title, buyer, deadline in local time, and every document, with ZIP files unpacked."

### 3 · The portal changes, and it repairs itself (0:45–1:25)
**Show:**
1. Back on the dashboard. Click our **gmina** (port 4300): state **Serving**.
2. Run the terminal command. It prints "gmina → renamed-classes" and "Watchtower read started".
3. Watch gmina in the table: it turns **Being repaired** (amber). Stop recording if it takes long; start again just before it turns back.
4. It returns to **Serving**. Open its panel: **Run history** shows the failed read and the repair (ok); open **What the repair changed** (the recipe diff); point at **Model cost**.
**Say:** "Now the portal is redesigned: every class name changes, so the old way of reading it breaks. Watchtower notices on the next read, keeps serving the last correct tenders, and repairs itself. Before the fix goes live, code checks it against tenders it already knows. About a cent, under a minute, and nobody touched it."

### 4 · When it can't deliver, it says so (1:25–1:40)
**Show:** click our **obec** (port 4300): state **failed**, reason "Documents need a login…". Then click the **Issues** tab.
**Say:** "Some portals hide their documents behind a login. We never log in, so Watchtower reports it as failed and says why, in plain words. A wrong value is worse than a missing one."

### 5 · Built for an operator (1:40–1:58)
**Show,** about 4 seconds each:
1. Click **Import list**, drag `video-import.xlsx` from File Explorer into the window: the preview shows new portals, the ones already watched, and the duplicate merged. Click **Close** (don't add them tonight).
2. Click **DE** at the top: the dashboard switches to German. Click **EN** again.
**Say:** "Operators can add a whole spreadsheet of portals at once. Auch auf Deutsch."

### 6 · The numbers (1:58–2:15)
**Show:** open `README.md` on GitHub (or in VS Code), scroll to **Approach: scale and model cost**: the cost table and the savings line.
**Say:** "Attaching a portal costs about three cents, a repair about two, and regular reads cost nothing. In our tests, most breaking changes were repaired on their own within about a minute. At 300 portals, that saves about forty-seven thousand euros a year."

### 7 · Close (2:15–2:22)
**Show:** back to the dashboard, top of the page.
**Say:** "One container, API and dashboard on port 8080. This is Watchtower."

## Afterwards
- Put the clips in order in Clipchamp (built into Windows) or CapCut, cut the waits, check the length is under 2:30, export 1080p.
- Save it as `watchtower-backup.mp4` somewhere outside the repo (videos don't go in git).
- If gmina's repair goes wrong: `LAB=http://localhost:4300 npx tsx lab/mutate.ts reset`, wait until gmina is serving again, try scene 3 again.
