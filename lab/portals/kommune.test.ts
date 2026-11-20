/**
 * Checks the kommune demo portal: truth shape, reachability by links, document bytes, ZIP members
 * with folders, and every variant.
 * Run: node --import tsx --test lab/portals/kommune.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import yauzl from "yauzl";
import { Tender } from "../../src/shared/contract.js";
import { sha256, type Truth } from "./common.js";
import { kommune } from "./kommune.js";
import { createLab } from "../serve.js";

const lab = createLab();
let base = "";

before(async () => {
  await new Promise<void>((r) => lab.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(lab.server.address() as AddressInfo).port}`;
});
after(() => lab.server.close());

const get = (p: string) => fetch(base + p);
const text = async (p: string) => (await get(p)).text();
const truth = async () => (await (await get("/_truth/kommune.json")).json()) as Truth & { variant: string };
const setVariant = async (v: string) => assert.equal((await fetch(`${base}/_lab/variant?portal=kommune&v=${v}`, { method: "POST" })).status, 200);
const hrefs = (html: string, re: RegExp) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&")).filter((h) => re.test(h));
const bytes = async (p: string) => Buffer.from(await (await get(p)).arrayBuffer());

interface Entry {
  name: string;
  sha: string;
  size: number;
}

function unzip(buf: Buffer): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: Entry[] = [];
      zip.on("entry", (e: yauzl.Entry) =>
        zip.openReadStream(e, (er, s) => {
          if (er || !s) return reject(er);
          const parts: Buffer[] = [];
          s.on("data", (c: Buffer) => parts.push(c));
          s.on("end", () => {
            const b = Buffer.concat(parts);
            out.push({ name: e.fileName, sha: sha256(b), size: b.length });
            zip.readEntry();
          });
        }),
      );
      zip.on("end", () => resolve(out));
      zip.readEntry();
    });
  });
}

/** Follows links like a reader: start page → list → every list page (numbered or "Vis flere") → detail URLs. */
async function crawlDetails(): Promise<string[]> {
  const start = await text("/kommune/");
  const listLink = hrefs(start, /^\/kommune\/udbud$/)[0];
  assert.ok(listLink, "start page links the list");
  const seen = new Set<string>();
  const queue = [listLink];
  const details = new Set<string>();
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p)) continue;
    seen.add(p);
    const html = await text(p);
    for (const d of hrefs(html, /^\/kommune\/udbud\/\d+$/)) details.add(d);
    for (const n of hrefs(html, /^\/kommune\/udbud\?(side|fra)=\d+$/)) queue.push(n);
  }
  return [...details];
}

/** Document links for a tender, following the "Dokumenter" page when the variant moves them. */
async function documentLinks(detailPath: string): Promise<string[]> {
  const html = await text(detailPath);
  const direct = hrefs(html, /^\/kommune\/filer\//);
  if (direct.length) return direct;
  const docPage = hrefs(html, /\/dokumenter$/)[0];
  assert.ok(docPage, `${detailPath} links its documents somehow`);
  return hrefs(await text(docPage), /^\/kommune\/filer\//);
}

/** Downloads every linked document and unpacks ZIPs: returns what Watchtower should end up with. */
async function collect(detailPath: string): Promise<{ docs: Entry[]; zipEntries: Entry[] }> {
  const docs: Entry[] = [];
  const zipEntries: Entry[] = [];
  for (const l of await documentLinks(detailPath)) {
    const buf = await bytes(l);
    if (l.endsWith(".zip")) {
      const e = await unzip(buf);
      zipEntries.push(...e);
      docs.push(...e);
    } else docs.push({ name: decodeURIComponent(l.split("/").pop()!), sha: sha256(buf), size: buf.length });
  }
  return { docs, zipEntries };
}

const key = (e: { sha256?: string; sha?: string; sizeBytes?: number; size?: number }) => `${e.sha256 ?? e.sha}:${e.sizeBytes ?? e.size}`;

test("truth has the contract's shape, a cancelled tender and CPV codes with check digits on the portal", async () => {
  await setVariant("v1");
  const t = await truth();
  assert.equal(t.country, "DK");
  assert.equal(t.timeZone, "Europe/Copenhagen");
  assert.ok(t.tenders.length >= 10 && t.tenders.length <= 15);
  assert.equal(new Set(t.tenders.map((x) => x.id)).size, t.tenders.length);
  for (const x of t.tenders) {
    const r = Tender.safeParse({ ...x, lastChangedAt: "2026-11-20T10:00:00+01:00", documents: x.documents.map((d) => ({ ...d, path: `/files/${d.sha256}` })) });
    assert.ok(r.success, `${x.id}: ${r.success ? "" : r.error.message}`);
    assert.ok(x.submissionDeadline > `${x.publicationDate}T`);
    assert.match(x.submissionDeadline, /T(12|10):00:00\+0[12]:00$/);
    assert.ok(x.documents.length >= 4, `${x.id} has the PDF plus ZIP members`);
  }
  assert.equal(t.tenders.filter((x) => x.status === "withdrawn").length, 1);
  for (const p of kommune.tenders) for (const c of p.cpv) assert.match(c, /^\d{8}-\d$/);
});

test("start page → list pages → every detail page, values shown, cancelled one marked", async () => {
  await setVariant("v1");
  const t = await truth();
  const found = await crawlDetails();
  assert.deepEqual(found.sort(), t.tenders.map((x) => new URL(x.url).pathname).sort());
  const listHtml = await text("/kommune/udbud");
  assert.ok(listHtml.includes('class="udbudsliste"') && listHtml.includes("?side=2") && listHtml.includes("?side=3"));
  for (const x of t.tenders) {
    const lt = kommune.tenders.find((k) => k.id === x.id)!;
    const d = await text(new URL(x.url).pathname);
    assert.ok(d.includes(x.referenceNumber) && d.includes(x.buyerName) && d.includes(lt.cpv[0]!));
    const [y, m, day] = lt.deadlineDate.split("-");
    assert.ok(d.includes(`${day}.${m}.${y} kl. ${lt.deadlineTime}`), `${x.id} deadline in Danish format`);
    assert.equal(d.includes("Annulleret"), x.status === "withdrawn");
  }
});

test("every document downloads with the truth's hash and size; ZIP members keep their folders", async () => {
  await setVariant("v1");
  const t = await truth();
  let nested = 0;
  for (const x of t.tenders) {
    const { docs, zipEntries } = await collect(new URL(x.url).pathname);
    assert.deepEqual(docs.map(key).sort(), x.documents.map(key).sort(), `documents of ${x.id}`);
    assert.ok(zipEntries.length >= 3);
    for (const e of zipEntries) {
      assert.match(e.name, /^0\d [^/]+\//, `${e.name} sits in a folder`);
      const d = x.documents.find((doc) => doc.sha256 === e.sha);
      assert.ok(d, `${e.name} is in the truth`);
      assert.equal(d.fileName, e.name.split("/").pop());
      assert.equal(d.sizeBytes, e.size);
      if (e.name.split("/").length > 2) nested++;
    }
    const names = zipEntries.map((e) => e.name);
    for (const n of ["01 Udbudsbetingelser/Udbudsbetingelser.pdf", "02 Bilag/Bilag 1 Kravspecifikation.pdf", "02 Bilag/Tilbudsliste.xlsx"]) assert.ok(names.includes(n), `${x.id} has ${n}`);
    const base = names.map((n) => n.split("/").pop());
    assert.equal(new Set(base).size, base.length, `${x.id} member basenames are unique`);
    assert.equal(new Set(x.documents.map((d) => d.sha256)).size, x.documents.length, `${x.id} documents are distinct`);
  }
  assert.ok(nested > 0, "some ZIPs have nested folders");
  // No two tenders share a document.
  const all = t.tenders.flatMap((x) => x.documents.map((d) => d.sha256));
  assert.equal(new Set(all).size, all.length);
});

test("every variant keeps tenders reachable from the start page, and the truth follows it", async () => {
  for (const v of ["v1", ...Object.keys(kommune.variants)]) {
    await setVariant(v);
    const t = await truth();
    assert.equal(t.variant, v);
    if (v === "empty-day") {
      assert.equal(t.tenders.length, 0);
      assert.ok((await text("/kommune/udbud")).includes("Der er ingen aktuelle udbud."));
      assert.deepEqual(await crawlDetails(), []);
      continue;
    }
    const found = await crawlDetails();
    assert.deepEqual(found.sort(), t.tenders.map((x) => new URL(x.url).pathname).sort(), `${v}: every tender reachable`);
    const x = t.tenders[0]!;
    const { docs } = await collect(new URL(x.url).pathname);
    assert.deepEqual(docs.map(key).sort(), x.documents.map(key).sort(), `${v}: documents reachable`);
  }
  await setVariant("v1");
});

test("variants change what the portal says", async () => {
  const id = kommune.tenders[0]!.id;
  await setVariant("renamed-classes");
  let h = await text("/kommune/udbud");
  assert.ok(h.includes('class="tender-oversigt"') && !h.includes('class="udbudsliste"') && h.includes('class="paginering"'));
  h = await text(`/kommune/udbud/${id}`);
  assert.ok(h.includes('class="stamdata"') && h.includes('class="download"') && !h.includes('class="fil"'));

  await setVariant("new-pagination");
  h = await text("/kommune/udbud?side=2");
  assert.ok(h.includes("?fra=5") && h.includes("Vis flere") && !h.includes("?side=") && h.includes("Viser 1-5"));
  assert.ok((await text("/kommune/udbud?fra=10")).includes("Viser 11-12"));

  await setVariant("moved-documents");
  h = await text(`/kommune/udbud/${id}`);
  assert.ok(!h.includes("/kommune/filer/") && h.includes(`/kommune/udbud/${id}/dokumenter`));
  assert.ok((await text(`/kommune/udbud/${id}/dokumenter`)).includes("/kommune/filer/"));
  await setVariant("v1");
  assert.equal((await get(`/kommune/udbud/${id}/dokumenter`)).status, 404);

  await setVariant("date-format");
  h = await text("/kommune/udbud");
  assert.match(h, /\d{1,2}\. (januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december) 20\d\d kl\. \d\d\.\d\d/);
  assert.doesNotMatch(h, /\d\d\.\d\d\.20\d\d/);

  await setVariant("cookie-banner");
  h = await text("/kommune/udbud");
  assert.ok(h.includes("cookie-consent") && h.includes('class="udbudsliste"'));
  assert.equal((await truth()).tenders.length, kommune.tenders.length);

  await setVariant("v1");
});
