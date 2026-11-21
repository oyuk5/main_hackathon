/**
 * Gets the dashboard ready for recording the video (person D).
 *   npx tsx lab/demo/prepare-video.ts
 *
 * 1. Removes the eval's lab portals (localhost:4100), so the dashboard shows each lab portal once.
 * 2. Resets the video lab (localhost:4300) to its original version.
 * 3. Makes sure gmina (to break and repair) and obec (honestly failed) are watched on the video lab.
 * 4. Prints what is on the dashboard and what is still settling.
 * Uses only the public API, like Patterno. Needs the API on :8080 and `LAB_PORT=4300 npx tsx lab/serve.ts`.
 * Don't run it while an eval is running: it would delete the eval's portals mid-run.
 */
const API = process.env.WATCHTOWER ?? "http://localhost:8080";
const VIDEO_LAB = process.env.LAB ?? "http://localhost:4300";

interface Portal { id: string; url: string; state: string; reason: string; tenderCount: number }

async function main(): Promise<void> {
  const portals = (await (await fetch(`${API}/portals`)).json()) as Portal[];
  for (const p of portals.filter((x) => x.url.includes("localhost:4100"))) {
    await fetch(`${API}/portals/${p.id}`, { method: "DELETE" });
    console.log(`removed eval portal ${p.url}`);
  }
  const lab = await fetch(`${VIDEO_LAB}/_lab/state`).catch(() => null);
  if (!lab?.ok) throw new Error(`The video lab is not running. Start it with: LAB_PORT=4300 npx tsx lab/serve.ts`);
  const state = (await lab.json()) as { portals: Array<{ slug: string; variant: string }> };
  for (const p of state.portals.filter((x) => x.variant !== "v1")) {
    await fetch(`${VIDEO_LAB}/_lab/variant?portal=${p.slug}&v=v1`, { method: "POST" });
    console.log(`reset ${p.slug} to the original`);
  }
  for (const slug of ["gmina", "obec"]) {
    await fetch(`${API}/portals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `${VIDEO_LAB}/${slug}/` }) });
  }
  const now = (await (await fetch(`${API}/portals`)).json()) as Portal[];
  console.log("\nOn the dashboard now:");
  for (const p of now) console.log(`  ${p.state.padEnd(11)} ${p.url}  ${p.reason.slice(0, 70)}`);
  const want: Record<string, string> = { gmina: "serving", obec: "failed" };
  const notReady = Object.entries(want).filter(([slug, st]) => now.find((p) => p.url.startsWith(`${VIDEO_LAB}/${slug}`))?.state !== st);
  console.log(notReady.length ? `\nWait a minute and run it again: ${notReady.map(([s, st]) => `${s} should be ${st}`).join(", ")}.` : "\nReady to record: gmina is serving, obec is failed.");
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
