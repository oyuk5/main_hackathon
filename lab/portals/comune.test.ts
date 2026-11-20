/**
 * Checks the comune demo portal: POST search with cursors, JSON and HTML details, two-hop documents, variants.
 * Run: node --import tsx --test lab/portals/comune.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import yauzl from "yauzl";
import { Tender } from "../../src/shared/contract.js";
import { createLab } from "../serve.js";
import { comune } from "./comune.js";
import { sha256, type Truth } from "./common.js";

const lab = createLab();
let base = "";

before(async () => {
  await new Promise<void>((r) => lab.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(lab.server.address() as AddressInfo).port}`;
});
after(() => lab.server.close());

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const get = (p: string) => fetch(base + p);
const text = async (p: string) => (await get(p)).text();
const json = async (p: string): Promise<Json> => (await get(p)).json() as Promise<Json>;
const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const truth = async (): Promise<Truth & { variant: string }> => (await get("/_truth/comune.json")).json() as Promise<Truth & { variant: string }>;
const setVariant = (v: string) => fetch(`${base}/_lab/variant?portal=comune&v=${v}`, { method: "POST" });

function unzip(buf: Buffer): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: Buffer[] = [];
      zip.on("entry", (e: yauzl.Entry) =>
        zip.openReadStream(e, (er, s) => {
          if (er || !s) return reject(er);
          const parts: Buffer[] = [];
          s.on("data", (c: Buffer) => parts.push(c));
          s.on("end", () => (out.push(Buffer.concat(parts)), zip.readEntry()));
        }),
      );
      zip.on("end", () => resolve(out));
      zip.readEntry();
    });
  });
}

/** Walks the cursor search to the end, as a reader would. */
async function allByCursor(api: string, listKey: string, nextKey: string, size = 5): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let cursore: string | null = null;
  let pages = 0;
  do {
    const r = await post(`${api}/ricerca`, { dimensione: size, cursore });
    assert.equal(r.status, 200);
    const d = (await r.json()) as Json;
    ids.push(...(d[listKey] as Json[]).map((x) => x.id as string));
    cursore = d[nextKey] as string | null;
    pages++;
    assert.ok(pages < 20, "cursor ends");
  } while (cursore);
  return { ids, pages };
}

/** Follows detail JSON → allegati → files and returns the sha256 of every document (ZIPs unpacked). */
async function documentHashes(detailPath: string, k: { docsLink: string; files: string; fileLink: string }): Promise<string[]> {
  const d = await json(detailPath);
  const al = await json(d[k.docsLink] as string);
  const out: string[] = [];
  for (const f of al[k.files] as Json[]) {
    const buf = Buffer.from(await (await get(f[k.fileLink] as string)).arrayBuffer());
    if ((f[k.fileLink] as string).endsWith(".zip")) out.push(...(await unzip(buf)).map(sha256));
    else out.push(sha256(buf));
  }
  return out.sort();
}

const V1 = { docsLink: "linkAllegati", files: "allegati", fileLink: "url" };

test("truth has the contract's shape, a revoked tender and CPV with check digits on the portal", async () => {
  const t = await truth();
  assert.equal(t.variant, "v1");
  assert.ok(t.tenders.length >= 10 && t.tenders.length <= 15);
  assert.equal(new Set(t.tenders.map((x) => x.id)).size, t.tenders.length);
  for (const x of t.tenders) {
    const r = Tender.safeParse({ ...x, lastChangedAt: "2026-11-20T10:00:00+01:00", documents: x.documents.map((d) => ({ ...d, path: `/files/${d.sha256}` })) });
    assert.ok(r.success, `${x.id}: ${r.success ? "" : r.error.message}`);
    assert.ok(x.submissionDeadline > `${x.publicationDate}T`);
    assert.match(x.submissionDeadline, /\+0[12]:00$/);
    assert.equal(x.placeOfPerformance.countryCode, "IT");
  }
  assert.equal(t.tenders.filter((x) => x.status === "withdrawn").length, 1);
  for (const lt of comune.tenders) for (const c of lt.cpv) assert.match(c, /^\d{8}-\d$/);
});

test("start page is a JS shell that loads the app script, which calls the POST API", async () => {
  const t = await truth();
  const shell = await text("/comune/");
  assert.ok(!shell.includes(t.tenders[0]!.title), "no tender in the raw HTML");
  assert.ok(shell.includes('src="/comune/static/bandi.js"'));
  const js = await text("/comune/static/bandi.js");
  assert.ok(js.includes('"/comune/api/bandi"') && js.includes("/ricerca") && js.includes('method: "POST"') && js.includes("cursore"));
  assert.ok(js.includes("/comune/bandi/"), "the app links each tender's own page");
});

test("POST search pages with cursors and lists every tender exactly once", async () => {
  const t = await truth();
  const { ids, pages } = await allByCursor("/comune/api/bandi", "elementi", "next");
  assert.deepEqual(ids, t.tenders.map((x) => x.id));
  assert.equal(pages, Math.ceil(t.tenders.length / 5));
  const big = await allByCursor("/comune/api/bandi", "elementi", "next", 4);
  assert.deepEqual(big.ids, ids);
  const first = (await (await post("/comune/api/bandi/ricerca", { dimensione: 5 })).json()) as Json;
  assert.equal(first.elementi.length, 5);
  assert.match(first.elementi[0].scadenza, /^\d{4}-\d\d-\d\dT\d\d:\d\d:00$/);
  assert.equal((await post("/comune/api/bandi/ricerca", { cursore: "garbage!" })).status, 400);
});

test("a GET to the search API is refused with 405", async () => {
  const r = await get("/comune/api/bandi/ricerca");
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "POST");
});

test("JSON details and HTML detail pages exist for every tender", async () => {
  const t = await truth();
  for (const x of t.tenders) {
    const path = new URL(x.url).pathname;
    assert.equal(path, `/comune/bandi/${x.id}`);
    const h = await get(path);
    assert.equal(h.status, 200);
    assert.ok((await h.text()).includes("/comune/static/bandi.js"));
    const d = await json(`/comune/api/bandi/${x.id}`);
    assert.equal(d.oggetto, x.title);
    assert.equal(d.codice, x.referenceNumber);
    assert.equal(d.stazioneAppaltante, x.buyerName);
    assert.equal(d.descrizione, x.description);
    assert.equal(d.luogo.cap, x.placeOfPerformance.postalCode);
    assert.deepEqual((d.cpv as string[]).map((c) => c.slice(0, 8)), x.cpvCodes);
    assert.equal(d.stato, x.status === "withdrawn" ? "revocata" : "in corso");
    assert.ok(x.submissionDeadline.startsWith(d.scadenza), `${x.id} deadline is local time`);
  }
  assert.equal((await get("/comune/api/bandi/G0")).status, 404);
});

test("two-hop documents resolve to the truth's bytes, sizes and hashes", async () => {
  const t = await truth();
  let zips = 0;
  for (const x of t.tenders) {
    const al = await json(`/comune/api/bandi/${x.id}/allegati`);
    for (const f of al.allegati as Json[]) {
      const r = await get(f.url);
      const buf = Buffer.from(await r.arrayBuffer());
      assert.equal(buf.length, f.dimensione);
      assert.match(r.headers.get("content-disposition") ?? "", new RegExp(String(f.nome).replace(/\./g, "\\.")));
      if (String(f.nome).endsWith(".zip")) zips++;
      else {
        const d = x.documents.find((y) => y.fileName === f.nome)!;
        assert.ok(d, `${x.id} truth lists ${f.nome}`);
        assert.equal(buf.length, d.sizeBytes);
        assert.equal(sha256(buf), d.sha256);
      }
    }
    assert.deepEqual(await documentHashes(`/comune/api/bandi/${x.id}`, V1), x.documents.map((d) => d.sha256).sort(), `documents of ${x.id}`);
  }
  assert.ok(zips >= 1);
});

test("every variant keeps tenders reachable and the truth follows it", async () => {
  const k2 = { docsLink: "documentiUrl", files: "documenti", fileLink: "link" };
  for (const v of ["v1", ...Object.keys(comune.variants)]) {
    assert.equal((await setVariant(v)).status, 200);
    const t = await truth();
    assert.equal(t.variant, v);
    const js = await text("/comune/static/bandi.js");
    const api = v === "moved-api" ? "/comune/api/v2/gare" : "/comune/api/bandi";
    assert.ok(js.includes(`"${api}"`), `${v}: the app names its API`);
    if (v === "empty-day") {
      assert.equal(t.tenders.length, 0);
      assert.ok((await text("/comune/")).includes("Nessuna gara in corso."));
      const d = (await (await post(`${api}/ricerca`, { dimensione: 5 })).json()) as Json;
      assert.deepEqual(d.elementi, []);
      assert.equal(d.next, null);
      continue;
    }
    assert.ok(t.tenders.length >= 10);
    const k = v === "renamed-keys" ? { list: "risultati", next: "cursoreSuccessivo" } : { list: "elementi", next: "next" };
    let ids: string[];
    if (v === "cursor-to-pages") {
      ids = [];
      const first = (await (await post(`${api}/ricerca`, { pagina: 1, dimensione: 5 })).json()) as Json;
      for (let n = 1; n <= first.pagine; n++) {
        const d = (await (await post(`${api}/ricerca`, { pagina: n, dimensione: 5 })).json()) as Json;
        ids.push(...(d.elementi as Json[]).map((x) => x.id as string));
      }
    } else ids = (await allByCursor(api, k.list, k.next)).ids;
    assert.deepEqual(ids, t.tenders.map((x) => x.id), `${v}: search lists every tender once`);
    for (const x of [t.tenders[0]!, t.tenders[2]!]) {
      assert.equal((await get(new URL(x.url).pathname)).status, 200, `${v}: detail page`);
      const hashes = await documentHashes(`${api}/${x.id}`, v === "renamed-keys" ? k2 : V1);
      assert.deepEqual(hashes, x.documents.map((d) => d.sha256).sort(), `${v}: documents of ${x.id}`);
    }
  }
  await setVariant("v1");
});

test("variants change what the API and shell say", async () => {
  await setVariant("renamed-keys");
  let d = (await (await post("/comune/api/bandi/ricerca", { dimensione: 5 })).json()) as Json;
  assert.ok(Array.isArray(d.risultati) && !("elementi" in d) && "cursoreSuccessivo" in d && "titolo" in d.risultati[0] && !("oggetto" in d.risultati[0]));
  assert.ok((await text("/comune/static/bandi.js")).includes('"titolo"'));

  await setVariant("moved-api");
  assert.equal((await post("/comune/api/bandi/ricerca", { dimensione: 5 })).status, 404);
  assert.equal((await get(`/comune/api/bandi/${comune.tenders[0]!.id}`)).status, 404);
  assert.equal((await post("/comune/api/v2/gare/ricerca", { dimensione: 5 })).status, 200);
  assert.equal((await get("/comune/api/v2/gare/ricerca")).status, 405);

  await setVariant("cursor-to-pages");
  d = (await (await post("/comune/api/bandi/ricerca", { pagina: 3, dimensione: 5 })).json()) as Json;
  assert.ok(!("next" in d) && d.totale === comune.tenders.length && d.pagina === 3 && d.pagine === 3);
  assert.equal(d.elementi.length, comune.tenders.length - 10);
  const a = (await (await post("/comune/api/bandi/ricerca", { dimensione: 5 })).json()) as Json;
  const b = (await (await post("/comune/api/bandi/ricerca", { dimensione: 5, cursore: "eyJvIjo1LCJ2IjoxfQ" })).json()) as Json;
  assert.deepEqual(a.elementi, b.elementi, "a cursor is ignored");

  await setVariant("date-format");
  d = (await (await post("/comune/api/bandi/ricerca", { dimensione: 5 })).json()) as Json;
  assert.match(d.elementi[0].scadenza, /^\d\d\/\d\d\/20\d\d ore \d\d:\d\d$/);
  assert.match(d.elementi[0].dataPubblicazione, /^\d\d\/\d\d\/20\d\d$/);

  await setVariant("cookie-banner");
  const h = await text("/comune/");
  assert.ok(h.includes("cookie-consent") && h.includes("/comune/static/bandi.js"));
  await setVariant("v1");
  assert.ok(!(await text("/comune/")).includes("cookie-consent"));
});
