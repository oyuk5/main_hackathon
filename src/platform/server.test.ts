/**
 * Public API edge cases through Fastify's inject (no port): bad bodies, address variants,
 * changedSince parsing, unknown ids, file access and DELETE.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { removeTemp } from "./testkit.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wt-server-"));

const { buildServer } = await import("./server.js");
const { store } = await import("./store.js");
const { filePath } = await import("./documents.js");
const { normalizeUrl, portalIdFor } = await import("./orchestrator.js");

const app = await buildServer();
after(async () => {
  await app.close();
  removeTemp(process.env.DATA_DIR!);
});

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });
const get = (url: string) => app.inject({ method: "GET", url });

it("needs no authentication: the dashboard's internal routes answer without a login", async () => {
  assert.equal((await get("/internal/overview")).statusCode, 200);
  assert.equal((await get("/auth/config")).statusCode, 404);
});

it("does not attach portals added through the demo API", async () => {
  const demo = await buildServer({ demo: true });
  try {
    const url = "https://demo-must-not-attach.example/";
    assert.equal((await demo.inject({ method: "POST", url: "/portals", payload: { url } })).statusCode, 403);
    assert.equal(store.getPortalByUrl(url), undefined);
  } finally {
    await demo.close();
  }
});

it("returns cached tokens in the internal ledger without changing zero-cache rows", async () => {
  const usage = { portalId: null, runId: null, model: "test", inputTokens: 100, outputTokens: 5, costUsd: 0, at: "2026-11-20T10:00:00+01:00" };
  store.addLlmCall({ ...usage, purpose: "ledger-cached-test", cachedTokens: 60 });
  store.addLlmCall({ ...usage, purpose: "ledger-uncached-test" });
  const response = await get("/internal/ledger");
  assert.equal(response.statusCode, 200);
  const rows = response.json() as { purpose: string; cached_tokens?: number }[];
  assert.equal(rows.find((r) => r.purpose === "ledger-cached-test")?.cached_tokens, 60);
  assert.equal(rows.find((r) => r.purpose === "ledger-uncached-test")?.cached_tokens, undefined);
});

/** A portal with tenders straight in the store, no job running. */
function seeded(id: string, changes: string[]) {
  store.insertPortal({ id, url: `https://${id}.example/`, state: "serving", reason: "Serving.", createdAt: "2026-11-20T09:00:00+01:00" });
  changes.forEach((lastChangedAt, i) => {
    const t = {
      id: `T${i}`, url: `https://${id}.example/t/${i}`, title: `T${i}`, buyerName: "B", publicationDate: "2026-11-01",
      submissionDeadline: "2027-01-01T12:00:00+01:00", status: "open" as const, documents: [], lastChangedAt,
    };
    store.upsertTender(id, t, `h${i}`, "", lastChangedAt);
  });
}

it("reports open and delivered counts separately only on the internal overview", async () => {
  const id = "overview-open-count";
  const at = "2026-11-20T09:00:00+01:00";
  seeded(id, [at, at, at]);
  const [closed, withdrawn] = store.listTenders(id);
  store.upsertTender(id, { ...closed!, status: "closed" }, "closed", "", at);
  store.upsertTender(id, { ...withdrawn!, status: "withdrawn" }, "withdrawn", "", at);
  const overview = (await get("/internal/overview")).json().find((row: { id: string }) => row.id === id);
  assert.equal(overview.tenderCount, 3);
  assert.equal(overview.openCount, 1);
  assert.equal((await get(`/portals/${id}`)).json().openCount, undefined);
});

describe("POST /portals", () => {
  it("rejects a missing, empty or non-URL body with 400", async () => {
    for (const body of [{}, { url: "" }, { url: "not a url" }, { url: 42 }, { address: "https://x.example/" }]) {
      assert.equal((await post("/portals", body)).statusCode, 400, JSON.stringify(body));
    }
  });

  it("rejects addresses that are not http or https with 400", async () => {
    for (const url of ["ftp://portal.example/", "javascript:alert(1)", "mailto:tenders@portal.example", "file:///etc/passwd", "data:text/html,hi"]) {
      assert.equal((await post("/portals", { url })).statusCode, 400, url);
    }
  });

  it("rejects malformed JSON with 400, not 500", async () => {
    const res = await app.inject({ method: "POST", url: "/portals", payload: "{url:", headers: { "content-type": "application/json" } });
    assert.equal(res.statusCode, 400);
  });

  it("gives the same id for spellings of the same address", async () => {
    const ids = new Set<string>();
    for (const url of ["https://Tenders.Example.org/list", "https://tenders.example.org/list/", "https://tenders.example.org:443/list#top", "  https://tenders.example.org/list  "]) {
      const res = await post("/portals", { url });
      assert.equal(res.statusCode, 201, url);
      ids.add(res.json().id);
    }
    assert.equal(ids.size, 1, `got ${[...ids].join(", ")}`);
    assert.equal((await get("/portals")).json().filter((p: { url: string }) => p.url.includes("tenders.example.org")).length, 1);
  });

  it("keeps different paths, queries and schemes apart", () => {
    const a = portalIdFor("https://x.example/a");
    assert.notEqual(a, portalIdFor("https://x.example/b"));
    assert.notEqual(a, portalIdFor("https://x.example/a?lang=en"));
    assert.notEqual(a, portalIdFor("http://x.example/a"));
    assert.equal(normalizeUrl("https://x.example"), "https://x.example/");
  });
});

describe("GET /portals/{id}/tenders?changedSince=", () => {
  seeded("cs", ["2026-11-20T09:00:00+01:00", "2026-11-20T11:00:00+01:00"]);
  const ids = async (q: string) => {
    const res = await get(`/portals/cs/tenders${q}`);
    return { code: res.statusCode, ids: res.statusCode === 200 ? res.json().map((t: { id: string }) => t.id) : null };
  };

  it("filters on an encoded offset, an unencoded one, and Z", async () => {
    assert.deepEqual(await ids("?changedSince=2026-11-20T10:00:00%2B01:00"), { code: 200, ids: ["T1"] });
    assert.deepEqual(await ids("?changedSince=2026-11-20T10:00:00+01:00"), { code: 200, ids: ["T1"] });
    assert.deepEqual(await ids("?changedSince=2026-11-20T09:00:00Z"), { code: 200, ids: ["T1"] });
    assert.deepEqual(await ids("?changedSince=2026-11-20T10:00:00-01:00"), { code: 200, ids: [] });
  });

  it("is strict: a tender changed exactly at the given time is not returned", async () => {
    assert.deepEqual(await ids("?changedSince=2026-11-20T11:00:00%2B01:00"), { code: 200, ids: [] });
  });

  it("an empty changedSince returns everything", async () => {
    assert.deepEqual((await ids("?changedSince=")).ids?.sort(), ["T0", "T1"]);
  });

  it("rejects a time without offset, a date alone, a number and junk with 400", async () => {
    for (const q of ["2026-11-20T10:00:00", "2026-11-20", "1", "yesterday", "2026-13-40T10:00:00%2B01:00"]) {
      assert.equal((await ids(`?changedSince=${q}`)).code, 400, q);
    }
  });

  it("rejects a repeated changedSince with 400, not 500", async () => {
    assert.equal((await ids("?changedSince=2026-11-20T10:00:00Z&changedSince=2026-11-20T11:00:00Z")).code, 400);
  });

  it("rejects impossible calendar dates without rejecting leap day", async () => {
    assert.deepEqual(await ids("?changedSince=2026-02-29T10:00:00Z"), { code: 400, ids: null });
    assert.deepEqual(await ids("?changedSince=2026-04-31T10:00:00%2B01:00"), { code: 400, ids: null });
    assert.deepEqual(await ids("?changedSince=2024-02-29T10:00:00Z"), { code: 200, ids: ["T0", "T1"] });
  });
});

describe("unknown ids and files", () => {
  it("answers 404 for an unknown portal on every portal route", async () => {
    for (const [method, url] of [["GET", "/portals/nope"], ["DELETE", "/portals/nope"], ["POST", "/portals/nope/refresh"], ["GET", "/portals/nope/tenders"], ["GET", "/portals/nope/runs"]] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 404, `${method} ${url}`);
    }
  });

  it("serves a stored file's bytes, and 404 for anything else", async () => {
    const bytes = Buffer.from("%PDF stored");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    fs.mkdirSync(path.dirname(filePath(sha)), { recursive: true });
    fs.writeFileSync(filePath(sha), bytes);
    const ok = await get(`/files/${sha}`);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.rawPayload.toString(), "%PDF stored");
    for (const bad of ["0".repeat(64), sha.toUpperCase(), sha.slice(1), "..%2F..%2Fdb.sqlite", "%2E%2E%2Fpackage.json"]) {
      assert.equal((await get(`/files/${bad}`)).statusCode, 404, bad);
    }
  });
});

describe("DELETE and refresh", () => {
  it("DELETE removes the portal and its tenders; the address can be added again", async () => {
    seeded("gone", ["2026-11-20T09:00:00+01:00"]);
    assert.equal((await app.inject({ method: "DELETE", url: "/portals/gone" })).statusCode, 204);
    assert.equal((await get("/portals/gone")).statusCode, 404);
    assert.equal(store.listTenders("gone").length, 0);
    assert.equal((await app.inject({ method: "DELETE", url: "/portals/gone" })).statusCode, 404);
  });

  it("two refreshes while a job runs give the same runId", async () => {
    const { id } = (await post("/portals", { url: "http://127.0.0.1:9/refresh-test" })).json();
    const a = (await post(`/portals/${id}/refresh`, {})).json().runId;
    const b = (await post(`/portals/${id}/refresh`, {})).json().runId;
    assert.ok(a && b);
    // The stub attach may finish between the two calls; then b is a new run. Both are runs of this portal.
    const runs = (await get(`/portals/${id}/runs`)).json().map((r: { id: string }) => r.id);
    assert.ok(runs.includes(a) && runs.includes(b));
  });
});

describe("GET /internal/log", () => {
  it("lists runs newest first with their events and leaves passing reads out unless all=1", async () => {
    store.insertPortal({ id: "lg", url: "https://lg.example/", state: "serving", reason: "Serving.", createdAt: "2026-11-20T09:00:00+01:00" });
    store.insertRun({ id: "lg-1", portalId: "lg", kind: "read", startedAt: "2026-11-20T09:00:00+01:00" });
    store.finishRun("lg-1", "ok", "2026-11-20T09:00:05+01:00", "Serving 3 open tenders.");
    store.insertRun({ id: "lg-2", portalId: "lg", kind: "read", startedAt: "2026-11-20T10:00:00+01:00" });
    store.addEvent("lg", "lg-2", "2026-11-20T10:00:01+01:00", "warn", "No tender has a title.");
    store.finishRun("lg-2", "failed", "2026-11-20T10:00:05+01:00", "No tender has a title (0 of 3).");
    store.insertRun({ id: "lg-3", portalId: "lg", kind: "repair", startedAt: "2026-11-20T10:01:00+01:00" });
    store.finishRun("lg-3", "ok", "2026-11-20T10:02:00+01:00", "Title now read from td.subject.");

    const mine = (rows: { portal_id: string; id: string }[]) => rows.filter((r) => r.portal_id === "lg").map((r) => r.id);
    const notable = (await get("/internal/log")).json();
    assert.deepEqual(mine(notable), ["lg-3", "lg-2"]);
    assert.equal(notable.find((r: { id: string }) => r.id === "lg-2").events[0].message, "No tender has a title.");
    assert.equal(notable.find((r: { id: string }) => r.id === "lg-2").url, "https://lg.example/");
    assert.deepEqual(mine((await get("/internal/log?all=1")).json()), ["lg-3", "lg-2", "lg-1"]);
    assert.equal((await get("/internal/log?limit=junk")).statusCode, 200);
  });
});
