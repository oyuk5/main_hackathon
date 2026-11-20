/** Test helpers for the platform tests (not a test file itself). */
import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";

/**
 * Minimal ZIP writer, enough for yauzl. Entries are stored, or deflated when named in `deflate`.
 * `declared` overrides an entry's uncompressed size header (to build a ZIP that lies).
 */
export function zip(files: Record<string, Buffer>, declared: Record<string, number> = {}, deflate: string[] = []): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const n = Buffer.from(name);
    const crc = zlib.crc32(raw);
    const method = deflate.includes(name) ? 8 : 0;
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const size = declared[name] ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
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

export type Route = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

/** A fake portal on its own port (so the per-host gate does not serialize tests). Records every path hit. */
export async function fakePortal(routes: Record<string, Route>) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = (req.url ?? "/").split("?")[0]!;
      hits.push(req.method === "GET" ? p : `${req.method} ${p}`);
      const route = routes[p];
      if (route) return route(req, res, body);
      if (p === "/robots.txt") return void res.writeHead(404).end();
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, hits, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

/** Sends a file with an attachment header. */
export const file =
  (data: Buffer | string, name: string, type = "application/pdf"): Route =>
  (_req, res) => {
    res.writeHead(200, { "content-type": type, "content-disposition": `attachment; filename="${name}"` });
    res.end(data);
  };

/**
 * Removes a test's temporary folder. On Windows an open SQLite file cannot be deleted while the
 * process still holds it (EPERM), so cleanup there is best effort; the OS temp folder clears it later.
 */
export function removeTemp(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY") throw e;
  }
}
