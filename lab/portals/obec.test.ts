/**
 * Checks the obec demo portal: public list and detail pages, every document behind a login.
 * Run: node --import tsx --test lab/portals/obec.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Tender } from "../../src/shared/contract.js";
import { sha256, type Truth } from "./common.js";
import { OBEC_SESSION_COOKIE, obec } from "./obec.js";
import { createLab } from "../serve.js";

const lab = createLab();
let base = "";

before(async () => {
  await new Promise<void>((r) => lab.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(lab.server.address() as AddressInfo).port}`;
});
after(() => lab.server.close());

const get = (p: string, init?: RequestInit) => fetch(base + p, init);
const text = async (p: string) => (await get(p)).text();
const truth = async (): Promise<Truth & { variant: string }> => (await get("/_truth/obec.json")).json() as Promise<Truth & { variant: string }>;
const setVariant = (v: string) => fetch(`${base}/_lab/variant?portal=obec&v=${v}`, { method: "POST" });
const links = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m[1]!.replace(/&amp;/g, "&"));

test("truth has the contract's shape and expects failed for the document login", async () => {
  const t = await truth();
  assert.equal(t.expect, "failed");
  assert.match(t.expectReason ?? "", /login/i);
  assert.ok(t.tenders.length >= 10 && t.tenders.length <= 15);
  assert.equal(new Set(t.tenders.map((x) => x.id)).size, t.tenders.length);
  assert.equal(t.tenders.filter((x) => x.status === "withdrawn").length, 1);
  for (const x of t.tenders) {
    const r = Tender.safeParse({ ...x, lastChangedAt: "2026-11-20T10:00:00+01:00", documents: x.documents.map((d) => ({ ...d, path: `/files/${d.sha256}` })) });
    assert.ok(r.success, `${x.id}: ${r.success ? "" : r.error.message}`);
    assert.ok(x.submissionDeadline > `${x.publicationDate}T`);
    assert.match(x.submissionDeadline, /\+0[12]:00$/, "Prague offset");
    assert.ok(x.documents.length >= 2);
  }
});

test("start page → list → every detail page, all without a login", async () => {
  const t = await truth();
  const start = await get("/obec/");
  assert.equal(start.status, 200);
  const listPath = links(await start.text(), /href="(\/obec\/verejne-zakazky)"/g)[0];
  assert.ok(listPath, "start page links the list");
  const list = await get(listPath);
  assert.equal(list.status, 200);
  const html = await list.text();
  assert.ok(!/type="password"/.test(html), "list has no login form");
  const found = links(html, /href="(\/obec\/zakazka\/\d+)"/g);
  assert.deepEqual(found.sort(), t.tenders.map((x) => new URL(x.url).pathname).sort());
  assert.ok(html.includes("Zrušeno"), "cancelled tender is shown as such");
  for (const x of t.tenders) {
    const res = await get(new URL(x.url).pathname);
    assert.equal(res.status, 200);
    const d = await res.text();
    assert.ok(!/type="password"/.test(d), "detail page has no login form");
    assert.ok(d.includes(x.referenceNumber) && d.includes(x.title) && d.includes(x.placeOfPerformance.postalCode!));
    if (x.status === "withdrawn") assert.ok(d.includes("Zrušeno"));
  }
});

test("every document link redirects to the login page; files answer 401 without the cookie", async () => {
  const t = await truth();
  for (const x of t.tenders) {
    const d = await text(new URL(x.url).pathname);
    const docLinks = links(d, /href="(\/obec\/dokument\/[^"]+)"/g);
    assert.equal(docLinks.length, x.documents.length, `${x.id} links every document`);
    for (const l of docLinks) {
      const r = await get(l, { redirect: "manual" });
      assert.equal(r.status, 302, l);
      const loc = r.headers.get("location") ?? "";
      assert.match(loc, /^\/obec\/prihlaseni\?/);
      const login = await get(loc);
      assert.equal(login.status, 200);
      assert.match(login.headers.get("content-type") ?? "", /text\/html/);
      const h = await login.text();
      assert.ok(h.includes("Přihlášení do systému") && /<form/.test(h) && /<input[^>]+type="password"/.test(h));
    }
    for (const doc of x.documents) {
      const r = await get(`/obec/soubory/${x.id}/${encodeURIComponent(doc.fileName)}`);
      assert.equal(r.status, 401, doc.fileName);
      await r.arrayBuffer();
    }
  }
});

test("with a session the documents match the truth's sha256 and size", async () => {
  const t = await truth();
  const headers = { cookie: OBEC_SESSION_COOKIE };
  for (const x of t.tenders) {
    const d = await text(new URL(x.url).pathname);
    const got: string[] = [];
    for (const l of links(d, /href="(\/obec\/dokument\/[^"]+)"/g)) {
      const r = await get(l, { redirect: "manual", headers });
      assert.equal(r.status, 302);
      const loc = r.headers.get("location") ?? "";
      assert.match(loc, /^\/obec\/soubory\//);
      const f = await get(loc, { headers });
      assert.equal(f.status, 200);
      const buf = Buffer.from(await f.arrayBuffer());
      const doc = x.documents.find((y) => y.sha256 === sha256(buf));
      assert.ok(doc, `${loc} is in the truth`);
      assert.equal(buf.length, doc.sizeBytes);
      assert.ok((f.headers.get("content-disposition") ?? "").includes(doc.fileName));
      got.push(doc.sha256);
    }
    assert.deepEqual(got.sort(), x.documents.map((y) => y.sha256).sort());
  }
});

test("posting the login form never grants a session", async () => {
  const r = await get("/obec/prihlaseni", { method: "POST", body: "username=a&password=b", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "manual" });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("set-cookie"), null);
  await r.text();
});

test("every variant keeps tenders reachable from the start page and the truth follows it", async () => {
  await setVariant("v1");
  const original = (await truth()).tenders;
  for (const v of ["v1", ...Object.keys(obec.variants)]) {
    assert.equal((await setVariant(v)).status, 200);
    const t = await truth();
    assert.equal(t.variant, v);
    assert.equal(t.expect, "failed");
    const start = await text("/obec/");
    const listPath = links(start, /href="(\/obec\/verejne-zakazky)"/g)[0]!;
    const html = await text(listPath);
    if (v === "empty-day") {
      assert.equal(t.tenders.length, 0);
      assert.ok(html.includes("nejsou vypsány žádné veřejné zakázky"));
      assert.equal(links(html, /href="(\/obec\/zakazka\/\d+)"/g).length, 0);
      continue;
    }
    assert.deepEqual(t.tenders, original, `${v} truth equals v1`);
    const found = links(html, /href="(\/obec\/zakazka\/\d+)"/g);
    assert.equal(found.length, t.tenders.length, `${v} list links every tender`);
    const x = t.tenders[0]!;
    const d = await text(new URL(x.url).pathname);
    assert.ok(d.includes(x.referenceNumber));
    const l = links(d, /href="(\/obec\/dokument\/[^"]+)"/g)[0]!;
    const r = await get(l, { redirect: "manual" });
    assert.equal(r.status, 302, `${v} documents still need a login`);
    if (v === "cookie-banner") assert.ok(html.includes("cookie-consent"));
    if (v === "renamed-classes") assert.ok(html.includes('class="seznam-vz"') && !html.includes('class="zakazky"') && d.includes('class="parametry"'));
  }
  await setVariant("v1");
});
