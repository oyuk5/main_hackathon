import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { cartographer, pickGolden, attachKnown } from "./index.js";
import { findKnownRecipe, registerKnownRecipe, type KnownRecipe } from "./known.js";
import type { ExtractedTender, PortalContext } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";
import { detailLabelHints } from "./cartographer.js";

test("detail label hints use exact observed labels and do not guess a place", () => {
  const recipe = Recipe.parse({ schemaVersion: 1, tier: "html", timeZone: "Europe/Warsaw", list: { request: { url: "https://example.org/" }, pagination: { type: "none" }, item: "article" }, listFields: { title: { css: "h2" } } });
  const hints = detailLabelHints(recipe, '<table><tr><th>Tryb postępowania</th><td>Przetarg nieograniczony</td></tr><tr><th>Rodzaj zamówienia</th><td>Roboty budowlane</td></tr><tr><th>Miejsce realizacji</th><td>Obszar całego kraju</td></tr></table>');
  assert.match(hints ?? "", /procedureType.*Tryb postępowania/);
  assert.match(hints ?? "", /contractNature.*Rodzaj zamówienia/);
  assert.doesNotMatch(hints ?? "", /postalCode/);
});

let server: http.Server;
let base = "";
let llmCalls = 0;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (url.pathname === "/api/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          items: [
            { id: "A1", title: "Bridge repair", buyer: "City of Testdorp", published: "2026-11-18", deadline: "2026-12-18T12:00:00" },
            { id: "A2", title: "School cleaning", buyer: null, published: "2026-11-19", deadline: null },
          ],
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  assert.equal(llmCalls, 0, "the known-recipe path must never call the LLM");
});

function makeCtx(url: string): PortalContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    portalId: "p1",
    url,
    http: { fetch: (u, init) => fetch(u, init) },
    browser: {
      withPage() {
        throw new Error("browser must not be used");
      },
    },
    llm: {
      json() {
        llmCalls += 1;
        throw new Error("LLM must not be called");
      },
    },
    log: (m) => void logs.push(m),
    signal: new AbortController().signal,
    logs,
  };
}

function tender(id: string, fields: Partial<ExtractedTender>): ExtractedTender {
  return { id, url: `https://example.test/${id}`, title: null, buyerName: null, publicationDate: null, submissionDeadline: null, documentRefs: [], ...fields };
}

test("TenderNed is known with and without www, on any path", () => {
  for (const u of ["https://www.tenderned.nl/aankondigingen/overzicht", "https://tenderned.nl/", "https://WWW.TenderNed.nl/x?y=1"]) {
    const k = findKnownRecipe(u);
    assert.equal(k?.name, "TenderNed", u);
    assert.equal(k?.recipe.tier, "jsonApi");
  }
  assert.equal(findKnownRecipe("https://nottenderned.nl/"), null);
  assert.equal(findKnownRecipe("https://tenderned.nl.evil.test/"), null);
  assert.equal(findKnownRecipe("not a url"), null);
});

test("path prefix narrows a match", () => {
  const recipe = findKnownRecipe("https://tenderned.nl/")!.recipe;
  const list: KnownRecipe[] = [{ name: "X", match: { host: "example.test", pathPrefix: "/vergabe" }, recipe }];
  assert.equal(findKnownRecipe("https://www.example.test/vergabe/list", list)?.name, "X");
  assert.equal(findKnownRecipe("https://example.test/other", list), null);
});

test("unknown portal without a model key fails honestly after one attempt", async () => {
  const ctx = { ...makeCtx(`${base}/not-known`) };
  let calls = 0;
  ctx.llm = {
    json() {
      calls += 1;
      throw new Error("OPENAI_API_KEY is not set");
    },
  };
  const out = await cartographer.attach(ctx);
  assert.equal(out.kind, "failed");
  assert.match((out as { reason: string }).reason, /^No model is configured/);
  assert.equal(calls, 1, "a missing key is not retried");
});

test("golden records: most filled first, only non-null fields, at most 5", () => {
  const tenders = [
    tender("t1", { title: "One" }),
    tender("t2", { title: "Two", buyerName: "B", publicationDate: "2026-11-01", submissionDeadline: "2026-12-01T12:00:00+01:00", referenceNumber: "R2" }),
    tender("t3", { title: "Three", buyerName: "B" }),
    tender("t4", { title: "Four", buyerName: "B", referenceNumber: "R4" }),
    tender("t5", { title: "Five" }),
    tender("t6", { title: "Six", buyerName: "B", publicationDate: "2026-11-02" }),
  ];
  const golden = pickGolden(tenders);
  assert.equal(golden.length, 5);
  assert.deepEqual(golden.map((g) => g.id), ["t2", "t4", "t6", "t3", "t1"]);
  assert.deepEqual(golden[3], { id: "t3", fields: { title: "Three", buyerName: "B", url: "https://example.test/t3" } });
  assert.ok(!("buyerName" in golden[4]!.fields));
});

test("blocked read passes through as blocked; unreachable and empty become failed", async () => {
  const known = findKnownRecipe("https://tenderned.nl/")!;
  const ctx = makeCtx("https://tenderned.nl/");
  assert.deepEqual(await attachKnown(known, ctx, async () => ({ kind: "blocked", reason: "A login form is in the way." })), {
    kind: "blocked",
    reason: "A login form is in the way.",
  });
  const unreachable = await attachKnown(known, ctx, async () => ({ kind: "unreachable", reason: "HTTP 503", httpStatus: 503 }));
  assert.equal(unreachable.kind, "failed");
  const empty = await attachKnown(known, ctx, async () => ({
    kind: "ok",
    tenders: [],
    diagnostics: { requests: 1, listPages: 1, itemsSeen: 0, fieldFill: {}, durationMs: 1 },
  }));
  assert.equal(empty.kind, "failed");
});

test("end to end: a registered jsonApi recipe attaches with the real Extractor", async () => {
  registerKnownRecipe(
    "Test portal",
    { host: "127.0.0.1", pathPrefix: "/portal" },
    {
      schemaVersion: 1,
      tier: "jsonApi",
      timeZone: "Europe/Amsterdam",
      countryCode: "NL",
      list: { request: { url: `${base}/api/list` }, pagination: { type: "none" }, item: "$.items[*]" },
      listFields: {
        id: { jsonPath: "$.id" },
        url: { const: `${base}/portal/tender/{id}`, parse: "url" },
        title: { jsonPath: "$.title" },
        buyerName: { jsonPath: "$.buyer" },
        publicationDate: { jsonPath: "$.published", parse: "date" },
        submissionDeadline: { jsonPath: "$.deadline", parse: "datetime" },
      },
    },
  );
  const ctx = makeCtx(`${base}/portal/overview`);
  const out = await cartographer.attach(ctx);
  assert.equal(out.kind, "ok", JSON.stringify(out));
  if (out.kind !== "ok") return;
  assert.equal(out.note, "Used the known Test portal recipe; no model call.");
  assert.doesNotThrow(() => Recipe.parse(out.recipe));
  assert.equal(out.read.tenders.length, 2);
  assert.equal(out.golden[0]?.id, "A1");
  assert.deepEqual(out.golden[0]?.fields, {
    title: "Bridge repair",
    buyerName: "City of Testdorp",
    publicationDate: "2026-11-18",
    submissionDeadline: "2026-12-18T12:00:00+01:00",
    url: `${base}/portal/tender/A1`,
  });
  assert.ok(ctx.logs.some((l) => l.includes("Test portal")));
  // the prefix keeps other paths on the same host unknown
  const elsewhere = { ...makeCtx(`${base}/elsewhere`), llm: { json: () => Promise.reject(new Error("OPENAI_API_KEY is not set")) } };
  assert.equal((await cartographer.attach(elsewhere)).kind, "failed", "not known: goes to the model path, which has no key here");
});
