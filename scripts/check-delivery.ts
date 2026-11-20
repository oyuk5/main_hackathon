/** Independently compare a registered portal's public delivery with lab truth. Never changes the portal. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { PortalEntry, TenderList } from "../src/shared/contract.js";

const [portalId, truthUrl] = process.argv.slice(2);
if (!portalId || !truthUrl) throw new Error("Usage: BASE=http://localhost:8080 npx tsx scripts/check-delivery.ts <portal-id> <lab-truth-url>");
const api = new URL(process.env.BASE ?? "http://localhost:8080");
const portal = new URL(`/portals/${encodeURIComponent(portalId)}`, api);
const truthSchema = z.object({ tenders: z.array(z.object({
  url: z.string().url(),
  status: z.enum(["open", "closed", "withdrawn"]),
  documents: z.array(z.object({ fileName: z.string(), sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
})) });

async function request(url: string | URL) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res;
}

const [entry, delivery, truth] = await Promise.all([
  request(portal).then((res) => res.json()).then((body) => PortalEntry.parse(body)),
  request(`${portal}/tenders`).then((res) => res.json()).then((body) => TenderList.parse(body)),
  request(truthUrl).then((res) => res.json()).then((body) => truthSchema.parse(body)),
]);

// A container may reach the lab via a different hostname; compare paths on this single portal.
const tenderKey = (href: string) => { const url = new URL(href); return url.pathname + url.search; };
const documentKey = (doc: { fileName: string; sizeBytes: number; sha256: string }) => JSON.stringify([doc.fileName, doc.sizeBytes, doc.sha256]);
const actual = new Map<string, typeof delivery>();
for (const item of delivery) {
  const key = tenderKey(item.url);
  actual.set(key, [...(actual.get(key) ?? []), item]);
}
let tendersMatched = 0;
let filesMatched = 0;
const errors: string[] = [];
const checked = new Set<string>();
for (const expected of truth.tenders) {
  const key = tenderKey(expected.url);
  const matches = actual.get(key) ?? [];
  actual.delete(key);
  const item = matches[0];
  if (!item || matches.length !== 1) {
    errors.push(`${key}: expected one tender, found ${matches.length}`);
    continue;
  }
  if (item.status !== expected.status) errors.push(`${key}: expected ${expected.status}, got ${item.status}`);
  else tendersMatched++;
  const remaining = [...item.documents];
  for (const doc of expected.documents) {
    const index = remaining.findIndex((candidate) => documentKey(candidate) === documentKey(doc));
    if (index < 0) {
      errors.push(`${key}: missing or incorrect attachment ${doc.fileName}`);
      continue;
    }
    const [found] = remaining.splice(index, 1);
    try {
      const path = `/files/${doc.sha256}`;
      if (found!.path !== path) throw new Error("unexpected file path");
      if (!checked.has(path)) {
        const res = await request(new URL(path, api));
        const hash = createHash("sha256");
        let size = 0;
        if (!res.body) throw new Error("file response has no body");
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            hash.update(value);
            size += value.length;
          }
        } finally {
          reader.releaseLock();
        }
        if (size !== doc.sizeBytes || hash.digest("hex") !== doc.sha256) throw new Error("served bytes do not match the expected size and SHA-256");
        checked.add(path);
      }
      filesMatched++;
    } catch (error) {
      errors.push(`${key}: ${doc.fileName}: ${String(error)}`);
    }
  }
  for (const extra of remaining) errors.push(`${key}: unexpected attachment ${extra.fileName}`);
}
for (const key of actual.keys()) errors.push(`${key}: unexpected tender`);
const expectedFiles = truth.tenders.reduce((sum, item) => sum + item.documents.length, 0);
console.log(JSON.stringify({ state: entry.state, reason: entry.reason, tendersMatched, expectedTenders: truth.tenders.length, filesVerified: filesMatched, expectedFiles, errors }, null, 2));
if (entry.state !== "serving" || errors.length || !truth.tenders.length) process.exitCode = 1;