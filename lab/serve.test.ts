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
  const v = await fetch(`${base}/_lab/variant?portal=gmina&v=renamed-classes`, { method: "POST" });
  assert.equal(v.status, 200);
  const s = (await (await get("/_lab/state")).json()) as { portals: Array<{ slug: string; variant: string; requests: number }> };
  const g = s.portals.find((p) => p.slug === "gmina")!;
  assert.equal(g.variant, "renamed-classes");
  await fetch(`${base}/_lab/variant?portal=gmina&v=v1`, { method: "POST" });
  assert.ok(g.requests > 0);
});

// ---------------------------------------------------------------- mutator variants

async function setVariant(slug: string, v: string): Promise<Response> {
  return fetch(`${base}/_lab/variant?portal=${slug}&v=${v}`, { method: "POST" });
}
const text = async (p: string) => (await get(p)).text();

test("unknown variants are refused", async () => {
  assert.equal((await setVariant("gmina", "nope")).status, 400);
});

test("every variant keeps detail pages and documents reachable, and the truth follows it", async () => {
  for (const p of portals) {
    for (const v of ["v1", ...Object.keys(p.variants)]) {
      assert.equal((await setVariant(p.slug, v)).status, 200);
      const t = await truthOf(p.slug);
      assert.equal((t as Truth & { variant: string }).variant, v);
      if (v === "empty-day") {
        assert.equal(t.tenders.length, 0);
        continue;
      }
      assert.ok(t.tenders.length >= 10, `${p.slug}/${v} keeps its tenders`);
      const x = t.tenders[0]!;
      assert.equal((await get(new URL(x.url).pathname)).status, 200, `${p.slug}/${v} detail page`);
    }
    await setVariant(p.slug, "v1");
  }
});

test("stadtwerke variants change what they say", async () => {
  await setVariant("stadtwerke", "renamed-classes");
  let h = await text("/stadtwerke/ausschreibungen");
  assert.ok(h.includes('class="vergabeliste"') && !h.includes('class="tenders"') && h.includes('class="weiter"'));
  await setVariant("stadtwerke", "moved-list");
  assert.equal((await get("/stadtwerke/ausschreibungen")).status, 404);
  assert.ok((await text("/stadtwerke/")).includes("/stadtwerke/vergabe/aktuell"));
  assert.ok((await text("/stadtwerke/vergabe/aktuell")).includes("<tbody><tr>"));
  await setVariant("stadtwerke", "new-pagination");
  h = await text("/stadtwerke/ausschreibungen");
  assert.ok(!h.includes('class="next"') && h.includes("?page=3"));
  assert.equal((await text("/stadtwerke/ausschreibungen?page=3")).match(/<tr><td>/g)?.length, 4);
  await setVariant("stadtwerke", "date-format");
  assert.match(await text("/stadtwerke/ausschreibungen"), /\d+\. (Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember) 20\d\d, \d\d:\d\d Uhr/);
  await setVariant("stadtwerke", "cookie-banner");
  h = await text("/stadtwerke/ausschreibungen");
  assert.ok(h.includes("cookie-consent") && h.includes('class="tenders"'));
  await setVariant("stadtwerke", "empty-day");
  assert.ok((await text("/stadtwerke/ausschreibungen")).includes("keine Ausschreibungen"));
  await setVariant("stadtwerke", "v1");
});

test("ville variants change the API", async () => {
  await setVariant("ville", "renamed-keys");
  let d = (await (await get("/ville/api/consultations?page=1&taille=5")).json()) as Record<string, unknown>;
  assert.ok(Array.isArray(d.items) && !("resultats" in d) && "titre" in (d.items as object[])[0]!);
  assert.ok((await text("/ville/app.js")).includes('"titre"'));
  await setVariant("ville", "moved-list");
  assert.equal((await get("/ville/api/consultations?page=1")).status, 404);
  d = (await (await get("/ville/api/v2/consultations?page=1&taille=5")).json()) as Record<string, unknown>;
  assert.equal((d.resultats as unknown[]).length, 5);
  await setVariant("ville", "new-pagination");
  const a = (await (await get("/ville/api/consultations?page=1")).json()) as { resultats: Array<{ id: string }> };
  const b = (await (await get("/ville/api/consultations?page=2")).json()) as { resultats: Array<{ id: string }> };
  assert.deepEqual(a.resultats.map((r) => r.id), b.resultats.map((r) => r.id), "page is ignored");
  const c = (await (await get("/ville/api/consultations?offset=8&limit=4")).json()) as { resultats: unknown[] };
  assert.equal(c.resultats.length, 3);
  await setVariant("ville", "date-format");
  const f = (await (await get("/ville/api/consultations?page=1")).json()) as { resultats: Array<{ dateLimiteRemise: string }> };
  assert.match(f.resultats[0]!.dateLimiteRemise, /^\d\d\/\d\d\/20\d\d à \d\dh\d\d$/);
  await setVariant("ville", "empty-day");
  const e = (await (await get("/ville/api/consultations?page=1")).json()) as { total: number };
  assert.equal(e.total, 0);
  await setVariant("ville", "v1");
});

test("gmina variants change cards, paging and the documents page", async () => {
  await setVariant("gmina", "renamed-classes");
  assert.ok((await text("/gmina/przetargi")).includes('<article class="ogloszenie">'));
  await setVariant("gmina", "moved-list");
  assert.equal((await get("/gmina/przetargi")).status, 404);
  assert.ok((await text("/gmina/zamowienia-publiczne")).includes('class="karta"'));
  await setVariant("gmina", "new-pagination");
  const h = await text("/gmina/przetargi?strona=2");
  assert.ok(h.includes("?od=6") && !h.includes('rel="next"') && h.includes("Pozycje 1–6"));
  await setVariant("gmina", "moved-documents");
  const t = await truthOf("gmina");
  const x = t.tenders[0]!;
  assert.equal((await get(`/gmina/przetarg/${x.id}/dokumentacja`)).status, 404);
  assert.ok((await text(`/gmina/przetarg/${x.id}`)).includes(`/gmina/przetarg/${x.id}/zalaczniki`));
  assert.ok((await text(`/gmina/przetarg/${x.id}/zalaczniki`)).includes("/gmina/pliki/"));
  await setVariant("gmina", "date-format");
  assert.match(await text("/gmina/przetargi"), /\d+ (stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|października|listopada|grudnia) 20\d\d r\., godz\. \d\d:\d\d/);
  await setVariant("gmina", "v1");
});
