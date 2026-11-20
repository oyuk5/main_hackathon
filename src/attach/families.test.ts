/** Families: fingerprints, templates, re-basing and attach order, with local portals and a counting model stub. */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { FamilyStore, fingerprint, pathPrefixShift, rebase, toTemplate } from "./families.js";
import { attachPortal, type AttachDeps } from "./index.js";
import { clearDetailCache, extractor, readSample } from "./extractor.js";
import { attachWithModel, type CartographerStep } from "./cartographer.js";
import type { PortalContext } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";

// ------------------------------------------------------------ fingerprints

test("fingerprint recognises software by its own hosts and application paths", () => {
  const f = (url: string, html = "") => fingerprint({ url, html })?.id ?? null;
  assert.equal(f("https://www.dtvp.de/Center/company/announcements/categoryOverview.do?method=showCategoryOverview"), "cosinex-vmp");
  assert.equal(f("https://vergabe.example.de/VMPCenter/company/announcements/categoryOverview.do"), "cosinex-vmp");
  assert.equal(f("https://vergabe.example.de/", '<footer><a href="https://www.cosinex.de/">cosinex GmbH</a></footer>'), "cosinex-vmp");
  assert.equal(f("https://vergabe.example.de/", '<a href="/VMPSatellite/notice/x.do">a</a><a href="/VMPCenter/public/y.do">b</a>'), "cosinex-vmp");
  assert.equal(f("https://platformazakupowa.pl/all"), "open-nexus");
  assert.equal(f("https://s2c.mercell.com/today"), "mercell");
  assert.equal(f("https://contrataciondelestado.es/wps/portal/plataforma"), "placsp");
  assert.equal(f("https://vergabe.example.de/NetServer/PublicationSearchControllerServlet"), "healy-hudson");
  assert.equal(f("https://marches.example.fr/index.php?page=Entreprise.EntrepriseAdvancedSearch&AllCons"), "atexo-mpe");
  // No EPPS signature: the only EPPS portal in the test set is hidden, so we do not tune on it.
  assert.equal(f("https://eprocurement.example.eu/epps/quickSearchAction.do"), null);
});

test("fingerprint stays silent on generic pages (no false positives)", () => {
  const f = (url: string, html = "") => fingerprint({ url, html });
  assert.equal(f("https://www.tenderned.nl/aankondigingen/overzicht"), null, "TenderNed is a known portal, not a family");
  assert.equal(f("https://example.de/", '<meta name="generator" content="WordPress 6.5"><a href="/ausschreibungen">x</a>'), null);
  assert.equal(f("https://example.de/news", "<p>Wir nutzen jetzt die Software von cosinex und Healy Hudson.</p>"), null, "a mention in text is not a signature");
  assert.equal(f("https://example.de/Center/about.html"), null, "/Center/ without a Struts action is generic");
  assert.equal(f("https://example.de/", '<a href="/epps/x.do">one link only</a>'), null);
  assert.equal(f("https://notplatformazakupowa.pl/all"), null, "host must match on a dot boundary");
  assert.equal(f("not a url"), null);
});

// ------------------------------------------------------------ templates and re-basing

const recipeOn = (origin: string, prefix = "/m"): Recipe =>
  Recipe.parse({
    schemaVersion: 1,
    tier: "html",
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    list: { request: { url: `${origin}${prefix}/list.do?p={page}`, headers: { Referer: `${origin}${prefix}/` } }, pagination: { type: "none" }, item: "tr.hit" },
    listFields: {
      id: { css: "td.nr" },
      url: { css: "a", attr: "href" },
      title: { css: "a" },
      buyerName: { css: "td.buyer" },
      publicationDate: { css: "td.pub" },
      submissionDeadline: { css: "td.frist" },
      fixed: { const: `${origin}${prefix}/t/{id}` },
    },
    documents: { hops: [], files: { css: "a.file", attr: "href", all: true }, via: "http" },
  });

test("a template replaces the portal's origin (with or without www.) and re-bases onto another host", () => {
  const r = recipeOn("https://www.alpha.example");
  r.listFields.other = { const: "https://alpha.example/x/{id}" };
  r.listFields.foreign = { const: "https://cdn.other.example/x" };
  const t = toTemplate(r, ["https://www.alpha.example/m/list.do"], "cosinex-vmp")!;
  const json = JSON.stringify(t.recipe);
  assert.ok(!json.includes("alpha.example"), json);
  assert.ok(json.includes("https://cdn.other.example/x"), "other hosts stay as they are");
  assert.match(json, /"family":"cosinex-vmp"/);

  const b = rebase(t, "http://beta.example:8080/m/list.do");
  assert.equal(b.list.request.url, "http://beta.example:8080/m/list.do?p={page}");
  assert.equal(b.list.request.headers?.Referer, "http://beta.example:8080/m/");
  assert.equal(b.listFields.other?.const, "http://beta.example:8080/x/{id}");
});

test("a list on another host does not make a template", () => {
  const r = recipeOn("https://api.elsewhere.example");
  assert.equal(toTemplate(r, ["https://www.alpha.example/"], "cosinex-vmp"), null);
});

test("the same software mounted under another first path segment is re-based too", () => {
  assert.deepEqual(pathPrefixShift("/Center/company/announcements/categoryOverview.do", "/VMPCenter/company/announcements/categoryOverview.do"), ["/Center", "/VMPCenter"]);
  assert.equal(pathPrefixShift("/a/b/c", "/a/b/c"), null);
  assert.equal(pathPrefixShift("/", "/x/y"), null);
  assert.equal(pathPrefixShift("/Center/x/y.do", "/x/y.do"), null);
  const t = toTemplate(recipeOn("https://one.example", "/Center"), ["https://one.example/Center/company/list.do"], "cosinex-vmp")!;
  const b = rebase(t, "https://two.example/VMPCenter/company/list.do");
  assert.equal(b.list.request.url, "https://two.example/VMPCenter/list.do?p={page}");
  assert.equal(b.listFields.fixed?.const, "https://two.example/VMPCenter/t/{id}");
});

test("templates round-trip through the store; unknown ids are refused", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wt-fam-"));
  try {
    const store = new FamilyStore(path.join(dir, "families"));
    assert.equal(store.load("cosinex-vmp"), null);
    const t = toTemplate(recipeOn("https://one.example"), ["https://one.example/"], "cosinex-vmp")!;
    store.save(t);
    assert.deepEqual(store.load("cosinex-vmp"), JSON.parse(JSON.stringify(t)));
    assert.deepEqual(readdirSync(path.join(dir, "families")), ["cosinex-vmp.json"], "no temp files left behind");
    assert.throws(() => store.save({ ...t, family: "../evil" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ attach order, end to end

type Reply = { status?: number; body: string };
let server: http.Server;
let port = 0;
/** Routes by host name (all hosts resolve to this one server through the fake http). */
const sites = new Map<string, (p: string) => Reply | null>();

before(async () => {
  server = http.createServer((req, res) => {
    const host = (req.headers["x-test-host"] as string) ?? "";
    const r = sites.get(host)?.(new URL(req.url ?? "/", "http://x").pathname) ?? null;
    res.writeHead(r ? (r.status ?? 200) : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(r ? r.body : "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());
beforeEach(() => {
  sites.clear();
  clearDetailCache();
});

const page = (body: string) => `<!doctype html><html><head><title>Vergabe</title></head><body>${body}<footer><a href="https://www.cosinex.de/">cosinex</a></footer></body></html>`;

/** A cosinex-looking portal on `host` whose app lives under `prefix`. `layout` changes the list markup. */
function cosinexSite(host: string, prefix: string, n = 6, layout: "same" | "other" = "same") {
  sites.set(host, (p) => {
    if (p === `${prefix}/company/list.do`) {
      const rows = Array.from({ length: n }, (_, i) =>
        layout === "same"
          ? `<tr class="hit"><td class="nr">${host}-${i}</td><td><a href="${prefix}/t/${i}.do">Bau ${i}</a></td><td class="buyer">Stadt ${host}</td><td class="pub">0${i + 1}.11.2026</td><td class="frist">15.12.2026 10:00</td></tr>`
          : `<div class="row"><span>${host}-${i}</span></div>`,
      ).join("");
      return { body: page(`<table><tbody>${rows}</tbody></table>`) };
    }
    const m = p.match(new RegExp(`^${prefix}/t/(\\d+)\\.do$`));
    if (m) return { body: page(`<h1>Bau ${m[1]}</h1><a class="file" href="${prefix}/f/${m[1]}.pdf">Unterlagen</a>`) };
    return null;
  });
}

const learned = (host: string, prefix: string): Recipe =>
  Recipe.parse({
    schemaVersion: 1,
    tier: "html",
    timeZone: "Europe/Berlin",
    countryCode: "DE",
    list: { request: { url: `http://${host}${prefix}/company/list.do` }, pagination: { type: "none" }, item: "tr.hit" },
    listFields: {
      id: { css: "td.nr" },
      url: { css: "a", attr: "href", parse: "url" },
      title: { css: "a" },
      buyerName: { css: "td.buyer" },
      publicationDate: { css: "td.pub", parse: "date" },
      submissionDeadline: { css: "td.frist", parse: "datetime" },
    },
    documents: { hops: [], files: { css: "a.file", attr: "href", all: true }, via: "http" },
  });

/** A portal context whose http sends every host to the local server, and whose model counts calls. */
function ctxFor(url: string, steps: CartographerStep[]): PortalContext & { calls: () => number; logs: string[] } {
  let calls = 0;
  const logs: string[] = [];
  return {
    portalId: "fam",
    url,
    http: {
      async fetch(u, init) {
        const target = new URL(u);
        const res = await fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, { ...init, headers: { "x-test-host": target.hostname } });
        // Keep the portal's own address as the response url, like a real fetch would.
        Object.defineProperty(res, "url", { value: u });
        return res;
      },
    },
    browser: {
      withPage() {
        throw new Error("no browser in this test");
      },
    },
    llm: {
      async json(opts) {
        const s = steps[calls++];
        if (!s) throw new Error("the model stub ran out of steps");
        return opts.schema.parse(s) as never;
      },
    },
    log: (m) => void logs.push(m),
    signal: new AbortController().signal,
    calls: () => calls,
    logs,
  };
}

const recipeStep = (recipe: Recipe): CartographerStep => ({ action: "recipe", navigateTo: null, reason: "test", recipe });

function depsWith(store: FamilyStore): AttachDeps {
  return {
    store: () => store,
    // No browser here: the model's look works from the plain page.
    model: (ctx) =>
      attachWithModel(ctx, {
        look: async (c, url) => {
          const r = await c.http.fetch(url);
          return { url, status: r.status, raw: await r.text(), rendered: null, json: [], feeds: [] };
        },
        sample: (r, c) => readSample(r, c),
        read: (r, c) => extractor.read(r, c),
        items: async () => ({ status: 200, items: [], pageStart: "" }),
      }),
    sample: (r, c) => readSample(r, c),
    read: (r, c) => extractor.read(r, c),
  };
}

function withStore(fn: (store: FamilyStore, dir: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wt-fam-"));
    try {
      await fn(new FamilyStore(path.join(dir, "families")), dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "the second portal of a family attaches with zero model calls, even when mounted under another path",
  withStore(async (store) => {
    cosinexSite("one.test", "/Center");
    cosinexSite("two.test", "/VMPCenter");

    const first = ctxFor("http://one.test/Center/company/list.do", [recipeStep(learned("one.test", "/Center"))]);
    const a = await attachPortal(first, depsWith(store));
    assert.equal(a.kind, "ok", JSON.stringify(a));
    if (a.kind !== "ok") return;
    assert.equal(first.calls(), 1);
    assert.equal(a.recipe.family, "cosinex-vmp");
    assert.ok(store.load("cosinex-vmp"), "the model-learned recipe became the family template");
    assert.ok(!JSON.stringify(store.load("cosinex-vmp")!.recipe).includes("one.test"));

    const second = ctxFor("http://two.test/VMPCenter/company/list.do", []);
    const b = await attachPortal(second, depsWith(store));
    assert.equal(b.kind, "ok", JSON.stringify(b) + second.logs.join("\n"));
    if (b.kind !== "ok") return;
    assert.equal(second.calls(), 0, "no model call for the second portal");
    assert.equal(b.note, "Reused the cosinex Vergabemarktplatz family recipe; no model call.");
    assert.equal(b.recipe.family, "cosinex-vmp");
    assert.equal(b.recipe.list.request.url, "http://two.test/VMPCenter/company/list.do");
    assert.equal(b.read.tenders.length, 6);
    assert.equal(b.read.tenders[0]!.id, "two.test-0");
    assert.equal(b.read.tenders[0]!.url, "http://two.test/VMPCenter/t/0.do");
    assert.equal(b.read.tenders[0]!.buyerName, "Stadt two.test");
    assert.ok(b.golden.length >= 3 && b.golden.length <= 5);
  }),
);

test(
  "a family template that fails the dry-run falls back to the model",
  withStore(async (store) => {
    cosinexSite("one.test", "/Center");
    cosinexSite("three.test", "/Center", 6, "other");
    store.save(toTemplate(learned("one.test", "/Center"), ["http://one.test/Center/company/list.do"], "cosinex-vmp")!);

    const fixed = learned("three.test", "/Center");
    fixed.list.item = "div.row";
    fixed.listFields = { id: { css: "span" }, num: { css: "span", regex: "-(\\d+)$" }, url: { const: "http://three.test/Center/t/{num}.do", parse: "url" }, title: { css: "span" } };
    const ctx = ctxFor("http://three.test/Center/company/list.do", [recipeStep(fixed), recipeStep(fixed)]);
    const out = await attachPortal(ctx, depsWith(store));
    assert.equal(out.kind, "ok", JSON.stringify(out) + ctx.logs.join("\n"));
    assert.ok(ctx.calls() >= 1, "the model was asked");
    assert.ok(ctx.logs.some((l) => /family recipe does not fit this portal/.test(l)), ctx.logs.join("\n"));
    if (out.kind === "ok") assert.equal(out.recipe.family, "cosinex-vmp");
    assert.match(JSON.stringify(store.load("cosinex-vmp")!.recipe), /div\.row/, "the newer model recipe replaced the template");
  }),
);

test(
  "an unknown family stores nothing",
  withStore(async (store, dir) => {
    sites.set("plain.test", (p) =>
      p === "/list"
        ? { body: `<table>${Array.from({ length: 4 }, (_, i) => `<tr class="hit"><td class="nr">P${i}</td><td><a href="/t/${i}">T ${i}</a></td></tr>`).join("")}</table>` }
        : p.startsWith("/t/")
          ? { body: "<h1>T</h1>" }
          : null,
    );
    const r = Recipe.parse({
      schemaVersion: 1,
      tier: "html",
      timeZone: "Europe/Berlin",
      list: { request: { url: "http://plain.test/list" }, pagination: { type: "none" }, item: "tr.hit" },
      listFields: { id: { css: "td.nr" }, url: { css: "a", attr: "href", parse: "url" }, title: { css: "a" } },
    });
    const ctx = ctxFor("http://plain.test/list", [recipeStep(r), recipeStep(r)]);
    const out = await attachPortal(ctx, depsWith(store));
    assert.equal(out.kind, "ok", JSON.stringify(out));
    if (out.kind === "ok") assert.equal(out.recipe.family, null);
    assert.equal(existsSync(path.join(dir, "families")), false);
  }),
);

test(
  "a model recipe that found no document links is not kept as the family template",
  withStore(async (store) => {
    cosinexSite("four.test", "/Center", 6, "other");
    const noDocs = learned("four.test", "/Center");
    noDocs.list.item = "div.row";
    noDocs.listFields = { id: { css: "span" }, url: { const: "http://four.test/Center/x/{id}", parse: "url" }, title: { css: "span" } };
    const ctx = ctxFor("http://four.test/Center/company/list.do", Array.from({ length: 4 }, () => recipeStep(noDocs)));
    const out = await attachPortal(ctx, depsWith(store));
    assert.equal(out.kind, "ok", JSON.stringify(out) + ctx.logs.join("\n"));
    assert.equal(store.load("cosinex-vmp"), null, "no template from a recipe without document links");
    assert.ok(ctx.logs.some((l) => /found no document links/.test(l)), ctx.logs.join("\n"));
  }),
);
