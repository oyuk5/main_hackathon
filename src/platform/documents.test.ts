/**
 * Document pipeline against a local fake portal: HTTP files, ZIPs (nested), oversized files,
 * login and captcha traps, multi-step browser downloads, and abort (DELETE) stopping traffic.
 * Each test gets its own server port, so the 1 request/second gate per host does not serialize them.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import type { DocumentRef, PortalContext } from "../shared/modules.js";

const CAP = 1024 * 1024; // 1 MB cap for the tests
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wt-docs-"));
process.env.MAX_FILE_BYTES = String(CAP);

const { documentFetcher } = await import("./documents.js");
const { politeBrowser, politeHttp, closeSharedBrowser } = await import("./polite.js");

// ------------------------------------------------------------ fixtures

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const PDF = Buffer.from("%PDF-1.4\nTender specification\n%%EOF\n");
const A_TXT = Buffer.from("annex A");
const B_TXT = Buffer.from("annex B, inside the inner zip");

/** Minimal ZIP writer (stored, no compression), enough for yauzl. */
function zip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const INNER = zip({ "b.txt": B_TXT });
const BUNDLE = zip({ "docs/a.txt": A_TXT, "docs/": Buffer.alloc(0), "inner.zip": INNER });

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const LOGIN = page(`<form action="/session"><input name="user"><input type="password" name="pw"><button>Log in</button></form>`);

type Stats = { streamedBytes: number; closedAt: number | null; hangReached: Promise<void> };
type Fake = { base: string; stats: Stats; close: () => Promise<void> };

/** A fake portal on its own port. */
async function fakePortal(): Promise<Fake> {
  let reached!: () => void;
  const stats: Stats = { streamedBytes: 0, closedAt: null, hangReached: new Promise<void>((r) => (reached = r)) };
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...extra });
      res.end(body);
    };
    switch (url) {
      case "/robots.txt":
        return send(404, "text/plain", "");
      case "/tender.pdf":
        return send(200, "application/pdf", PDF, { "content-disposition": 'attachment; filename="tender.pdf"' });
      case "/bundle.zip":
        return send(200, "application/zip", BUNDLE, { "content-disposition": 'attachment; filename="bundle.zip"' });
      case "/login":
        return send(200, "text/html; charset=utf-8", LOGIN);
      case "/captcha":
        return send(200, "text/html", page(`<div class="g-recaptcha" data-sitekey="x"></div>`));
      case "/disguised":
        return send(200, "application/octet-stream", LOGIN);
      case "/missing":
        return send(404, "text/plain", "gone");
      case "/huge-declared":
        res.writeHead(200, { "content-type": "application/zip", "content-length": String(2 * 1024 ** 3) });
        res.write(Buffer.alloc(1024));
        req.socket.on("close", () => (stats.closedAt = Date.now()));
        return;
      case "/huge-stream": {
        // No content-length: streams until the client hangs up.
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(64 * 1024, 1);
        const pump = () => {
          while (!res.destroyed && stats.streamedBytes < 50 * CAP) {
            stats.streamedBytes += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
        };
        res.on("close", () => (stats.closedAt = Date.now()));
        return pump();
      }
      case "/slow-stream": {
        // Trickles bytes so a test can abort mid-download.
        res.writeHead(200, { "content-type": "application/pdf" });
        const t = setInterval(() => res.write(Buffer.alloc(1024)), 50);
        res.on("close", () => (clearInterval(t), (stats.closedAt = Date.now())));
        return;
      }
      case "/portal":
        return send(200, "text/html", page(`<a id="next" href="/step2">Documents</a>`));
      case "/step2":
        return send(200, "text/html", page(`<button id="dl" onclick="location.href='/bundle.zip'">Download all</button>`));
      case "/captcha-but-open":
        return send(200, "text/html", page(`<div class="g-recaptcha" data-sitekey="x"></div><a id="dl" href="/tender.pdf">PDF</a>`));
      case "/hang":
        req.socket.on("close", () => (stats.closedAt = Date.now()));
        reached();
        return; // never answers
      default:
        return send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    stats,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

function context() {
  const controller = new AbortController();
  const ctx = {
    http: politeHttp(controller.signal),
    browser: politeBrowser(controller.signal),
    signal: controller.signal,
    log: () => {},
  } as unknown as PortalContext;
  return { ctx, controller };
}

async function fetchFrom(refs: (base: string) => DocumentRef[]) {
  const fake = await fakePortal();
  try {
    const { ctx } = context();
    return { ...(await documentFetcher.fetchAll(refs(fake.base), ctx)), stats: fake.stats };
  } finally {
    await fake.close();
  }
}

// ------------------------------------------------------------ tests

describe("document pipeline", { concurrency: true }, () => {
  before(() => {});
  after(async () => {
    await closeSharedBrowser();
    fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
  });

  it("downloads a file over HTTP with the right name and sha256", async () => {
    const got = await fetchFrom((b) => [{ url: `${b}/tender.pdf`, via: "http" }]);
    assert.deepEqual(got.problems, []);
    assert.equal(got.documents.length, 1);
    assert.equal(got.documents[0]!.fileName, "tender.pdf");
    assert.equal(got.documents[0]!.sha256, sha(PDF));
    assert.equal(got.documents[0]!.sizeBytes, PDF.length);
  });

  it("unpacks a ZIP and a ZIP inside it, one level deep", async () => {
    const got = await fetchFrom((b) => [{ url: `${b}/bundle.zip`, via: "http" }]);
    assert.deepEqual(got.problems, []);
    const byName = Object.fromEntries(got.documents.map((d) => [d.fileName, d.sha256]));
    assert.deepEqual(byName, { "a.txt": sha(A_TXT), "b.txt": sha(B_TXT) });
  });

  it("names a login page as such, over HTTP and when mislabelled as a file", async () => {
    const got = await fetchFrom((b) => [
      { url: `${b}/login`, via: "http" },
      { url: `${b}/disguised`, via: "http" },
    ]);
    assert.equal(got.documents.length, 0);
    assert.equal(got.problems.length, 2);
    for (const p of got.problems) assert.match(p, /^Documents need a login/);
  });

  it("reports a captcha page and a missing file in plain sentences", async () => {
    const got = await fetchFrom((b) => [
      { url: `${b}/captcha`, via: "http" },
      { url: `${b}/missing`, via: "http" },
    ]);
    assert.match(got.problems[0]!, /^Blocked by a captcha/);
    assert.match(got.problems[1]!, /HTTP 404\.$/);
  });

  it("skips a file whose declared size is over the cap without reading it", async () => {
    const got = await fetchFrom((b) => [{ url: `${b}/huge-declared`, via: "http" }]);
    assert.equal(got.documents.length, 0);
    assert.match(got.problems[0]!, /over 1 MB/);
  });

  it("stops streaming at the cap when no size is declared", async () => {
    const got = await fetchFrom((b) => [{ url: `${b}/huge-stream`, via: "http" }]);
    assert.equal(got.documents.length, 0);
    assert.match(got.problems[0]!, /over 1 MB/);
    assert.ok(got.stats.streamedBytes < 20 * CAP, `server kept sending: ${got.stats.streamedBytes} bytes`);
  });

  it("follows a multi-step browser download and unpacks the ZIP", async () => {
    const got = await fetchFrom((b) => [{ url: `${b}/portal`, via: "browser", clickPath: ["#next", "#dl"] }]);
    assert.deepEqual(got.problems, []);
    const byName = Object.fromEntries(got.documents.map((d) => [d.fileName, d.sha256]));
    assert.deepEqual(byName, { "a.txt": sha(A_TXT), "b.txt": sha(B_TXT) });
  });

  it("still downloads when the page shows a captcha", async () => {
    const got = await fetchFrom((b) => [{ url: `${b}/captcha-but-open`, via: "browser", clickPath: ["#dl"] }]);
    assert.deepEqual(got.problems, []);
    assert.equal(got.documents[0]?.sha256, sha(PDF));
  });

  it("names a login wall in the browser when no file arrives", async () => {
    const got = await fetchFrom((b) => [{ url: `${b}/login`, via: "browser", clickPath: ["#dl"] }]);
    assert.equal(got.documents.length, 0);
    assert.match(got.problems[0]!, /^Documents need a login/);
  });

  it("abort closes a hanging browser page at once and skips the remaining documents", async () => {
    const fake = await fakePortal();
    try {
      const { ctx, controller } = context();
      const run = documentFetcher.fetchAll(
        [
          { url: `${fake.base}/hang`, via: "browser" },
          { url: `${fake.base}/tender.pdf`, via: "http" },
        ],
        ctx,
      );
      await fake.stats.hangReached; // the browser is now waiting on the portal
      const abortedAt = Date.now();
      controller.abort();
      const got = await run;
      const took = Date.now() - abortedAt;
      assert.ok(took < 5_000, `fetchAll returned ${took} ms after abort`);
      assert.equal(got.documents.length, 0, "the second document must not be fetched");
      assert.deepEqual(got.problems, [], "an aborted job reports nothing");
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(fake.stats.closedAt !== null && fake.stats.closedAt - abortedAt < 2_000, "browser connection to the portal stayed open");
    } finally {
      await fake.close();
    }
  });

  it("abort mid-download stops the HTTP transfer", async () => {
    const fake = await fakePortal();
    try {
      const { ctx, controller } = context();
      const run = documentFetcher.fetchAll([{ url: `${fake.base}/slow-stream`, via: "http" }], ctx);
      setTimeout(() => controller.abort(), 2500); // after robots.txt + the gate, while bytes trickle
      const got = await run;
      const abortedAt = Date.now();
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(got.documents.length, 0);
      assert.ok(fake.stats.closedAt !== null && fake.stats.closedAt - abortedAt < 1000, "transfer kept running after abort");
    } finally {
      await fake.close();
    }
  });
});
