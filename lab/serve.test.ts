/**
 * Checks the lab itself: every truth matches what the demo portals actually serve.
 * Run: node --import tsx --test lab/serve.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import yauzl from "yauzl";
import { Tender } from "../src/shared/contract.js";
import { sha256, type Truth } from "./portals/common.js";
import { createLab, portals } from "./serve.js";

const lab = createLab();
let base = "";

before(async () => {
  await new Promise<void>((r) => lab.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(lab.server.address() as AddressInfo).port}`;
});
after(() => lab.server.close());

const get = (p: string) => fetch(base + p);
const truthOf = async (slug: string): Promise<Truth> => (await get(`/_truth/${slug}.json`)).json() as Promise<Truth>;

function unzipNames(buf: Buffer): Promise<Array<{ name: string; sha: string }>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: Array<{ name: string; sha: string }> = [];
      zip.on("entry", (e: yauzl.Entry) =>
        zip.openReadStream(e, (er, s) => {
          if (er || !s) return reject(er);
          const parts: Buffer[] = [];
          s.on("data", (c: Buffer) => parts.push(c));
          s.on("end", () => (out.push({ name: e.fileName, sha: sha256(Buffer.concat(parts)) }), zip.readEntry()));
        }),
      );
      zip.on("end", () => resolve(out));
      zip.readEntry();
    });
  });
}

test("robots.txt keeps crawlers away from truth and lab control", async () => {
  const txt = await (await get("/robots.txt")).text();
  assert.match(txt, /Disallow: \/_truth\//);
  assert.match(txt, /Disallow: \/_lab\//);
});

test("every truth tender has the contract's shape", async () => {
  for (const p of portals) {
    const t = await truthOf(p.slug);
    assert.ok(t.tenders.length >= 10, `${p.slug} has at least 10 tenders`);
    assert.equal(new Set(t.tenders.map((x) => x.id)).size, t.tenders.length, `${p.slug} ids are unique`);
    for (const x of t.tenders) {
      const withPaths = { ...x, lastChangedAt: "2026-11-20T10:00:00+01:00", documents: x.documents.map((d) => ({ ...d, path: `/files/${d.sha256}` })) };
      const r = Tender.safeParse(withPaths);
      assert.ok(r.success, `${p.slug}/${x.id}: ${r.success ? "" : r.error.message}`);
      assert.ok(x.submissionDeadline > `${x.publicationDate}T`, `${p.slug}/${x.id} deadline after publication`);
    }
  }
});

test("stadtwerke: list pages link every tender, detail shows the values", async () => {
  const t = await truthOf("stadtwerke");
  const html = (await (await get("/stadtwerke/ausschreibungen")).text()) + (await (await get("/stadtwerke/ausschreibungen?seite=2")).text());
  for (const x of t.tenders) {
    assert.ok(html.includes(new URL(x.url).pathname), `list links ${x.id}`);
    const d = await (await get(new URL(x.url).pathname)).text();
    assert.ok(d.includes(x.referenceNumber) && d.includes(x.buyerName));
  }
  assert.equal(t.tenders.filter((x) => x.status === "withdrawn").length, 1);
});

test("ville: the HTML is an empty shell, the API has every tender", async () => {
  const shell = await (await get("/ville/")).text();
  const t = await truthOf("ville");
  assert.ok(!shell.includes(t.tenders[0]!.title), "no tender in the raw HTML");
  const ids: string[] = [];
  for (let n = 1; n <= 3; n++) {
    const d = (await (await get(`/ville/api/consultations?page=${n}&taille=5`)).json()) as { resultats: Array<{ id: string; dateLimiteRemise: string }> };
    ids.push(...d.resultats.map((r) => r.id));
  }
  assert.deepEqual(ids, t.tenders.map((x) => x.id));
});

test("gmina: documents are one hop away and the ZIP unpacks to the truth's files", async () => {
  const t = await truthOf("gmina");
  for (const x of t.tenders) {
    const detail = await (await get(new URL(x.url).pathname)).text();
    assert.ok(detail.includes(`/gmina/przetarg/${x.id}/dokumentacja`));
    const docs = await (await get(`/gmina/przetarg/${x.id}/dokumentacja`)).text();
    const links = [...docs.matchAll(/href="(\/gmina\/pliki\/[^"]+)"/g)].map((m) => m[1]!);
    const got: string[] = [];
    for (const l of links) {
      const buf = Buffer.from(await (await get(l)).arrayBuffer());
      if (l.endsWith(".zip")) got.push(...(await unzipNames(buf)).map((e) => e.sha));
      else got.push(sha256(buf));
    }
    assert.deepEqual(got.sort(), x.documents.map((d) => d.sha256).sort(), `documents of ${x.id}`);
  }
});

test("every document in every truth downloads with that hash and size", async () => {
  for (const slug of ["stadtwerke", "ville"]) {
    const t = await truthOf(slug);
    for (const x of t.tenders) {
      const page = slug === "ville" ? null : await (await get(new URL(x.url).pathname)).text();
      for (const d of x.documents) {
        const path = slug === "ville" ? `/ville/api/consultations/${x.id}/pieces/${encodeURIComponent(d.fileName)}` : `/stadtwerke/dokumente/${x.id}/${encodeURIComponent(d.fileName)}`;
        if (page) assert.ok(page.includes(path), `${slug}/${x.id} links ${d.fileName}`);
        const res = await get(path);
        const buf = Buffer.from(await res.arrayBuffer());
        assert.equal(buf.length, d.sizeBytes);
        assert.equal(sha256(buf), d.sha256);
        assert.match(res.headers.get("content-disposition") ?? "", new RegExp(d.fileName.replace(/\./g, "\\.")));
      }
    }
  }
});

test("lab counts requests per portal and accepts a variant", async () => {
  await get("/gmina/przetargi");
  const v = await fetch(`${base}/_lab/variant?portal=gmina&v=v2`, { method: "POST" });
  assert.equal(v.status, 200);
  const s = (await (await get("/_lab/state")).json()) as { portals: Array<{ slug: string; variant: string; requests: number }> };
  const g = s.portals.find((p) => p.slug === "gmina")!;
  assert.equal(g.variant, "v2");
  assert.ok(g.requests > 0);
});
