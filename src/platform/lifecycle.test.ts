/** Public API and worker together, with deterministic Attach and Medic outcomes. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AttachOutcome, DocumentRef, ReadOutcome, RepairOutcome } from "../shared/modules.js";
import type { Recipe } from "../shared/recipe.js";
import { fakePortal, file, removeTemp, zip } from "./testkit.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-lifecycle-"));
process.env.DATA_DIR = dataDir;
const { buildServer } = await import("./server.js");
const { orchestrator } = await import("./orchestrator.js");
const { cartographer, extractor } = await import("../attach/index.js");
const { medic, watch } = await import("../watch/index.js");
const app = await buildServer();
after(async () => {
  await app.close();
  removeTemp(dataDir);
});

type OkRead = Extract<ReadOutcome, { kind: "ok" }>;
function read(url: string, title: string, documentRefs: DocumentRef[] = []): OkRead {
  return {
    kind: "ok",
    tenders: [{ id: "T1", url: `${url}tenders/1`, title, buyerName: "City Works", publicationDate: "2026-11-01", submissionDeadline: null, documentRefs }],
    diagnostics: { requests: 1, listPages: 1, itemsSeen: 1, fieldFill: { title: { filled: 1, total: 1 } }, durationMs: 1 },
  };
}

function attached(url: string, result = read(url, "Original title")): Extract<AttachOutcome, { kind: "ok" }> {
  const recipe: Recipe = {
    schemaVersion: 1, family: null, tier: "html", timeZone: "Europe/Berlin", countryCode: "DE",
    list: { request: { url, method: "GET" }, pagination: { type: "none" }, item: "article", emptyText: [] },
    listFields: { id: { css: ".id" }, title: { css: "h2" }, url: { css: "a", attr: "href", parse: "url" } },
    detail: null, documents: null, withdrawnText: [],
  };
  return { kind: "ok", recipe, golden: [], read: result, note: "Learned the tender list." };
}

const get = (url: string) => app.inject({ method: "GET", url });
const remove = (url: string) => app.inject({ method: "DELETE", url });
async function add(url: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/portals", payload: { url } });
  assert.equal(res.statusCode, 201);
  return res.json().id;
}
async function refresh(id: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/portals/${id}/refresh` });
  assert.equal(res.statusCode, 202);
  return res.json().runId;
}
async function waitForIdle(id: string) {
  const deadline = Date.now() + 8_000;
  while (orchestrator.isBusy(id) && Date.now() < deadline) await delay(10);
  assert.equal(orchestrator.isBusy(id), null, `Worker for ${id} did not finish`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("DELETE closes a live document transfer and skips the remaining download", { timeout: 12_000 }, async (t) => {
  const started = deferred<void>();
  const closed = deferred<void>();
  const unwound = deferred<void>();
  const fake = await fakePortal({
    "/slow.pdf": (_req, res) => {
      res.once("close", closed.resolve);
      res.writeHead(200, { "content-type": "application/pdf" });
      res.write("%PDF still downloading");
      started.resolve();
    },
    "/next.pdf": (_req, res) => res.end("%PDF should not be requested"),
  });
  const url = `${fake.base}/`;
  const result = read(url, "Downloading", ["slow.pdf", "next.pdf"].map((name) => ({ url: url + name, via: "http" })));
  t.mock.method(cartographer, "attach", async () => attached(url, result));
  const { documentFetcher } = await import("./documents.js");
  const fetchAll = documentFetcher.fetchAll.bind(documentFetcher);
  t.mock.method(documentFetcher, "fetchAll", async (...args: Parameters<typeof fetchAll>) => {
    try {
      return await fetchAll(...args);
    } finally {
      unwound.resolve();
    }
  });
  const id = await add(url);
  const portal = `/portals/${id}`;
  try {
    await started.promise;
    const runs = (await get(`${portal}/runs`)).json();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].kind, "read");
    assert.equal(runs[0].result, null);
    assert.equal(runs[0].finishedAt, null);
    assert.equal(await refresh(id), runs[0].id);
    assert.equal((await remove(portal)).statusCode, 204);
    await Promise.all([closed.promise, unwound.promise]);
    assert.deepEqual(fake.hits, ["/robots.txt", "/slow.pdf"]);
    assert.equal((await get(portal)).statusCode, 404);
    assert.equal((await get(`${portal}/runs`)).statusCode, 404);
  } finally {
    await remove(portal);
    await fake.close();
  }
});

test("a healthy listing with a document login wall reports failed, not serving", { timeout: 12_000 }, async (t) => {
  const fake = await fakePortal({
    "/document": (_req, res) => res.writeHead(200, { "content-type": "text/html" })
      .end('<html><title>Login</title><form><input type="password"></form></html>'),
  });
  const url = `${fake.base}/`;
  const listed = read(url, "Listed tender", [{ url: `${url}document`, via: "http" }]);
  // A tender with no file to download is not a successful download in the block-rate denominator.
  const noFiles = read(url, "Tender without attachments").tenders[0]!;
  listed.tenders.push({ ...noFiles, id: "T2", url: `${url}tenders/2` });
  listed.diagnostics.itemsSeen = 2;
  listed.diagnostics.fieldFill.title = { filled: 2, total: 2 };
  t.mock.method(cartographer, "attach", async () => attached(url, listed));
  const repair = t.mock.method(medic, "repair", async () => ({ kind: "failed", reason: "Unexpected repair." }));
  const id = await add(url);
  const portal = `/portals/${id}`;
  try {
    await waitForIdle(id);
    const entry = (await get(portal)).json();
    assert.equal(entry.state, "failed");
    assert.match(entry.reason, /documents need a login/i);
    assert.equal(entry.lastSuccessAt, null);
    assert.deepEqual((await get(`${portal}/tenders`)).json(), []);
    assert.equal(repair.mock.callCount(), 0);
    const runs = (await get(`${portal}/runs`)).json();
    assert.deepEqual(runs.map(({ kind, result }: { kind: string; result: string }) => [kind, result]), [["read", "failed"]]);
  } finally {
    await remove(portal);
    await fake.close();
  }
});

test("DELETE cancels the backoff before a second extraction attempt", { timeout: 10_000 }, async (t) => {
  const url = "https://backoff.example/";
  t.mock.method(cartographer, "attach", async () => attached(url));
  const attempted = deferred<void>();
  const extraction = t.mock.method(extractor, "read", async () => {
    attempted.resolve();
    return { kind: "unreachable", reason: "Portal is temporarily unavailable." };
  });
  const id = await add(url);
  const portal = `/portals/${id}`;
  try {
    await waitForIdle(id);
    const runId = await refresh(id);
    await attempted.promise;
    const detail = (await get(`/internal/portals/${id}`)).json();
    assert.ok(detail.events.some((event: { run_id: string; message: string }) =>
      event.run_id === runId && /Trying again in 5 s/.test(event.message)));

    assert.equal((await remove(portal)).statusCode, 204);
    await delay(5_100); // Wait past the first retry boundary; this used to call the extractor again.
    assert.equal(extraction.mock.callCount(), 1);
    assert.equal((await get(portal)).statusCode, 404);
  } finally {
    await remove(portal);
  }
});

for (const passesRecheck of [false, true]) {
  test(`a repair ${passesRecheck ? "publishes only after verification" : "that fails verification keeps the last good read"}`, async (t) => {
    const url = `https://repair-${passesRecheck}.example/`;
    const initial = attached(url);
    const broken: ReadOutcome = { kind: "error", reason: "The tender list moved." };
    const fixed = read(url, "Verified replacement title");
    const pending = deferred<RepairOutcome>();
    t.mock.method(cartographer, "attach", async () => initial);
    t.mock.method(extractor, "read", async () => broken);
    t.mock.method(watch, "evaluate", (result: ReadOutcome) =>
      result === initial.read || (result === fixed && passesRecheck)
        ? { kind: "healthy", reason: "The list passed the checks.", checks: [] }
        : { kind: "broken", reason: "The list failed the checks.", checks: [] });
    t.mock.method(medic, "repair", () => pending.promise);

    const id = await add(url);
    const portal = `/portals/${id}`;
    const snapshot = async () => (await get(`${portal}/tenders`)).json();
    try {
      await waitForIdle(id);
      const before = await snapshot();
      assert.deepEqual(before.map(({ title }: { title: string }) => title), ["Original title"]);
      const lastSuccess = (await get(portal)).json().lastSuccessAt;
      assert.ok(lastSuccess);

      const readRunId = await refresh(id);
      const runs = (await get(`${portal}/runs`)).json();
      assert.equal(runs[0].kind, "repair");
      assert.equal(runs[0].result, null);
      assert.notEqual(runs[0].id, readRunId);
      assert.equal(await refresh(id), runs[0].id);
      assert.equal((await get(portal)).json().state, "healing");
      assert.deepEqual(await snapshot(), before);

      pending.resolve({ kind: "ok", recipe: { ...initial.recipe, list: { ...initial.recipe.list, item: "li.tender" } }, read: fixed, summary: "Found the relocated list." });
      await waitForIdle(id);
      const entry = (await get(portal)).json();
      assert.equal(entry.state, passesRecheck ? "serving" : "failed");
      if (passesRecheck) {
        assert.deepEqual((await snapshot()).map(({ title }: { title: string }) => title), ["Verified replacement title"]);
      } else {
        assert.deepEqual(await snapshot(), before);
        assert.equal(entry.lastSuccessAt, lastSuccess);
      }
      const completed = (await get(`${portal}/runs`)).json();
      assert.deepEqual(completed.map(({ id, kind, result }: { id: string; kind: string; result: string }) => [id, kind, result]), [
        [runs[0].id, "repair", passesRecheck ? "ok" : "failed"],
        [readRunId, "read", "failed"],
        [runs[2].id, "read", "ok"],
      ]);
      assert.ok(completed[0].finishedAt);
    } finally {
      await remove(portal);
      pending.resolve({ kind: "failed", reason: "Test ended before verification." });
    }
  });
}

test("a repair that cannot fetch its documents does not replace the last good delivery or recipe", { timeout: 12_000 }, async (t) => {
  const fake = await fakePortal({
    "/original.pdf": file("%PDF-1.4\noriginal", "original.pdf"),
    "/replacement.pdf": (_req, res) => res.writeHead(200, { "content-type": "text/html" })
      .end('<html><title>Login</title><form><input type="password"></form></html>'),
  });
  const url = `${fake.base}/`;
  const initial = attached(url, read(url, "Original title", [{ url: `${url}original.pdf`, via: "http" }]));
  const fixed = read(url, "Speculative title", [{ url: `${url}replacement.pdf`, via: "http" }]);
  t.mock.method(cartographer, "attach", async () => initial);
  t.mock.method(extractor, "read", async () => ({ kind: "error", reason: "The list moved." }));
  const repair = t.mock.method(medic, "repair", async () => ({
    kind: "ok", recipe: { ...initial.recipe, list: { ...initial.recipe.list, item: "li.tender" } },
    read: fixed, summary: "Found the relocated list.",
  }));
  const id = await add(url);
  const portal = `/portals/${id}`;
  try {
    await waitForIdle(id);
    const before = (await get(`${portal}/tenders`)).json();
    assert.equal(before[0].documents.length, 1);
    const entry = (await get(portal)).json();
    assert.equal(entry.state, "serving");

    await refresh(id);
    await waitForIdle(id);
    const after = (await get(portal)).json();
    assert.equal(after.state, "failed");
    assert.match(after.reason, /documents need a login/i);
    assert.equal(after.lastSuccessAt, entry.lastSuccessAt);
    assert.deepEqual((await get(`${portal}/tenders`)).json(), before);
    assert.equal((await get(`/internal/portals/${id}`)).json().recipes.length, 1);
    const [latest] = (await get(`${portal}/runs`)).json();
    assert.equal(latest.kind, "repair");
    assert.equal(latest.result, "failed");
    assert.equal(repair.mock.callCount(), 1);
  } finally {
    await remove(portal);
    await fake.close();
  }
});

for (const failure of ["missing golden match", "dropped attachments", "lost cancellation"] as const) {
  test(`repair rejects ${failure}, then refreshes probe without calling Medic again`, async (t) => {
    const fake = await fakePortal({ "/original.pdf": file("%PDF-1.4\noriginal", "original.pdf") });
    const url = `${fake.base}/`;
    const initial = attached(url, read(url, "Original title", [{ url: `${url}original.pdf`, via: "http" }]));
    initial.golden = [{ id: "T1", fields: { title: "Original title", url: `${url}tenders/1` } }];
    if (failure === "lost cancellation") initial.read.tenders[0] = { ...initial.read.tenders[0]!, withdrawn: true };
    const candidate = failure === "lost cancellation" ? read(url, "Original title", [{ url: `${url}original.pdf`, via: "http" }]) : read(url, "Original title");
    if (failure === "missing golden match") {
      candidate.tenders[0] = { ...candidate.tenders[0]!, id: "unrelated", url: `${url}different`, title: "Different tender" };
    }
    t.mock.method(cartographer, "attach", async () => initial);
    let restored = false;
    const probe = t.mock.method(extractor, "read", async () => restored ? initial.read : { kind: "error", reason: "The list moved." });
    const repair = t.mock.method(medic, "repair", async ({ baseline }: Parameters<typeof medic.repair>[0]) => {
      assert.deepEqual((baseline as { publishedDocumentCounts?: unknown }).publishedDocumentCounts, { T1: 1 });
      return { kind: "ok", recipe: initial.recipe, read: candidate, summary: "Found the list." };
    });
    const id = await add(url);
    const portal = `/portals/${id}`;
    try {
      await waitForIdle(id);
      const before = (await get(`${portal}/tenders`)).json();
      assert.equal(before[0].documents.length, 1);
      await refresh(id);
      await waitForIdle(id);
      assert.equal((await get(portal)).json().state, "failed");
      assert.match((await get(portal)).json().reason, failure === "missing golden match" ? /previously checked tender/ : failure === "dropped attachments" ? /found no files/ : /cancellation of 1 withdrawn tender/);
      assert.deepEqual((await get(`${portal}/tenders`)).json(), before);
      await refresh(id);
      await waitForIdle(id);
      assert.equal(repair.mock.callCount(), 1);
      assert.equal(probe.mock.callCount(), 2);
      restored = true;
      await refresh(id);
      await waitForIdle(id);
      assert.equal((await get(portal)).json().state, "serving");
    } finally {
      await remove(portal);
      await fake.close();
    }
  });
}

test("ZIP attachments round-trip through the API as individual files and are not re-fetched on an unchanged read", { timeout: 12_000 }, async (t) => {
  const expected = new Map([["spec.pdf", Buffer.from("%PDF-1.4\nspecifications")], ["price.txt", Buffer.from("price,supplier\n")]]);
  const archive = zip({ "spec.pdf": expected.get("spec.pdf")!, "forms.zip": zip({ "price.txt": expected.get("price.txt")! }) });
  const fake = await fakePortal({ "/bundle.zip": file(archive, "bundle.zip", "application/zip") });
  const url = `${fake.base}/`;
  const initial = attached(url, read(url, "Tender with an archive", [{ url: `${url}bundle.zip`, via: "http" }]));
  t.mock.method(cartographer, "attach", async () => initial);
  t.mock.method(extractor, "read", async () => initial.read);
  const id = await add(url);
  const portal = `/portals/${id}`;
  try {
    await waitForIdle(id);
    assert.equal((await get(portal)).json().state, "serving");
    const [tender] = (await get(`${portal}/tenders`)).json();
    assert.equal(tender.documents.length, expected.size);
    for (const doc of tender.documents) {
      const bytes = expected.get(doc.fileName);
      assert.ok(bytes, `Unexpected attachment: ${doc.fileName}`);
      expected.delete(doc.fileName);
      assert.equal(doc.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.equal(doc.sizeBytes, bytes.length);
      const res = await get(doc.path);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.rawPayload, bytes);
    }
    await refresh(id);
    await waitForIdle(id);
    assert.deepEqual(fake.hits, ["/robots.txt", "/bundle.zip"]);
    assert.deepEqual((await get(`${portal}/tenders?changedSince=${encodeURIComponent(tender.lastChangedAt)}`)).json(), []);
    assert.deepEqual((await get(`${portal}/tenders`)).json(), [tender]);
  } finally {
    await remove(portal);
    await fake.close();
  }
});