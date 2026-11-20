/**
 * Browser tier, list.before: a fake portal whose list appears only after a search form is filled and
 * submitted (in place by JavaScript, or by a classic form navigation), then pages by clicking "next".
 * Read through the real polite browser (1 request/second, robots.txt), so these tests are slow.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extractor, clearDetailCache, localDate } from "./extractor.js";
import { closeSharedBrowser, politeBrowser, politeHttp } from "../platform/polite.js";
import type { PortalContext } from "../shared/modules.js";
import { Recipe } from "../shared/recipe.js";

const TENDERS = [
  { id: "A1", title: "Brücke Nord", buyer: "Stadt Köln", pub: "09.12.2026", deadline: "15.12.2026 um 10:00 Uhr" },
  { id: "A2", title: "Schule Süd", buyer: "Stadt Bonn", pub: "10.12.2026", deadline: "16.12.2026 um 14:30 Uhr" },
  { id: "B1", title: "Straße West", buyer: "Kreis Aachen", pub: "11.12.2026", deadline: "17.12.2026 um 09:00 Uhr" },
];
const PAGE_SIZE = 2;

const row = (t: (typeof TENDERS)[number]) =>
  `<tr class="t"><td><abbr title="${t.pub}">${t.pub}</abbr></td><td><abbr title="${t.deadline}">x</abbr></td>` +
  `<td class="title">${t.title}</td><td class="buyer">${t.buyer}</td><td><a href="/tender?pid=${t.id}">open</a></td></tr>`;

/** Search form; results are fetched and drawn by JavaScript only after "Suchen", like DTVP's search. */
const SEARCH_SHELL = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<form id="f"><input id="q" name="q"><select id="status" name="status"><option value="all">Alle</option><option value="open">Offen</option></select>
<input type="hidden" id="page" value="1"><button id="go" type="submit">Suchen</button></form>
<div id="results"></div>
<script>
async function show() {
  const p = document.getElementById("page").value;
  const qs = "q=" + encodeURIComponent(document.getElementById("q").value) + "&status=" + document.getElementById("status").value + "&page=" + p;
  const data = await (await fetch("/api/results?" + qs)).json();
  document.getElementById("results").innerHTML = data.rows.length
    ? '<table><tbody>' + data.rows.join("") + '</tbody></table>' + (data.more ? '<a id="next" href="javascript:void(0)">Weiter</a>' : '')
    : '<p>Es wurden keine passenden Bekanntmachungen gefunden.</p>';
  const next = document.getElementById("next");
  if (next) next.addEventListener("click", () => { document.getElementById("page").value = Number(p) + 1; show(); });
}
document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); document.getElementById("page").value = 1; show(); });
</script></body></html>`;

/** Classic form: submitting navigates to /results, which the server renders. */
const CLASSIC_FORM = `<!doctype html><html><body><form action="/results" method="get">
<input name="from" id="from"><button id="send" type="submit">Suchen</button></form></body></html>`;

let server: http.Server;
let base = "";
const hits: string[] = [];
let llmCalls = 0;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(url.pathname + url.search);
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    if (url.pathname === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow:\n");
    if (url.pathname === "/search") return html(SEARCH_SHELL);
    if (url.pathname === "/classic") return html(CLASSIC_FORM);
    if (url.pathname === "/api/results") {
      const page = Number(url.searchParams.get("page") ?? "1");
      // Only the filled-in search finds anything.
      const match = url.searchParams.get("status") === "open" ? TENDERS : [];
      const rows = match.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(row);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ rows, more: page * PAGE_SIZE < match.length }));
    }
    if (url.pathname === "/results") {
      return html(`<!doctype html><html><body><table><tbody>${url.searchParams.get("from") ? TENDERS.map(row).join("") : ""}</tbody></table></body></html>`);
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await closeSharedBrowser();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  assert.equal(llmCalls, 0, "browser reads must never call the model");
});

beforeEach(() => {
  clearDetailCache();
  hits.length = 0;
});

let portalSeq = 0;
function makeCtx() {
  const controller = new AbortController();
  const ctx: PortalContext = {
    portalId: `browser-steps-test-${++portalSeq}`,
    url: `${base}/search`,
    http: politeHttp(controller.signal),
    browser: politeBrowser(controller.signal),
    llm: {
      json: async () => {
        llmCalls += 1;
        throw new Error("no model calls in a read");
      },
    },
    log: () => {},
    signal: controller.signal,
  };
  return { ctx, controller };
}

const listFields = {
  id: { css: "a", attr: "href", regex: "pid=(\\w+)" },
  url: { css: "a", attr: "href", parse: "url" },
  title: { css: ".title" },
  buyerName: { css: ".buyer" },
  publicationDate: { css: "td:nth-child(1) abbr", parse: "date" },
  submissionDeadline: { css: "td:nth-child(2) abbr", attr: "title", parse: "datetime" },
};

function recipe(list: Record<string, unknown>): Recipe {
  return Recipe.parse({ schemaVersion: 1, tier: "browser", timeZone: "Europe/Berlin", countryCode: "DE", list, listFields });
}

const searchList = (beforeSteps: unknown[]) => ({
  request: { url: `${base}/search` },
  pagination: { type: "clickNext", selector: "#next", maxPages: 5 },
  item: "tr.t",
  emptyText: ["Es wurden keine passenden Bekanntmachungen gefunden"],
  before: beforeSteps,
});

describe("list.before steps (browser tier)", { timeout: 180_000 }, () => {
  it("fills and submits a JavaScript search form, then pages with clickNext", async () => {
    const { ctx } = makeCtx();
    const out = await extractor.read(
      recipe(searchList([{ fill: { selector: "#q", value: "Bau" } }, { select: { selector: "#status", value: "Offen" } }, { click: "#go" }])),
      ctx,
    );
    assert.equal(out.kind, "ok", JSON.stringify(out));
    if (out.kind !== "ok") return;
    assert.deepEqual(out.tenders.map((t) => t.id), ["A1", "A2", "B1"]);
    const a1 = out.tenders[0]!;
    assert.equal(a1.url, `${base}/tender?pid=A1`);
    assert.equal(a1.title, "Brücke Nord");
    assert.equal(a1.buyerName, "Stadt Köln");
    assert.equal(a1.publicationDate, "2026-12-09");
    assert.equal(a1.submissionDeadline, "2026-12-15T10:00:00+01:00");
    assert.equal(out.diagnostics.listPages, 2);
    assert.deepEqual(out.diagnostics.fieldFill.submissionDeadline, { filled: 3, total: 3 });
    // The select matched by label; the form was opened once, page 2 came from clicking.
    assert.ok(hits.includes("/api/results?q=Bau&status=open&page=1"), hits.join(" "));
    assert.ok(hits.includes("/api/results?q=Bau&status=open&page=2"), hits.join(" "));
    assert.equal(hits.filter((h) => h === "/search").length, 1);
  });

  it("a search that finds nothing is an empty list with the portal's own words, not a broken one", async () => {
    const { ctx } = makeCtx();
    const out = await extractor.read(recipe(searchList([{ click: "#go" }])), ctx);
    assert.equal(out.kind, "ok", JSON.stringify(out));
    if (out.kind !== "ok") return;
    assert.equal(out.tenders.length, 0);
    assert.equal(out.diagnostics.emptyStateText, "Es wurden keine passenden Bekanntmachungen gefunden");
  });

  it("follows a classic form submit to a new page, with a date placeholder in the value", async () => {
    const { ctx } = makeCtx();
    const out = await extractor.read(
      recipe({
        request: { url: `${base}/classic` },
        pagination: { type: "none" },
        item: "tr.t",
        before: [{ fill: { selector: "#from", value: "{daysAgo:7}" } }, { click: "#send" }],
      }),
      ctx,
    );
    assert.equal(out.kind, "ok", JSON.stringify(out));
    if (out.kind !== "ok") return;
    assert.equal(out.tenders.length, 3);
    assert.ok(hits.includes(`/results?from=${localDate("Europe/Berlin", 7)}`), hits.join(" "));
  });

  it("a step whose element is missing fails the read with a reason naming the step", async () => {
    const { ctx } = makeCtx();
    const out = await extractor.read(recipe(searchList([{ click: "#no-such-button" }])), ctx);
    assert.notEqual(out.kind, "ok");
    if (out.kind !== "ok") assert.match(out.reason, /list\.before step 1 \(click "#no-such-button"\)/);
  });

  it("steps are data only: unknown actions and mixed steps are rejected", () => {
    const bad = (steps: unknown[]) => () => recipe(searchList(steps));
    assert.throws(bad([{ eval: "document.forms[0].submit()" }]));
    assert.throws(bad([{ click: "#go", fill: { selector: "#q", value: "x" } }]));
    assert.throws(bad([{ click: "" }]));
    assert.doesNotThrow(bad([{ click: "#go" }]));
  });
});
