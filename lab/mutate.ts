/**
 * Mutator (person D): switches a running lab portal to a changed version, like a real portal redesign.
 * The lab must be running (npm run lab).
 *
 *   npx tsx lab/mutate.ts                          list portals, their current version and every change
 *   npx tsx lab/mutate.ts gmina renamed-classes    switch one portal to a changed version
 *   npx tsx lab/mutate.ts gmina v1                 back to the original
 *   npx tsx lab/mutate.ts reset                    every portal back to the original
 *   add --refresh to ask Watchtower to read the portal again right away (else it notices on its next read)
 *
 * LAB (default http://localhost:4100) and WATCHTOWER (default http://localhost:8080) set the addresses.
 */
import { fileURLToPath } from "node:url";

const LAB = process.env.LAB ?? "http://localhost:4100";
const WATCHTOWER = process.env.WATCHTOWER ?? "http://localhost:8080";

export interface LabState {
  portals: Array<{ slug: string; url: string; variant: string; variants: Record<string, string>; requests: number; maxPerSecond: number }>;
}

export async function labState(lab = LAB): Promise<LabState> {
  const r = await fetch(`${lab}/_lab/state`).catch(() => null);
  if (!r?.ok) throw new Error(`The lab is not running at ${lab}. Start it with: npm run lab`);
  return (await r.json()) as LabState;
}

/** Switches a portal; returns the description of the change. */
export async function mutate(slug: string, variant: string, lab = LAB): Promise<string> {
  const r = await fetch(`${lab}/_lab/variant?portal=${encodeURIComponent(slug)}&v=${encodeURIComponent(variant)}`, { method: "POST" });
  const body = (await r.json()) as { change?: string; error?: string; variants?: string[] };
  if (!r.ok) throw new Error(`${body.error}${body.variants ? `. Choose one of: ${body.variants.join(", ")}` : ""}`);
  return body.change ?? "";
}

/** Asks Watchtower to read the lab portal now (adds it if it is not watched yet). Returns the run id. */
export async function refresh(slug: string, lab = LAB, api = WATCHTOWER): Promise<string> {
  const add = await fetch(`${api}/portals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `${lab}/${slug}/` }) });
  const { id } = (await add.json()) as { id: string };
  const r = await fetch(`${api}/portals/${id}/refresh`, { method: "POST" });
  return ((await r.json()) as { runId: string }).runId;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const wantRefresh = process.argv.includes("--refresh");
  const state = await labState();

  if (args.length === 0) {
    for (const p of state.portals) {
      console.log(`\n${p.slug}  (now: ${p.variant})  ${p.url}`);
      for (const [v, what] of Object.entries(p.variants)) console.log(`  ${v === p.variant ? "*" : " "} ${v.padEnd(16)} ${what}`);
    }
    console.log("\nSwitch with: npx tsx lab/mutate.ts <portal> <change> [--refresh]");
    return;
  }

  const targets: Array<[string, string]> =
    args[0] === "reset" ? state.portals.map((p) => [p.slug, "v1"]) : [[args[0]!, args[1] ?? "v1"]];
  for (const [slug, v] of targets) {
    const change = await mutate(slug, v);
    console.log(`${slug} → ${v}: ${change}`);
    if (wantRefresh) {
      const runId = await refresh(slug).catch((e: Error) => `not refreshed (${e.message})`);
      console.log(`  Watchtower read started: ${runId}`);
    }
  }
}

const self = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
if ((process.argv[1] ?? "").replace(/\\/g, "/").toLowerCase() === self) {
  main().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
