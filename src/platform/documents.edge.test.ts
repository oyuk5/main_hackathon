/**
 * Edge cases of the document pipeline: names, hostile ZIPs, odd HTTP answers, robots, popups.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DocumentRef, PortalContext } from "../shared/modules.js";
import { fakePortal, file, zip, type Route } from "./testkit.js";

const CAP = 1024 * 1024;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wt-docs-edge-"));
process.env.MAX_FILE_BYTES = String(CAP);
process.env.BROWSER_STEP_MS = "3000"; // waits for a click target or a download; 20 s in production

const { documentFetcher, filePath } = await import("./documents.js");
const { politeBrowser, politeHttp, closeSharedBrowser } = await import("./polite.js");

const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

function ctx(): PortalContext {
  const c = new AbortController();
  return { http: politeHttp(c.signal), browser: politeBrowser(c.signal), signal: c.signal, log: () => {} } as unknown as PortalContext;
}

async function run(routes: Record<string, Route>, refs: (base: string) => DocumentRef[]) {
  const p = await fakePortal(routes);
  try {
    return { ...(await documentFetcher.fetchAll(refs(p.base), ctx())), hits: p.hits };
  } finally {
    await p.close();
  }
}

describe("document pipeline edge cases", { concurrency: true }, () => {
  after(async () => {
    await closeSharedBrowser();
    fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
  });

  it("decodes an RFC 5987 UTF-8 file name", async () => {
    const got = await run(
      {
        "/doc": (_q, res) => {
          res.writeHead(200, { "content-type": "application/pdf", "content-disposition": "attachment; filename*=UTF-8''Leistungsverzeichnis_Los_%C3%A4.pdf" });
          res.end("%PDF umlaut");
        },
      },
      (b) => [{ url: `${b}/doc`, via: "http" }],
    );
    assert.equal(got.documents[0]?.fileName, "Leistungsverzeichnis_Los_ä.pdf");
  });

  it("keeps only the last path segment of a hostile file name", async () => {
    const got = await run({ "/doc": file("%PDF x", "../../etc/passwd") }, (b) => [{ url: `${b}/doc`, via: "http" }]);
    assert.equal(got.documents[0]?.fileName, "passwd");
    assert.ok(fs.existsSync(filePath(got.documents[0]!.sha256)), "stored under its sha256, nowhere else");
  });

  it("flattens ZIP entries that try to escape the folder", async () => {
    const z = zip({ "../../evil.txt": Buffer.from("evil"), "a/b/c/deep.txt": Buffer.from("deep") });
    const got = await run({ "/z.zip": file(z, "z.zip", "application/zip") }, (b) => [{ url: `${b}/z.zip`, via: "http" }]);
    assert.deepEqual(got.documents.map((d) => d.fileName).sort(), ["deep.txt", "evil.txt"]);
    assert.ok(!fs.existsSync(path.join(process.env.DATA_DIR!, "..", "evil.txt")));
  });

  it("keeps a corrupt file named .zip as a plain file", async () => {
    const got = await run({ "/bad.zip": file("this is not a zip", "bad.zip", "application/zip") }, (b) => [{ url: `${b}/bad.zip`, via: "http" }]);
    assert.deepEqual(got.problems, []);
    assert.equal(got.documents[0]?.fileName, "bad.zip");
    assert.equal(got.documents[0]?.sha256, sha("this is not a zip"));
  });

  it("unpacks only one nested ZIP level; deeper ZIPs stay files", async () => {
    const deepest = zip({ "x.txt": Buffer.from("x") });
    const middle = zip({ "inner2.zip": deepest, "m.txt": Buffer.from("m") });
    const outer = zip({ "inner1.zip": middle, "o.txt": Buffer.from("o") });
    const got = await run({ "/o.zip": file(outer, "o.zip", "application/zip") }, (b) => [{ url: `${b}/o.zip`, via: "http" }]);
    assert.deepEqual(got.documents.map((d) => d.fileName).sort(), ["inner2.zip", "m.txt", "o.txt"]);
    assert.equal(got.documents.find((d) => d.fileName === "inner2.zip")?.sha256, sha(deepest));
  });

  it("leaves out a compressed ZIP entry that unpacks past the cap (zip bomb)", async () => {
    const bomb = Buffer.alloc(2 * CAP); // 2 MB of zeros compress to about 2 KB
    const z = zip({ "bomb.bin": bomb, "ok.txt": Buffer.from("ok") }, {}, ["bomb.bin"]);
    assert.ok(z.length < 50_000, "the archive itself is small");
    const got = await run({ "/z.zip": file(z, "z.zip", "application/zip") }, (b) => [{ url: `${b}/z.zip`, via: "http" }]);
    assert.deepEqual(got.documents.map((d) => d.fileName), ["ok.txt"]);
    assert.match(got.problems[0]!, /Left out bomb\.bin from z\.zip: it is over 1 MB\./);
  });

  it("stops at the cap when a ZIP entry lies about its size", async () => {
    const bomb = Buffer.alloc(2 * CAP);
    const z = zip({ "liar.bin": bomb, "ok.txt": Buffer.from("ok") }, { "liar.bin": 100 }, ["liar.bin"]);
    const got = await run({ "/z.zip": file(z, "z.zip", "application/zip") }, (b) => [{ url: `${b}/z.zip`, via: "http" }]);
    assert.deepEqual(got.documents.map((d) => d.fileName), ["ok.txt"]);
    assert.match(got.problems[0]!, /Left out liar\.bin from z\.zip/);
  });

  it("reads UTF-8 entry names and skips folders", async () => {
    const z = zip({ "Unterlagen/": Buffer.alloc(0), "Unterlagen/Preisblatt_ü.xlsx": Buffer.from("xlsx") });
    // Mark entries as UTF-8 (general purpose bit 11) in both headers.
    let at = 0;
    while ((at = z.indexOf(Buffer.from([0x50, 0x4b]), at)) >= 0) {
      const sig = z.readUInt32LE(at);
      if (sig === 0x04034b50) z.writeUInt16LE(0x800, at + 6);
      if (sig === 0x02014b50) z.writeUInt16LE(0x800, at + 8);
      at += 2;
    }
    const got = await run({ "/z.zip": file(z, "z.zip", "application/zip") }, (b) => [{ url: `${b}/z.zip`, via: "http" }]);
    assert.deepEqual(got.documents.map((d) => d.fileName), ["Preisblatt_ü.xlsx"]);
  });

  it("stores the same bytes once, listed under both names", async () => {
    const got = await run(
      { "/a": file("same bytes", "a.pdf"), "/b": file("same bytes", "b.pdf") },
      (b) => [
        { url: `${b}/a`, via: "http" },
        { url: `${b}/b`, via: "http" },
      ],
    );
    assert.deepEqual(got.documents.map((d) => d.fileName), ["a.pdf", "b.pdf"]);
    assert.equal(got.documents[0]!.sha256, got.documents[1]!.sha256);
  });

  it("reports an empty file and a server error as plain problems", async () => {
    const got = await run(
      { "/empty": file("", "empty.pdf"), "/boom": (_q, res) => res.writeHead(500).end("oops") },
      (b) => [
        { url: `${b}/empty`, via: "http" },
        { url: `${b}/boom`, via: "http" },
      ],
    );
    assert.equal(got.documents.length, 0);
    assert.match(got.problems[0]!, /the file was empty\.$/);
    assert.match(got.problems[1]!, /the portal answered HTTP 500\.$/);
  });

  it("sends a POST form for a download that needs one", async () => {
    let received = "";
    const got = await run(
      {
        "/download": (req, res, body) => {
          received = `${req.method} ${req.headers["content-type"]} ${body}`;
          file("%PDF form", "form.pdf")(req, res, body);
        },
      },
      (b) => [{ url: `${b}/download`, via: "http", method: "POST", form: { id: "42", lot: "a b" } }],
    );
    assert.equal(received, "POST application/x-www-form-urlencoded id=42&lot=a+b");
    assert.equal(got.documents[0]?.fileName, "form.pdf");
  });

  it("follows a redirect to the file and names it from the final address", async () => {
    const got = await run(
      {
        "/go": (_q, res) => res.writeHead(302, { location: "/files/spec%20v2.pdf" }).end(),
        "/files/spec v2.pdf": (_q, res) => res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF r"),
        "/files/spec%20v2.pdf": (_q, res) => res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF r"),
      },
      (b) => [{ url: `${b}/go`, via: "http" }],
    );
    assert.deepEqual(got.problems, []);
    assert.equal(got.documents[0]?.fileName, "spec v2.pdf");
  });

  it("does not download a file robots.txt disallows", async () => {
    const got = await run(
      { "/robots.txt": (_q, res) => res.end("User-agent: *\nDisallow: /private/\n"), "/private/x.pdf": file("%PDF", "x.pdf") },
      (b) => [{ url: `${b}/private/x.pdf`, via: "http" }],
    );
    assert.equal(got.documents.length, 0);
    assert.match(got.problems[0]!, /robots\.txt disallows \/private\/x\.pdf/);
    assert.ok(!got.hits.includes("/private/x.pdf"), "the file was requested anyway");
  });

  it("catches a browser download that opens in a popup", async () => {
    const got = await run(
      {
        "/page": (_q, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<a id="dl" href="/f.pdf" target="_blank">PDF</a>`),
        "/f.pdf": file("%PDF popup", "popup.pdf"),
      },
      (b) => [{ url: `${b}/page`, via: "browser", clickPath: ["#dl"] }],
    );
    assert.deepEqual(got.problems, []);
    assert.equal(got.documents[0]?.sha256, sha("%PDF popup"));
  });

  it("reports a click target that never appears on an ordinary page", async () => {
    const got = await run(
      { "/page": (_q, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<p>No downloads here</p>`) },
      (b) => [{ url: `${b}/page`, via: "browser", clickPath: ["#missing"] }],
    );
    assert.equal(got.documents.length, 0);
    assert.match(got.problems[0]!, /step 1 of 1 \(#missing\) could not be clicked/);
  });
});
