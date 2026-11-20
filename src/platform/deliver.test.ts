/**
 * deliver() with the document budget: a big first read serves tenders in batches, newest first,
 * never serves a new tender without its documents, and says how many are still on their way.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ExtractedTender, PortalContext, ReadOutcome } from "../shared/modules.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wt-deliver-"));
process.env.DOC_REFS_PER_READ = "3";

const { deliver } = await import("./orchestrator.js");
const { store } = await import("./store.js");
const { politeBrowser, politeHttp } = await import("./polite.js");

const server = http.createServer((req, res) => {
  if (req.url === "/robots.txt") return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `attachment; filename="${req.url!.slice(1)}"` });
  res.end(`%PDF-1.4 ${req.url}`);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

function tender(n: number, refs: number): ExtractedTender {
  return {
    id: `T${n}`,
    url: `https://portal.example/tenders/${n}`,
    title: `Tender ${n}`,
    buyerName: "Gemeente Voorbeeld",
    publicationDate: `2026-11-${String(n).padStart(2, "0")}`,
    submissionDeadline: "2027-01-15T12:00:00+01:00",
    documentRefs: Array.from({ length: refs }, (_, i) => ({ url: `${base}/t${n}-${i}.pdf`, via: "http" as const })),
  };
}

function read(tenders: ExtractedTender[]): Extract<ReadOutcome, { kind: "ok" }> {
  return { kind: "ok", tenders, diagnostics: { requests: 1, listPages: 1, itemsSeen: tenders.length, fieldFill: {}, durationMs: 1 } };
}

function ctx(): PortalContext {
  const c = new AbortController();
  return { http: politeHttp(c.signal), browser: politeBrowser(c.signal), signal: c.signal, log: () => {} } as unknown as PortalContext;
}

test("a big first read is served in batches, newest first, never without documents", async () => {
  store.insertPortal({ id: "p1", url: "https://portal.example/", state: "integrating", reason: "Attaching.", createdAt: "2026-11-20T18:00:00+01:00" });
  // 5 tenders with 1 document each, and one without documents. Budget: 3 refs per read.
  const all = [1, 2, 3, 4, 5].map((n) => tender(n, 1)).concat(tender(6, 0));

  const first = await deliver("p1", read(all), ctx());
  const ids1 = store.listTenders("p1").map((t) => t.id).sort();
  assert.deepEqual(ids1, ["T3", "T4", "T5", "T6"], "newest three with documents, plus the one without documents");
  assert.equal(first.pendingNew, 2);
  assert.match(first.summary, /Serving 4 open tenders \(4 new, 0 changed\); documents for 2 more tenders are on their way\./);
  for (const t of store.listTenders("p1")) {
    const expected = t.id === "T6" ? 0 : 1;
    assert.equal(t.documents.length, expected, `${t.id} served with the wrong documents`);
  }

  const second = await deliver("p1", read(all), ctx());
  assert.deepEqual(store.listTenders("p1").map((t) => t.id).sort(), ["T1", "T2", "T3", "T4", "T5", "T6"]);
  assert.equal(second.pendingNew, 0);
  assert.match(second.summary, /^Serving 6 open tenders \(2 new, 0 changed\)\. Last read/);
});

test("a known tender whose documents changed keeps its old documents until its turn", async () => {
  store.insertPortal({ id: "p2", url: "https://portal2.example/", state: "integrating", reason: "Attaching.", createdAt: "2026-11-20T18:00:00+01:00" });
  await deliver("p2", read([tender(1, 1)]), ctx());
  const before = store.listTenders("p2")[0]!.documents;

  // T1 now has 2 refs; 3 new tenders with 1 ref each take the whole budget of 3 first.
  const changed = { ...tender(1, 2), publicationDate: "2026-11-01" };
  const out = await deliver("p2", read([changed, tender(7, 1), tender(8, 1), tender(9, 1)]), ctx());
  const t1 = store.listTenders("p2").find((t) => t.id === "T1")!;
  assert.deepEqual(t1.documents, before, "T1 must keep serving its last documents");
  assert.equal(out.pendingNew, 0);

  await deliver("p2", read([changed, tender(7, 1), tender(8, 1), tender(9, 1)]), ctx());
  assert.equal(store.listTenders("p2").find((t) => t.id === "T1")!.documents.length, 2, "T1 gets its new documents in the next read");
});
