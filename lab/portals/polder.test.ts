/**
 * Checks the polder demo portal (RSS/Atom feed + HTML detail pages) against its own truth.
 * Run: node --import tsx --test lab/portals/polder.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Tender } from "../../src/shared/contract.js";
import { sha256, type Truth } from "./common.js";
import { createLab } from "../serve.js";
import { polder } from "./polder.js";

const lab = createLab();
let base = "";

before(async () => {
  await new Promise<void>((r) => lab.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(lab.server.address() as AddressInfo).port}`;
});
after(() => lab.server.close());

const get = (p: string) => fetch(base + p);
const text = async (p: string) => (await get(p)).text();
const truth = async (): Promise<Truth & { variant: string }> => (await get("/_truth/polder.json")).json() as Promise<Truth & { variant: string }>;
const setVariant = (v: string) => fetch(`${base}/_lab/variant?portal=polder&v=${v}`, { method: "POST" });
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));
const local = (u: string) => (u.startsWith("http") ? new URL(u).pathname : u);

/** Strict enough XML well-formedness check: one root, balanced tags, no stray "&" or "<". Returns the root name. */
function wellFormed(xml: string): string {
  const body = xml.replace(/^\uFEFF?<\?xml[^?]*\?>\s*/, "");
  const stack: string[] = [];
  let root = "";
  let i = 0;
  while (i < body.length) {
    const lt = body.indexOf("<", i);
    const chunk = body.slice(i, lt === -1 ? body.length : lt);
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(chunk), `bad entity in text: ${chunk.slice(0, 60)}`);
    if (stack.length === 0) assert.equal(chunk.trim(), "", "text outside the root");
    if (lt === -1) break;
    const gt = body.indexOf(">", lt);
    assert.ok(gt > lt, "unclosed tag");
    const tag = body.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith("!--")) continue;
    const m = tag.match(/^(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+="[^"<]*")*)\s*(\/?)$/);
    assert.ok(m, `malformed tag <${tag}>`);
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(m[3] ?? ""), `bad entity in attributes of <${tag}>`);
    const [, close, name, , self] = m;
    if (close) assert.equal(stack.pop(), name, `</${name}> closes the wrong element`);
    else {
      if (stack.length === 0) {
        assert.equal(root, "", "more than one root element");
        root = name!;
      }
      if (!self) stack.push(name!);
    }
  }
  assert.deepEqual(stack, [], "unclosed elements");
  return root;
}

/** The feed address as the start page links it. */
async function feedPath(): Promise<string> {
  const start = await text("/polder/");
  const alt = start.match(/<link rel="alternate" type="application\/(rss|atom)\+xml"[^>]*href="([^"]+)"/);
  assert.ok(alt, "start page announces the feed");
  assert.ok(hrefs(start).includes(alt[2]!), "start page also links the feed visibly");
  return alt[2]!;
}

function feedLinks(xml: string, root: string): string[] {
  return root === "rss"
    ? [...xml.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map((m) => m[1]!)
    : [...xml.matchAll(/<entry>[\s\S]*?<link rel="alternate" type="text\/html" href="([^"]+)"/g)].map((m) => m[1]!);
}

test("truth has the contract's shape, a withdrawn tender and CPV codes with check digits", async () => {
  const t = await truth();
  assert.equal(t.portal, "polder");
  assert.ok(t.tenders.length >= 10 && t.tenders.length <= 15);
  assert.equal(new Set(t.tenders.map((x) => x.id)).size, t.tenders.length);
  for (const x of t.tenders) {
    const r = Tender.safeParse({ ...x, lastChangedAt: "2026-11-20T10:00:00+01:00", documents: x.documents.map((d) => ({ ...d, path: `/files/${d.sha256}` })) });
    assert.ok(r.success, `${x.id}: ${r.success ? "" : r.error.message}`);
    assert.ok(x.submissionDeadline > `${x.publicationDate}T`);
    assert.match(x.submissionDeadline, /\+0[12]:00$/);
    assert.match(x.placeOfPerformance.postalCode, /^\d{4} [A-Z]{2}$/);
  }
  assert.equal(t.tenders.filter((x) => x.status === "withdrawn").length, 1);
  for (const tender of polder.tenders) for (const c of tender.cpv) assert.match(c, /^\d{8}-\d$/);
});

test("start page → feed and list → every detail page, with the truth's values", async () => {
  const t = await truth();
  const start = await text("/polder/");
  assert.ok(hrefs(start).includes("/polder/aanbestedingen"));
  const xml = await text(await feedPath());
  const links = feedLinks(xml, wellFormed(xml)).map(local);
  const list = hrefs(await text("/polder/aanbestedingen"));
  for (const x of t.tenders) {
    const p = new URL(x.url).pathname;
    assert.ok(links.includes(p), `feed links ${x.id}`);
    assert.ok(list.includes(p), `list links ${x.id}`);
    const d = await text(p);
    for (const v of [x.referenceNumber, x.buyerName, x.placeOfPerformance.postalCode, x.placeOfPerformance.city]) assert.ok(d.includes(v), `${x.id} shows ${v}`);
    for (const c of x.cpvCodes) assert.ok(d.includes(c), `${x.id} shows CPV ${c}`);
    const [date, time] = x.submissionDeadline.split("T");
    assert.ok(d.includes(`${date!.split("-").reverse().join("-")} ${time!.slice(0, 5)}`), `${x.id} shows the deadline`);
    assert.equal(d.includes("Ingetrokken"), x.status === "withdrawn", `${x.id} status`);
  }
});

test("every document downloads with the truth's hash and size and is linked from its detail page", async () => {
  const t = await truth();
  for (const x of t.tenders) {
    const links = hrefs(await text(new URL(x.url).pathname)).filter((h) => h.startsWith("/polder/documenten/"));
    assert.equal(links.length, x.documents.length, `${x.id} links all documents`);
    for (const d of x.documents) {
      const l = links.find((h) => decodeURIComponent(h).endsWith(`/${d.fileName}`));
      assert.ok(l, `${x.id} links ${d.fileName}`);
      const res = await get(l);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.length, d.sizeBytes);
      assert.equal(sha256(buf), d.sha256);
      assert.match(res.headers.get("content-disposition") ?? "", new RegExp(d.fileName.replace(/\./g, "\\.")));
    }
  }
});

test("RSS 2.0 and Atom both parse as well-formed XML and every item links to an existing detail page", async () => {
  for (const [v, rootName, type] of [["v1", "rss", "application/rss+xml"], ["atom", "feed", "application/atom+xml"]] as const) {
    await setVariant(v);
    const t = await truth();
    const fp = await feedPath();
    assert.equal(fp, "/polder/aanbestedingen.rss", "atom keeps the address");
    const res = await get(fp);
    assert.match(res.headers.get("content-type") ?? "", new RegExp(type.replace("+", "\\+")));
    const xml = await res.text();
    assert.equal(wellFormed(xml), rootName);
    if (v === "atom") assert.ok(xml.includes('xmlns="http://www.w3.org/2005/Atom"') && !xml.includes("<item>"));
    else assert.ok(xml.includes('<rss version="2.0"') && xml.includes("<channel>"));
    const links = feedLinks(xml, rootName);
    assert.equal(links.length, t.tenders.length);
    for (const l of links) assert.equal((await get(local(l))).status, 200, `${v}: ${l} exists`);
    assert.deepEqual(links.map(local).sort(), t.tenders.map((x) => new URL(x.url).pathname).sort());
  }
  await setVariant("v1");
});

test("every variant keeps tenders reachable from the start page and the truth follows it", async () => {
  for (const v of ["v1", ...Object.keys(polder.variants)]) {
    assert.equal((await setVariant(v)).status, 200);
    const t = await truth();
    assert.equal(t.variant, v);
    const fp = await feedPath();
    const xml = await text(fp);
    const root = wellFormed(xml);
    const links = feedLinks(xml, root).map(local);
    const list = await text("/polder/aanbestedingen");
    if (v === "empty-day") {
      assert.equal(t.tenders.length, 0);
      assert.equal(links.length, 0);
      assert.ok(list.includes("Er zijn momenteel geen aanbestedingen."));
      continue;
    }
    assert.equal(t.tenders.length, polder.tenders.length, `${v} keeps its tenders`);
    for (const x of t.tenders) {
      const p = new URL(x.url).pathname;
      assert.ok(links.includes(p) && hrefs(list).includes(p), `${v}: ${x.id} reachable`);
      assert.equal((await get(p)).status, 200);
    }
  }
  await setVariant("v1");
});

test("variants change what they say", async () => {
  await setVariant("feed-moved");
  assert.equal((await get("/polder/aanbestedingen.rss")).status, 404);
  assert.equal(await feedPath(), "/polder/feeds/aanbestedingen.xml");

  const x = polder.tenders[0]!;
  await setVariant("renamed-classes");
  let d = await text(`/polder/aanbesteding/${x.id}`);
  assert.ok(d.includes('class="kenmerken"') && !d.includes('class="gegevens"') && d.includes('class="download"') && !d.includes('class="document"'));

  await setVariant("date-format");
  d = await text(`/polder/aanbesteding/${x.id}`);
  const months = "(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)";
  assert.match(d, new RegExp(`\\d{1,2} ${months} 20\\d\\d, \\d\\d:\\d\\d uur`));
  assert.doesNotMatch(d, /\d\d-\d\d-20\d\d/);
  assert.match(await text("/polder/aanbestedingen.rss"), new RegExp(`Sluitingsdatum: \\d{1,2} ${months} 20\\d\\d, \\d\\d:\\d\\d uur`));

  await setVariant("cookie-banner");
  d = await text(`/polder/aanbesteding/${x.id}`);
  assert.ok(d.includes("cookie-consent") && d.includes('class="gegevens"'));
  await setVariant("v1");
});
