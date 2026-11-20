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
import { removeTemp } from "./testkit.js";
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
  removeTemp(process.env.DATA_DIR!);
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
  const before = store.listTenders("p2")[0]!;

  // T1 now has 2 refs; 3 new tenders with 1 ref each take the whole budget of 3 first.
  const changed = { ...tender(1, 2), publicationDate: "2026-11-01", title: "Revised title" };
  const out = await deliver("p2", read([changed, tender(7, 1), tender(8, 1), tender(9, 1)]), ctx());
  const t1 = store.listTenders("p2").find((t) => t.id === "T1")!;
  assert.deepEqual(t1, before, "T1 must keep serving its whole previous snapshot");
  assert.equal(out.pendingNew, 0);
  assert.equal(out.documentsPending, true, "known tenders with deferred updates also need a fast follow-up");
  assert.match(out.summary, /Document updates for 1 tender are on their way/);

  await deliver("p2", read([changed, tender(7, 1), tender(8, 1), tender(9, 1)]), ctx());
  assert.equal(store.listTenders("p2").find((t) => t.id === "T1")!.documents.length, 2, "T1 gets its new documents in the next read");
});

// ------------------------------------------------------------ edge cases

let portalNo = 0;
function newPortal(): string {
  const id = `edge${++portalNo}`;
  store.insertPortal({ id, url: `https://${id}.example/`, state: "integrating", reason: "Attaching.", createdAt: "2026-11-20T18:00:00+01:00" });
  return id;
}
const byId = (p: string) => Object.fromEntries(store.listTenders(p).map((t) => [t.id, t]));

test("pending document references never update or publish a tender", async () => {
  const p = newPortal();
  await deliver(p, read([tender(1, 0)]), ctx());
  const before = store.listTenders(p);
  const pending = { ...tender(1, 0), title: "Unverified update", documentRefsPending: true };
  const out = await deliver(p, read([pending, { ...pending, id: "T2" }]), ctx());
  assert.deepEqual(store.listTenders(p), before);
  assert.equal(out.documentsPending, true);
});

test("the first of two tenders with the same id wins", async () => {
  const p = newPortal();
  await deliver(p, read([{ ...tender(1, 0), title: "First" }, { ...tender(1, 0), title: "Second" }]), ctx());
  assert.equal(store.listTenders(p).length, 1);
  assert.equal(byId(p).T1!.title, "First");
});

test("withdrawn and passed-deadline tenders get their status; a deadline without offset is dropped, not trusted", async () => {
  const p = newPortal();
  await deliver(
    p,
    read([
      { ...tender(1, 0), withdrawn: true },
      { ...tender(2, 0), submissionDeadline: "2025-01-10T12:00:00+01:00" },
      { ...tender(3, 0), submissionDeadline: "2025-01-10T12:00:00" },
    ]),
    ctx(),
  );
  const t = byId(p);
  assert.equal(t.T1!.status, "withdrawn");
  assert.equal(t.T2!.status, "closed");
  assert.equal(t.T3!.submissionDeadline, null, "a time without offset must not be served");
  assert.equal(t.T3!.status, "open", "an untrusted deadline must not close a tender");
});

test("tenders without a usable id or address are left out, the rest are served", async () => {
  const p = newPortal();
  const out = await deliver(p, read([{ ...tender(1, 0), id: "" }, { ...tender(2, 0), url: "/relative/path" }, tender(3, 0)]), ctx());
  assert.deepEqual(Object.keys(byId(p)), ["T3"]);
  assert.match(out.summary, /^Serving 1 open tender \(1 new, 0 changed\)\./);
});

test("impossible dates become null and an impossible deadline cannot close a tender", async () => {
  const p = newPortal();
  await deliver(p, read([
    { ...tender(1, 0), publicationDate: "2025-02-29", submissionDeadline: "2025-04-31T09:00:00+02:00" },
    { ...tender(2, 0), publicationDate: "2024-02-29", submissionDeadline: "2025-04-30T09:00:00+25:00" },
  ]), ctx());
  const { T1, T2 } = byId(p);
  assert.equal(T1!.publicationDate, null);
  assert.equal(T1!.submissionDeadline, null);
  assert.equal(T1!.status, "open");
  assert.equal(T2!.publicationDate, "2024-02-29");
  assert.equal(T2!.submissionDeadline, null);
  assert.equal(T2!.status, "open");
});

test("invalid optional fields are dropped, not served", async () => {
  const p = newPortal();
  await deliver(p, read([{ ...tender(1, 0), cpvCodes: ["4500000-7"], procedureType: "Openbaar" as never, title: "" }]), ctx());
  const t = byId(p).T1!;
  assert.equal(t.cpvCodes, undefined);
  assert.equal(t.procedureType, undefined);
  assert.equal(t.title, null, "an empty title is a missing title");
});

test("a failed document fetch is retried in the next read and then recovers", async () => {
  const p = newPortal();
  let fail = true;
  const flaky = http.createServer((req, res) => {
    if (req.url === "/robots.txt") return void res.writeHead(404).end();
    if (fail) return void res.writeHead(503).end("busy");
    res.writeHead(200, { "content-type": "application/pdf", "content-disposition": 'attachment; filename="ok.pdf"' }).end("%PDF-1.4\nok");
  });
  await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}/doc.pdf`;
  try {
    const t = { ...tender(1, 0), documentRefs: [{ url, via: "http" as const }] };
    const first = await deliver(p, read([t]), ctx());
    assert.equal(first.documentFailures.length, 1, "first try failed");
    assert.equal(store.getTenderRow(p, "T1"), undefined, "do not publish the tender with an incomplete document list");
    fail = false;
    const again = await deliver(p, read([t]), ctx());
    assert.equal(byId(p).T1!.documents.length, 1, "second read fetched it");
    assert.notEqual(store.getTenderRow(p, "T1")!.refs_hash, "");
    assert.match(again.summary, /\(1 new, 0 changed\)/);
  } finally {
    flaky.close();
  }
});

test("lastChangedAt stays the same when nothing changed", async () => {
  const p = newPortal();
  await deliver(p, read([tender(1, 0)]), ctx());
  const first = byId(p).T1!.lastChangedAt;
  await new Promise((r) => setTimeout(r, 1100));
  const out = await deliver(p, read([tender(1, 0)]), ctx());
  assert.equal(byId(p).T1!.lastChangedAt, first);
  assert.match(out.summary, /\(0 new, 0 changed\)/);
});

test("a tender missing after a full read is closed; after a capped read it stays open", async () => {
  const { Recipe } = await import("../shared/recipe.js");
  const recipe = Recipe.parse({
    schemaVersion: 1,
    tier: "jsonApi",
    timeZone: "Europe/Amsterdam",
    list: { request: { url: "https://x.example/api?page={page}" }, pagination: { type: "pageParam", start: 0, maxPages: 2 }, item: "$.items[*]" },
    listFields: { id: { jsonPath: "$.id" } },
  });
  const capped = newPortal();
  store.saveRecipe(capped, recipe, "attach", "test", "2026-11-20T18:00:00+01:00");
  await deliver(capped, read([tender(1, 0), tender(2, 0)]), ctx());
  const cappedRead = read([tender(1, 0)]);
  cappedRead.diagnostics.listPages = 2; // hit maxPages: older tenders were not seen
  await deliver(capped, cappedRead, ctx());
  assert.equal(byId(capped).T2!.status, "open");
  const emptyCappedRead = read([]);
  emptyCappedRead.diagnostics.listPages = 2;
  const emptyCapped = await deliver(capped, emptyCappedRead, ctx());
  assert.equal(store.countTenders(capped), 2);
  assert.match(emptyCapped.summary, /^This read found 0 open tenders; keeping 2 delivered tenders available \(2 still marked open\)\./);

  const full = newPortal();
  store.saveRecipe(full, recipe, "attach", "test", "2026-11-20T18:00:00+01:00");
  await deliver(full, read([tender(1, 0), tender(2, 0)]), ctx());
  await deliver(full, read([tender(1, 0)]), ctx()); // 1 page of 2 allowed: the whole list
  assert.equal(byId(full).T2!.status, "closed");
});

test("an empty read distinguishes open tenders from all tenders still delivered", async () => {
  const p = newPortal();
  await deliver(p, read([tender(1, 0), tender(2, 0)]), ctx());

  const { summary } = await deliver(p, read([]), ctx());

  assert.equal(store.countTenders(p), 2);
  assert.deepEqual(store.listTenders(p).map((t) => t.status), ["closed", "closed"]);
  assert.match(summary, /^This read found 0 open tenders; keeping 2 delivered tenders available \(0 still marked open\)\./);
});

test("an abort in the middle of delivery closes nothing", async () => {
  const p = newPortal();
  await deliver(p, read([tender(1, 0), tender(2, 0)]), ctx());
  const c = new AbortController();
  c.abort();
  const aborted = { http: politeHttp(c.signal), browser: politeBrowser(c.signal), signal: c.signal, log: () => {} } as unknown as PortalContext;
  await deliver(p, read([]), aborted);
  assert.deepEqual(store.listTenders(p).map((t) => t.status), ["open", "open"]);
});

test("an aborted delivery leaves the baseline alone", async () => {
  const p = newPortal();
  await deliver(p, read([tender(1, 0), tender(2, 0)]), ctx());
  const before = store.getBaseline(p);
  const c = new AbortController();
  c.abort();
  const aborted = { http: politeHttp(c.signal), browser: politeBrowser(c.signal), signal: c.signal, log: () => {} } as unknown as PortalContext;
  const out = await deliver(p, read([tender(1, 0)]), aborted);
  assert.deepEqual(store.getBaseline(p), before);
  assert.equal(out.pendingNew, 0);
});

test("a full read of a date window does not close an open tender published before the window", async () => {
  const p = newPortal();
  await deliver(p, read([tender(1, 0), tender(8, 0), tender(9, 0)]), ctx());
  // The portal now only lists the last days: T1 (published Nov 1) fell out of the window.
  await deliver(p, read([tender(8, 0), tender(9, 0)]), ctx());
  assert.equal(byId(p).T1!.status, "open");
  // T9 is inside the window seen by the read, so missing does mean gone.
  await deliver(p, read([tender(8, 0)]), ctx());
  assert.equal(byId(p).T9!.status, "closed");
});

test("a tender whose refs this read did not look for is held back when new, kept as it was when known", async () => {
  const p = newPortal();
  const known = { ...tender(1, 1), referenceNumber: "2026/001" };
  await deliver(p, read([known]), ctx());
  const before = byId(p).T1!;
  assert.equal(before.documents.length, 1);

  // Detail cap: T1 comes with list values only and no refs; T2 is new and in the same state.
  const skipped = (t: ExtractedTender): ExtractedTender => ({ ...t, documentRefs: [], referenceNumber: undefined, documentRefsPending: true });
  const out = await deliver(p, read([skipped(known), skipped(tender(2, 1))]), ctx());
  const after = byId(p);
  assert.equal(after.T2, undefined, "a new tender without its documents must not be served");
  assert.deepEqual(after.T1!.documents, before.documents, "a known tender keeps its documents");
  assert.equal(after.T1!.referenceNumber, "2026/001", "a known tender keeps its detail values");
  assert.equal(after.T1!.lastChangedAt, before.lastChangedAt, "nothing changed");
  assert.equal(out.pendingNew, 2, "a pending read brings the next read forward");

  // The next read has the details again: nothing is fetched twice, T2 arrives with its document.
  const next = await deliver(p, read([known, tender(2, 1)]), ctx());
  assert.equal(byId(p).T2!.documents.length, 1);
  assert.equal(byId(p).T1!.lastChangedAt, before.lastChangedAt);
  assert.equal(next.pendingNew, 0);
});

test("document problems: a few keep serving, most login walls fail, most other failures repair", async () => {
  const { classifyDocumentFailures } = await import("./orchestrator.js");
  const login = { blocked: true, tenderId: "t", detail: "Documents need a login: x shows a login page instead of the file." };
  const other = { blocked: false, tenderId: "t", detail: "Could not download x: 404." };
  assert.equal(classifyDocumentFailures([login], 100), null);
  assert.equal(classifyDocumentFailures([login, login], 3)?.kind, "blocked");
  assert.match(classifyDocumentFailures([login, login], 3)!.reason, /^Documents need a login/);
  assert.equal(classifyDocumentFailures([other, other, other], 4)?.kind, "broken");
  assert.equal(classifyDocumentFailures([other, login], 4), null);
  assert.equal(classifyDocumentFailures([other, login], 3)?.kind, "broken", "mixed failures must not hide a majority outage");
  assert.equal(classifyDocumentFailures([], 0), null);
});

test("a minority of partial document failures cannot publish incomplete new or updated tenders", async (t) => {
  const p = newPortal();
  const { documentFetcher } = await import("./documents.js");
  const makeDoc = (name: string) => ({ fileName: name, sizeBytes: 10, sha256: "a".repeat(64), path: `/files/${"a".repeat(64)}` });
  const old = makeDoc("original.pdf");
  const replacement = makeDoc("replacement.pdf");
  const mock = t.mock.method(documentFetcher, "fetchAll", async (refs: ExtractedTender["documentRefs"]) => {
    if (refs[0]?.url.endsWith("original")) return { documents: [old], problems: [] };
    if (refs[0]?.url.endsWith("partial")) return { documents: [replacement], problems: ["Could not download one attachment."] };
    return { documents: [replacement], problems: [] };
  });
  const withRef = (n: number, name: string) => ({ ...tender(n, 0), documentRefs: [{ url: `${base}/${name}`, via: "http" as const }] });
  await deliver(p, read([withRef(1, "original")]), ctx());
  const original = byId(p).T1;

  const first = [withRef(1, "partial"), withRef(2, "full"), withRef(3, "full")];
  const out = await deliver(p, read(first), ctx());
  assert.equal(out.documentFailures.length, 1);
  assert.equal(out.documentsFetched, 3);
  assert.equal(out.documentsPending, true, "partial failures get a fast follow-up without claiming a clean read");
  assert.deepEqual(byId(p).T1, original);
  assert.deepEqual(byId(p).T2!.documents, [replacement]);

  const next = [...first, withRef(4, "partial"), withRef(5, "full")];
  const checked = await deliver(p, read(next), ctx());
  assert.equal(checked.documentFailures.length, 2, "the previous failure gets retried");
  assert.equal(mock.mock.callCount(), 7);
  assert.equal(byId(p).T4, undefined);
});

test("robots.txt on document downloads counts as a block, not a repair", async () => {
  const { classifyDocumentFailures } = await import("./orchestrator.js");
  const robots = { blocked: true, tenderId: "t", detail: "Could not download https://p.example/file/get_new/1: robots.txt disallows /file/get_new/1." };
  assert.equal(classifyDocumentFailures([robots, robots], 3)?.kind, "blocked");
  assert.match(classifyDocumentFailures([robots, robots], 3)!.reason, /robots\.txt disallows/);
});
