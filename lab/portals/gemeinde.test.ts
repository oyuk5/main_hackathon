/**
 * Checks the "gemeinde" demo portal: JS-only list with a load-more button, server-rendered details.
 * Run: node --import tsx --test lab/portals/gemeinde.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { Tender } from "../../src/shared/contract.js";
import { sha256, type Truth } from "./common.js";
import { gemeinde } from "./gemeinde.js";
import { createLab } from "../serve.js";

const lab = createLab();
let base = "";
let browser: Browser;

before(async () => {
  await new Promise<void>((r) => lab.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(lab.server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  lab.server.close();
});

const get = (p: string) => fetch(base + p);
const text = async (p: string) => (await get(p)).text();
const truth = async (): Promise<Truth & { variant: string }> => (await get("/_truth/gemeinde.json")).json() as Promise<Truth & { variant: string }>;
const setVariant = async (v: string) => assert.equal((await fetch(`${base}/_lab/variant?portal=gemeinde&v=${v}`, { method: "POST" })).status, 200);
const listPathOf = (v: string) => (v === "moved-list" ? "/gemeinde/buergerservice/vergaben" : "/gemeinde/ausschreibungen");
const ALL = ["v1", ...Object.keys(gemeinde.variants)];

/** The list link on the start page, as a reader following links finds it. */
async function listFromStart(): Promise<string> {
  const start = await text("/gemeinde/");
  const m = start.match(/href="(\/gemeinde\/[^"]+)">Ausschreibungen und Vergaben</);
  assert.ok(m, "start page links the list");
  return m[1]!;
}

/** Opens the list in a browser, clicks the load-more button until it disappears; returns link counts and hrefs. */
async function render(path: string): Promise<{ first: number; hrefs: string[]; clicks: number; text: string }> {
  const page = await browser.newPage();
  try {
    await page.goto(base + path);
    const links = page.locator('#vergabe-app a[href*="/gemeinde/vergabe/"]');
    const button = page.locator("#vergabe-app button");
    await page.waitForFunction(() => !document.querySelector("#vergabe-app .laden"));
    const first = await links.count();
    let clicks = 0;
    while ((await button.count()) > 0) {
      const n = await links.count();
      await button.click();
      clicks++;
      await page.waitForFunction((k) => document.querySelectorAll('#vergabe-app a[href*="/gemeinde/vergabe/"]').length > k, n);
      assert.ok(clicks < 10, "button goes away");
    }
    const hrefs = await links.evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).pathname));
    assert.equal(new URL(page.url()).pathname, path, "no URL change");
    return { first, hrefs, clicks, text: await page.locator("#vergabe-app").innerText() };
  } finally {
    await page.close();
  }
}

test("gemeinde truth has the contract's shape, a withdrawn tender and CPV check digits", async () => {
  await setVariant("v1");
  const t = await truth();
  assert.equal(t.tenders.length, 14);
  assert.equal(new Set(t.tenders.map((x) => x.id)).size, 14);
  for (const x of t.tenders) {
    const r = Tender.safeParse({ ...x, lastChangedAt: "2026-11-20T10:00:00+01:00", documents: x.documents.map((d) => ({ ...d, path: `/files/${d.sha256}` })) });
    assert.ok(r.success, `${x.id}: ${r.success ? "" : r.error.message}`);
    assert.match(x.submissionDeadline, /\+0[12]:00$/);
    assert.ok(x.submissionDeadline > `${x.publicationDate}T`);
  }
  assert.deepEqual(t.tenders.filter((x) => x.status === "withdrawn").map((x) => x.id), ["5152"]);
  for (const x of gemeinde.tenders) for (const c of x.cpv) assert.match(c, /^\d{8}-\d$/);
});

test("gemeinde: served list HTML has no titles, no detail links and no API address", async () => {
  await setVariant("v1");
  const t = await truth();
  const html = await text(await listFromStart());
  for (const x of t.tenders) {
    assert.ok(!html.includes(x.title), `no title ${x.id}`);
    assert.ok(!html.includes(new URL(x.url).pathname), `no detail link ${x.id}`);
    assert.ok(!html.includes(x.referenceNumber), `no reference ${x.id}`);
  }
  assert.ok(!/href="\/gemeinde\/vergabe\//.test(html));
  assert.ok(!/fetch\(|XMLHttpRequest|\/api\//.test(html), "no API to call");
});

test("gemeinde: detail pages show the values and documents match the truth", async () => {
  await setVariant("v1");
  const t = await truth();
  for (const x of t.tenders) {
    const d = await text(new URL(x.url).pathname);
    assert.ok(d.includes(x.referenceNumber) && d.includes(x.buyerName) && d.includes(x.title));
    if (x.status === "withdrawn") assert.ok(d.includes("Widerrufen"));
    const links = [...d.matchAll(/href="(\/gemeinde\/dokumente\/[^"]+)"/g)].map((m) => m[1]!);
    assert.equal(links.length, x.documents.length);
    for (const doc of x.documents) {
      const path = `/gemeinde/dokumente/${x.id}/${encodeURIComponent(doc.fileName)}`;
      assert.ok(links.includes(path), `${x.id} links ${doc.fileName}`);
      const res = await get(path);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.length, doc.sizeBytes);
      assert.equal(sha256(buf), doc.sha256);
      assert.match(res.headers.get("content-disposition") ?? "", new RegExp(doc.fileName.replace(/\./g, "\\.")));
    }
  }
});

test("gemeinde in a browser: 6 tenders first, the button loads the rest, every link works", async () => {
  await setVariant("v1");
  const t = await truth();
  const r = await render(await listFromStart());
  assert.equal(r.first, 6);
  assert.equal(r.clicks, 2);
  assert.deepEqual(r.hrefs, t.tenders.map((x) => new URL(x.url).pathname));
  for (const h of r.hrefs) assert.equal((await get(h)).status, 200, h);
  assert.ok(r.text.includes("Widerrufen"));
});

test("gemeinde: every variant keeps tenders reachable from the start page and the truth follows it", async () => {
  for (const v of ALL) {
    await setVariant(v);
    const t = await truth();
    assert.equal(t.variant, v);
    const list = await listFromStart();
    assert.equal(list, listPathOf(v));
    const r = await render(list);
    if (v === "empty-day") {
      assert.equal(t.tenders.length, 0);
      assert.equal(r.hrefs.length, 0);
      assert.ok(r.text.includes("Derzeit sind keine Ausschreibungen veröffentlicht."));
      continue;
    }
    assert.equal(t.tenders.length, 14, v);
    assert.equal(r.first, 6, v);
    assert.deepEqual(r.hrefs, t.tenders.map((x) => new URL(x.url).pathname), v);
    const x = t.tenders[0]!;
    const d = await text(new URL(x.url).pathname);
    assert.ok(d.includes(x.referenceNumber), `${v} detail page`);
    const doc = x.documents[0]!;
    const buf = Buffer.from(await (await get(`/gemeinde/dokumente/${x.id}/${encodeURIComponent(doc.fileName)}`)).arrayBuffer());
    assert.equal(sha256(buf), doc.sha256, `${v} document`);
  }
  await setVariant("v1");
});

test("gemeinde variants change what they say", async () => {
  await setVariant("renamed-classes");
  let h = await text("/gemeinde/ausschreibungen");
  assert.ok(h.includes("ausschreibungen-raster") && !h.includes("vergabe-liste"));
  assert.ok((await text("/gemeinde/vergabe/5100")).includes('class="angaben"'));

  await setVariant("button-text");
  h = await text("/gemeinde/ausschreibungen");
  assert.ok(h.includes("Mehr anzeigen") && h.includes("mehr-anzeigen-btn") && !h.includes("Weitere laden") && !h.includes("btn-weitere"));

  await setVariant("moved-list");
  assert.equal((await get("/gemeinde/ausschreibungen")).status, 404);
  assert.equal((await get("/gemeinde/buergerservice/vergaben")).status, 200);

  await setVariant("date-format");
  const d = await text("/gemeinde/vergabe/5100");
  assert.match(d, /\d+\. (Jänner|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember) 20\d\d, \d\d:\d\d Uhr/);
  assert.ok(!d.includes("Januar"));

  await setVariant("cookie-banner");
  assert.ok((await text("/gemeinde/ausschreibungen")).includes("cookie-hinweis"));

  await setVariant("empty-day");
  assert.ok((await text("/gemeinde/ausschreibungen")).includes("Derzeit sind keine Ausschreibungen veröffentlicht."));
  assert.equal((await get("/gemeinde/vergabe/5100")).status, 404);
  await setVariant("v1");
});
