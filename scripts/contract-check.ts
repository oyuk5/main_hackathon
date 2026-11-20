/**
 * Checks a running server against the brief's exact API answers.
 *   npm run dev            (in one terminal)
 *   npm run test:contract  (in another; BASE=http://localhost:8080 by default)
 * Optional: PORTAL_URL=https://... to attach a specific portal.
 */
import { AddPortalResponse, PortalEntry, PortalList, RefreshResponse, RunList, TenderList } from "../src/shared/contract.js";
import type { ZodType } from "zod";

const BASE = process.env.BASE ?? "http://localhost:8080";
const PORTAL = process.env.PORTAL_URL ?? "https://example.org/tenders";
let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function shape<T>(name: string, schema: ZodType<T>, value: unknown) {
  const r = schema.safeParse(value);
  check(name, r.success, r.success ? "" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
}

const add = await call("POST", "/portals", { url: PORTAL });
check("POST /portals answers 201", add.status === 201, `got ${add.status}`);
shape("POST /portals body", AddPortalResponse, add.json);
const id = add.json?.id as string;

const again = await call("POST", "/portals", { url: PORTAL + "/" });
check("same address twice gives the same id", again.json?.id === id);

const list = await call("GET", "/portals");
check("GET /portals answers 200", list.status === 200);
shape("GET /portals body", PortalList, list.json);

const one = await call("GET", `/portals/${id}`);
shape("GET /portals/{id} body", PortalEntry, one.json);

const missing = await call("GET", "/portals/does-not-exist");
check("unknown id answers 404", missing.status === 404);

const r1 = await call("POST", `/portals/${id}/refresh`);
check("refresh answers 202", r1.status === 202, `got ${r1.status}`);
shape("refresh body", RefreshResponse, r1.json);
const r2 = await call("POST", `/portals/${id}/refresh`);
const r1Run = (await call("GET", `/portals/${id}/runs`)).json?.find((r: { id: string }) => r.id === r1.json?.runId);
if (r1Run && r1Run.finishedAt === null) check("refresh during a read returns the same runId", r1.json?.runId === r2.json?.runId);
else console.log("SKIP  refresh during a read (the first read finished too fast to test)");

const runs = await call("GET", `/portals/${id}/runs`);
shape("GET /runs body", RunList, runs.json);
check("first run is a read", runs.json?.at(-1)?.kind === "read");

const tenders = await call("GET", `/portals/${id}/tenders`);
shape("GET /tenders body", TenderList, tenders.json);
const since = await call("GET", `/portals/${id}/tenders?changedSince=2100-01-01T00:00:00%2B01:00`);
check("changedSince in the future returns []", Array.isArray(since.json) && since.json.length === 0);

if (!process.env.KEEP) {
  const del = await call("DELETE", `/portals/${id}`);
  check("DELETE answers 204", del.status === 204, `got ${del.status}`);
  const gone = await call("GET", `/portals/${id}`);
  check("deleted portal answers 404", gone.status === 404);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll contract checks passed");
process.exit(failures ? 1 : 0);
