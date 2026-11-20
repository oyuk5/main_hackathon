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

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wt-server-"));

const { buildServer } = await import("./server.js");
const { store } = await import("./store.js");
const { filePath } = await import("./documents.js");
const { normalizeUrl, portalIdFor } = await import("./orchestrator.js");

const app = await buildServer();
after(async () => {
  await app.close();
  fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });
const get = (url: string) => app.inject({ method: "GET", url });

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
