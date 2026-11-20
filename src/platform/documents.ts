/**
 * Document pipeline. Owned by A.
 * Streams each file to disk, hashes it, unpacks ZIPs (each inner file becomes a document),
 * skips anything over the size cap, and stores bytes by sha256 under DATA_DIR/files.
 *
 * TODO(A): browser downloads (ref.via === "browser", clickPath), nested ZIPs, retries.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import { config } from "./config.js";
import type { TenderDocument } from "../shared/contract.js";
import type { DocumentFetcher, DocumentRef, PortalContext } from "../shared/modules.js";

const filesDir = path.join(config.dataDir, "files");
const tmpDir = path.join(config.dataDir, "tmp");
fs.mkdirSync(filesDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

export function filePath(sha256: string): string {
  return path.join(filesDir, sha256);
}

function fileNameFrom(res: Response, ref: DocumentRef): string {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (star?.[1]) return decodeURIComponent(star[1].trim().replace(/"/g, ""));
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (plain?.[1]) return plain[1].trim();
  if (ref.fileNameHint) return ref.fileNameHint;
  const last = decodeURIComponent(new URL(res.url || ref.url).pathname.split("/").pop() || "document");
  return last || "document";
}

/** Moves a temp file into content-addressed storage and returns its document entry. */
async function commit(tmp: string, fileName: string, sha256: string, sizeBytes: number): Promise<TenderDocument> {
  const dest = filePath(sha256);
  if (fs.existsSync(dest)) await fsp.rm(tmp, { force: true });
  else await fsp.rename(tmp, dest);
  return { fileName, sizeBytes, sha256, path: `/files/${sha256}` };
}

/** Streams a response body to a temp file with a byte cap. Returns null if over the cap. */
async function download(res: Response): Promise<{ tmp: string; sha256: string; size: number } | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > config.maxFileBytes) return null;
  const tmp = path.join(tmpDir, crypto.randomUUID());
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(tmp);
  let size = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body as never)) {
      size += (chunk as Buffer).length;
      if (size > config.maxFileBytes) throw new Error("over cap");
      hash.update(chunk as Buffer);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    return { tmp, sha256: hash.digest("hex"), size };
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    if ((e as Error).message === "over cap") return null;
    throw e;
  }
}

function isZip(tmp: string): boolean {
  const fd = fs.openSync(tmp, "r");
  const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  return buf.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

/** Unpacks a ZIP into documents. Skips folders and entries over the cap. */
function unzip(zipPath: string): Promise<{ documents: TenderDocument[]; skipped: string[] }> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip open failed"));
      const documents: TenderDocument[] = [];
      const skipped: string[] = [];
      zip.on("entry", (entry: yauzl.Entry) => {
        const name = entry.fileName.split("/").pop() ?? entry.fileName;
        if (/\/$/.test(entry.fileName) || !name) return zip.readEntry();
        if (entry.uncompressedSize > config.maxFileBytes) {
          skipped.push(`${name} (over size cap)`);
          return zip.readEntry();
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) {
            skipped.push(`${name} (unreadable)`);
            return zip.readEntry();
          }
          const tmp = path.join(tmpDir, crypto.randomUUID());
          const hash = crypto.createHash("sha256");
          let size = 0;
          const out = fs.createWriteStream(tmp);
          stream.on("data", (c: Buffer) => {
            size += c.length;
            hash.update(c);
          });
          stream.pipe(out);
          out.on("finish", () => {
            commit(tmp, name, hash.digest("hex"), size)
              .then((d) => documents.push(d))
              .finally(() => zip.readEntry());
          });
        });
      });
      zip.on("end", () => resolve({ documents, skipped }));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

export const documentFetcher: DocumentFetcher = {
  async fetchAll(refs, ctx: PortalContext) {
    const documents: TenderDocument[] = [];
    const problems: string[] = [];
    for (const ref of refs) {
      if (ctx.signal.aborted) break;
      try {
        if (ref.via === "browser") {
          problems.push(`Browser download not implemented yet: ${ref.url}`); // TODO(A)
          continue;
        }
        const body = ref.form ? new URLSearchParams(ref.form).toString() : undefined;
        const res = await ctx.http.fetch(ref.url, {
          method: ref.method ?? "GET",
          body,
          headers: body ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
        });
        if (!res.ok) {
          problems.push(`HTTP ${res.status} for ${ref.url}`);
          continue;
        }
        const type = res.headers.get("content-type") ?? "";
        if (type.includes("text/html")) {
          problems.push(`Got a web page, not a file: ${ref.url}`); // likely a login wall or a summary page
          continue;
        }
        const name = fileNameFrom(res, ref);
        const got = await download(res);
        if (!got) {
          problems.push(`Left out ${name}: over ${Math.round(config.maxFileBytes / 1048576)} MB`);
          continue;
        }
        if (isZip(got.tmp) || /\.zip$/i.test(name)) {
          const z = await unzip(got.tmp);
          documents.push(...z.documents);
          problems.push(...z.skipped.map((s) => `Left out ${s} from ${name}`));
          await fsp.rm(got.tmp, { force: true });
        } else {
          documents.push(await commit(got.tmp, name, got.sha256, got.size));
        }
      } catch (e) {
        problems.push(`${(e as Error).message} for ${ref.url}`);
      }
    }
    return { documents, problems };
  },
};
