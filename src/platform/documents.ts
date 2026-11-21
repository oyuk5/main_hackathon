/**
 * Document pipeline. Owned by A.
 * Streams each file to disk, hashes it, unpacks ZIPs (each inner file becomes a document,
 * one nested ZIP level deep), skips anything over the size cap, and stores bytes by sha256
 * under DATA_DIR/files. Never holds a whole file in memory.
 *
 * Downloads run over HTTP, or in the browser when the portal needs clicks or JavaScript
 * (ref.via === "browser", with ref.clickPath). Both paths share the same hash, cap and ZIP logic.
 *
 * Traps handled: a web page instead of a file (login pages are named as such), a captcha that
 * still lets the file through (the download is always tried before declaring a block),
 * oversized files (content-length checked first, streaming aborted at the cap), nested ZIPs.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import type { Download, Page } from "playwright";
import { config } from "./config.js";
import type { TenderDocument } from "../shared/contract.js";
import type { DocumentFetcher, DocumentRef, PortalContext } from "../shared/modules.js";

const filesDir = path.join(config.dataDir, "files");
const tmpDir = path.join(config.dataDir, "tmp");
fs.mkdirSync(filesDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

/** How long the browser path waits for a page, a click target, or a download to start. */
const BROWSER_STEP_MS = Math.max(1000, Number(process.env.BROWSER_STEP_MS) || 20_000);
/** How much of an HTML answer we read to tell a login page from a captcha or a summary page. */
const HTML_SNIFF_BYTES = 256 * 1024;

export function filePath(sha256: string): string {
  return path.join(filesDir, sha256);
}

const capMb = () => Math.round(config.maxFileBytes / 1048576);

// ------------------------------------------------------------ who holds a stored file

/** The portal whose documents are being fetched, so commit() knows who holds each file it stores. */
const fetchingFor = new AsyncLocalStorage<string>();
/**
 * Portals that stored each file in this process. A file is content-addressed and can be shared, and a
 * portal stores a file before its tender row is saved: this covers that gap when another portal is
 * deleted. Kept until restart; after a restart, a job that still needs a file downloads it again.
 */
const holders = new Map<string, Set<string>>();

function noteHolder(sha256: string, portalId: string | undefined): void {
  if (!portalId) return;
  const set = holders.get(sha256) ?? new Set<string>();
  set.add(portalId);
  holders.set(sha256, set);
}

/**
 * After a portal is deleted: removes each of its files from disk unless another portal's tenders still
 * reference it (`isReferenced`) or another portal stored it in this process, so `/files/{sha256}` answers
 * 404 for what only that portal had. Synchronous, so no download can interleave between check and delete.
 */
export function removeOrphanFiles(portalId: string, sha256s: Iterable<string>, isReferenced: (sha256: string) => boolean): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const sha of new Set(sha256s)) {
    if (!/^[0-9a-f]{64}$/.test(sha)) continue;
    const set = holders.get(sha);
    set?.delete(portalId);
    if (set && set.size === 0) holders.delete(sha);
    if (isReferenced(sha) || (holders.get(sha)?.size ?? 0) > 0) {
      kept.push(sha);
      continue;
    }
    fs.rmSync(filePath(sha), { force: true });
    removed.push(sha);
  }
  return { removed, kept };
}

/** For tests: forget who stored which file. */
export function resetFileHoldersForTests(): void {
  holders.clear();
}

// ------------------------------------------------------------ naming

function fileNameFrom(res: Response, ref: DocumentRef): string {
  const cd = res.headers.get("content-disposition") ?? "";
  // RFC 5987: charset'language'value; the language tag may be empty or set.
  const star = /filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i.exec(cd);
  if (star?.[1]) {
    // Broken percent-encoding must not cost the file: fall back to the other names.
    try {
      return safeName(decodeURIComponent(star[1].trim().replace(/"/g, "")));
    } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (plain?.[1]) return safeName(plain[1].trim());
  if (ref.fileNameHint) return safeName(ref.fileNameHint);
  return nameFromUrl(res.url || ref.url);
}

function nameFromUrl(url: string): string {
  try {
    return safeName(decodeURIComponent(new URL(url).pathname.split("/").pop() || "document"));
  } catch {
    return "document";
  }
}

/** Keeps only the last path segment, so a name can never point outside storage. */
function safeName(name: string): string {
  return name.split(/[\\/]/).pop()?.trim() || "document";
}

// ------------------------------------------------------------ streaming to disk

type Temp = { tmp: string; sha256: string; size: number };

/**
 * Streams bytes to a temp file with a byte cap, hashing as it goes.
 * Returns null when the cap is crossed; the source is destroyed so the transfer stops.
 */
async function toTemp(source: AsyncIterable<Uint8Array>): Promise<Temp | null> {
  const tmp = path.join(tmpDir, crypto.randomUUID());
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(tmp);
  let size = 0;
  try {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > config.maxFileBytes) throw new OverCap();
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
    return { tmp, sha256: hash.digest("hex"), size };
  } catch (e) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    if (e instanceof OverCap) return null;
    throw e;
  }
}

class OverCap extends Error {}

/** Moves a temp file into content-addressed storage and returns its document entry. */
async function commit(t: Temp, fileName: string): Promise<TenderDocument> {
  const dest = filePath(t.sha256);
  // Before the file is in place: a portal deleted meanwhile sees this one holds it and keeps it.
  noteHolder(t.sha256, fetchingFor.getStore());
  if (fs.existsSync(dest)) await fsp.rm(t.tmp, { force: true });
  else await fsp.rename(t.tmp, dest);
  return { fileName, sizeBytes: t.size, sha256: t.sha256, path: `/files/${t.sha256}` };
}

function head(file: string, n: number): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

function isZip(file: string): boolean {
  const signature = head(file, 4).toString("hex");
  return signature === "504b0304" || signature === "504b0506";
}

function looksLikeHtml(bytes: Buffer): boolean {
  return /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|body|title|meta|script|form|div|main|h[1-6]|p)\b/i.test(bytes.toString("utf8").replace(/^\uFEFF/, ""));
}

async function payloadProblem(t: Temp, name: string, source: string, mediaType = ""): Promise<string | null> {
  const first = head(t.tmp, 2048);
  let problem: string | null = null;
  if (!t.size) problem = `Could not download ${source}: the file was empty.`;
  else if (looksLikeHtml(first)) problem = explainPage(head(t.tmp, HTML_SNIFF_BYTES).toString("utf8"), source);
  else if ((/\.pdf$/i.test(name) || mediaType === "application/pdf") &&
    !/^%PDF-\d\.\d(?:[\r\n\t ]|$)/m.test(first.subarray(0, 1024).toString("latin1"))) {
    problem = `Could not download ${name}: the response is not a PDF.`;
  } else if ((/\.zip$/i.test(name) || mediaType === "application/zip") && (!isZip(t.tmp) || t.size < 22)) {
    problem = `Could not download ${name}: the response is not a ZIP archive.`;
  }
  if (problem) await fsp.rm(t.tmp, { force: true });
  return problem;
}

const officeContainer = (name: string) => /\.(?:docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp)$/i.test(name);

// ------------------------------------------------------------ what a web page means

const LOGIN_WORDS =
  /\b(log ?in|sign ?in|anmelden|einloggen|inloggen|aanmelden|connexion|se connecter|iniciar sesi[oó]n|accedi|zaloguj|přihlásit|bejelentkezés|logga in|log ind|kirjaudu)\b/i;
const CAPTCHA_MARKS = /captcha|g-recaptcha|h-captcha|cf-turnstile|challenge-platform|cf-chl-|are you a robot|are you human/i;

/** Classifies an HTML answer that came instead of a file. */
function explainPage(html: string, url: string): string {
  if (/<input[^>]+type\s*=\s*["']?password/i.test(html) || (/<form/i.test(html) && LOGIN_WORDS.test(html))) {
    return `Documents need a login: ${url} shows a login page instead of the file.`;
  }
  if (CAPTCHA_MARKS.test(html)) return `Blocked by a captcha: ${url} shows a captcha instead of the file.`;
  return `Got a web page instead of a file at ${url}.`;
}

async function readTextCapped(res: Response, max: number): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>) {
    parts.push(chunk);
    size += chunk.length;
    if (size >= max) break; // leaving the loop destroys the stream and stops the transfer
  }
  return Buffer.concat(parts).toString("utf8");
}

// ------------------------------------------------------------ ZIP

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    // decodeStrings: false so one entry named "../x" does not make yauzl reject the whole archive;
    // we decode names ourselves and only ever keep the last path segment.
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false }, (err, zip) => (err || !zip ? reject(err ?? new Error("cannot open")) : resolve(zip))),
  );
}

function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
    };
    const onEntry = (e: yauzl.Entry) => (cleanup(), resolve(e));
    const onEnd = () => (cleanup(), resolve(null));
    const onError = (e: Error) => (cleanup(), reject(e));
    zip.on("entry", onEntry);
    zip.on("end", onEnd);
    zip.on("error", onError);
    zip.readEntry();
  });
}

/** Entry name from raw bytes: UTF-8 when the ZIP says so (bit 11), else CP437, which matches Latin-1 for ASCII. */
function entryName(entry: yauzl.Entry): string {
  const raw = entry.fileName as unknown as Buffer | string;
  if (typeof raw === "string") return raw;
  return raw.toString((entry.generalPurposeBitFlag & 0x800) !== 0 ? "utf8" : "latin1");
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (e, s) => (e || !s ? reject(e ?? new Error("unreadable")) : resolve(s))));
}

/**
 * Unpacks a ZIP into documents. Skips folders and entries over the cap (counted while streaming,
 * so a ZIP that lies about sizes still stops at the cap). A ZIP inside the ZIP is unpacked one
 * level deeper; anything deeper is kept as a file.
 */
async function unzip(file: string, zipName: string, depth: number, signal: AbortSignal): Promise<{ documents: TenderDocument[]; problems: string[] }> {
  const documents: TenderDocument[] = [];
  const problems: string[] = [];
  const zip = await openZip(file);
  try {
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      if (signal.aborted) break;
      const raw = entryName(entry);
      const name = safeName(raw);
      if (/[\\/]$/.test(raw) || !name) continue;
      if (entry.uncompressedSize > config.maxFileBytes) {
        problems.push(`Left out ${name} from ${zipName}: it is over ${capMb()} MB.`);
        continue;
      }
      let t: Temp | null;
      try {
        t = await toTemp(await entryStream(zip, entry));
      } catch {
        problems.push(`Left out ${name} from ${zipName}: it could not be unpacked.`);
        continue;
      }
      if (!t) {
        problems.push(`Left out ${name} from ${zipName}: it is over ${capMb()} MB.`);
        continue;
      }
      const problem = await payloadProblem(t, name, `${name} from ${zipName}`);
      if (problem) {
        problems.push(problem);
        continue;
      }
      if (depth === 0 && isZip(t.tmp) && !officeContainer(name)) {
        try {
          const inner = await unzip(t.tmp, name, depth + 1, signal);
          documents.push(...inner.documents);
          problems.push(...inner.problems);
        } catch {
          problems.push(`Left out ${name} from ${zipName}: the inner ZIP could not be opened.`);
        } finally {
          await fsp.rm(t.tmp, { force: true });
        }
        continue;
      }
      documents.push(await commit(t, name));
    }
  } finally {
    zip.close();
  }
  return { documents, problems };
}

/** Turns a downloaded temp file into documents: unpacks ZIPs, commits anything else. */
async function store(t: Temp, name: string, signal: AbortSignal, source: string, mediaType = ""): Promise<{ documents: TenderDocument[]; problems: string[] }> {
  const problem = await payloadProblem(t, name, source, mediaType);
  if (problem) return { documents: [], problems: [problem] };
  if (isZip(t.tmp) && !officeContainer(name)) {
    try {
      return await unzip(t.tmp, name, 0, signal);
    } catch {
      return { documents: [], problems: [`Could not download ${name}: the ZIP archive could not be opened.`] };
    } finally {
      await fsp.rm(t.tmp, { force: true });
    }
  }
  return { documents: [await commit(t, name)], problems: [] };
}

// ------------------------------------------------------------ HTTP path

async function viaHttp(ref: DocumentRef, ctx: PortalContext): Promise<{ documents: TenderDocument[]; problems: string[] }> {
  const body = ref.form ? new URLSearchParams(ref.form).toString() : undefined;
  const res = await ctx.http.fetch(ref.url, {
    method: ref.method ?? "GET",
    body,
    headers: body ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 401) return { documents: [], problems: [`Documents need a login: ${ref.url} answered HTTP 401.`] };
    return { documents: [], problems: [`Could not download ${ref.url}: the portal answered HTTP ${res.status}.`] };
  }
  const mediaType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return { documents: [], problems: [explainPage(await readTextCapped(res, HTML_SNIFF_BYTES), ref.url)] };
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  const name = fileNameFrom(res, ref);
  if (declared > config.maxFileBytes) {
    await res.body?.cancel().catch(() => {});
    return { documents: [], problems: [`Left out ${name}: it is over ${capMb()} MB.`] };
  }
  if (!res.body) return { documents: [], problems: [`Could not download ${ref.url}: the answer was empty.`] };
  const t = await toTemp(Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>);
  if (!t) return { documents: [], problems: [`Left out ${name}: it is over ${capMb()} MB.`] };
  return store(t, name, ctx.signal, ref.url, mediaType);
}

// ------------------------------------------------------------ browser path

/**
 * Opens ref.url, clicks each selector of ref.clickPath in order, and catches the download,
 * on the page itself or on a popup it opens. The download is always tried first; only when
 * no file arrives does the page get inspected for a login or a captcha.
 */
async function viaBrowser(ref: DocumentRef, ctx: PortalContext): Promise<{ documents: TenderDocument[]; problems: string[] }> {
  return ctx.browser.withPage(async (page) => {
    let download: Download | undefined;
    let overCap = false;
    let wake: (() => void) | undefined;
    const cancelOversized = () => {
      overCap = true;
      void download?.cancel().catch(() => {});
    };
    const catchDownloads = (p: Page) =>
      p.on("download", (d) => {
        download ??= d;
        if (overCap) void d.cancel().catch(() => {});
        wake?.();
      });
    // The Playwright Download stream is only available after Chromium finishes writing its copy.
    // Watch Chromium's live counters instead, leaving the stream limit as a final check.
    const watchSize = async (p: Page) => {
      const session = await p.context().newCDPSession(p);
      session.on("Page.downloadProgress", ({ receivedBytes, totalBytes }) => {
        if (!overCap && Math.max(receivedBytes, totalBytes) > config.maxFileBytes) cancelOversized();
      });
      await session.send("Page.enable");
    };
    catchDownloads(page);
    // Live size watching is a safety net; the streamed byte limit still applies if CDP is unavailable.
    await watchSize(page).catch(() => {});
    page.context().on("page", (popup) => {
      catchDownloads(popup);
      void watchSize(popup).catch(() => {});
    });

    /** Waits up to `ms` for a download to start. */
    const waitForDownload = (ms: number) =>
      download || ctx.signal.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            wake = () => (clearTimeout(timer), resolve());
            ctx.signal.addEventListener("abort", () => wake?.(), { once: true });
          });

    try {
      await page.goto(ref.url, { waitUntil: "domcontentloaded", timeout: BROWSER_STEP_MS });
    } catch (e) {
      // Navigating straight to a file throws "Download is starting"; the download event still fires.
      if (!/download is starting/i.test((e as Error).message)) {
        await waitForDownload(1000);
        if (!download) throw e;
      }
    }

    const steps = ref.clickPath ?? [];
    for (const [i, selector] of steps.entries()) {
      if (download || ctx.signal.aborted) break;
      const target = page.locator(selector).first();
      // Not there after a few seconds and the page is a login or captcha wall: say so now
      // instead of waiting out the full timeout. Slow JavaScript pages still get the full wait.
      const present = await target.waitFor({ state: "attached", timeout: 3000 }).then(() => true, () => false);
      if (!present) {
        const wall = await explainStuck(page, ref.url, "");
        if (/^(Documents need a login|Blocked by a captcha)/.test(wall)) return { documents: [], problems: [wall] };
      }
      try {
        await target.click({ timeout: BROWSER_STEP_MS });
      } catch {
        await waitForDownload(1000);
        if (download) break;
        return { documents: [], problems: [await explainStuck(page, ref.url, `step ${i + 1} of ${steps.length} (${selector}) could not be clicked`)] };
      }
      if (i < steps.length - 1) {
        await page.waitForLoadState("domcontentloaded", { timeout: BROWSER_STEP_MS }).catch(() => {});
      }
    }

    await waitForDownload(BROWSER_STEP_MS);
    if (ctx.signal.aborted) return { documents: [], problems: [] };
    if (!download) return { documents: [], problems: [await explainStuck(page, ref.url, "no file arrived")] };

    const d: Download = download;
    const name = safeName(d.suggestedFilename() || ref.fileNameHint || nameFromUrl(d.url()));
    const failure = await d.failure();
    if (overCap) return { documents: [], problems: [`Left out ${name}: it is over ${capMb()} MB.`] };
    if (failure) return { documents: [], problems: [`Could not download ${name} from ${ref.url}: ${failure}.`] };
    const t = await toTemp((await d.createReadStream()) as AsyncIterable<Buffer>);
    if (!t) {
      await d.delete().catch(() => {});
      return { documents: [], problems: [`Left out ${name}: it is over ${capMb()} MB.`] };
    }
    await d.delete().catch(() => {}); // Playwright's own copy; ours is in temp storage now
    return store(t, name, ctx.signal, ref.url);
  });
}

/** Names why a browser download did not happen: login and captcha first, otherwise the plain fact. */
async function explainStuck(page: Page, url: string, what: string): Promise<string> {
  const html = await page.content().catch(() => "");
  const verdict = explainPage(html.slice(0, HTML_SNIFF_BYTES), url);
  return verdict.startsWith("Got a web page") ? `Could not download from ${url}: ${what}.` : verdict;
}

// ------------------------------------------------------------ entry point

export const documentFetcher: DocumentFetcher = {
  async fetchAll(refs, ctx: PortalContext) {
    const documents: TenderDocument[] = [];
    const problems: string[] = [];
    for (const ref of refs) {
      if (ctx.signal.aborted) break;
      try {
        const got = await fetchingFor.run(ctx.portalId, () => (ref.via === "browser" ? viaBrowser(ref, ctx) : viaHttp(ref, ctx)));
        documents.push(...got.documents);
        problems.push(...got.problems);
      } catch (e) {
        if (ctx.signal.aborted) break;
        problems.push(`Could not download ${ref.url}: ${(e as Error).message.split("\n")[0]}.`);
      }
    }
    return { documents, problems };
  },
};
