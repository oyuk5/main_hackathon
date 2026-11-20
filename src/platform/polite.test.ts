/** robots.txt parsing and enforcement for plain HTTP and for every request the browser makes. */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { closeSharedBrowser, parseRobots, politeBrowser, politeHttp, robotsAllow } from "./polite.js";

describe("robots.txt rules", () => {
  const allowed = (txt: string, path: string, token = "watchtowerbot") => robotsAllow(parseRobots(txt, token), path);

  it("applies the * group and prefix matching", () => {
    const txt = "User-agent: *\nDisallow: /private\n";
    assert.equal(allowed(txt, "/private/x"), false);
    assert.equal(allowed(txt, "/public"), true);
  });

  it("lets a longer Allow win over a shorter Disallow", () => {
    const txt = "User-agent: *\nDisallow: /tenders\nAllow: /tenders/open\n";
    assert.equal(allowed(txt, "/tenders/open/42"), true);
    assert.equal(allowed(txt, "/tenders/closed/42"), false);
  });

  it("supports * wildcards and the $ end anchor", () => {
    const txt = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /search?*q=\n";
    assert.equal(allowed(txt, "/docs/a.pdf"), false);
    assert.equal(allowed(txt, "/docs/a.pdf?x=1"), true);
    assert.equal(allowed(txt, "/search?page=2&q=bridge"), false);
  });

  it("prefers the group naming our bot, and groups consecutive User-agent lines", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: OtherBot\nUser-agent: WatchtowerBot\nDisallow: /admin\n";
    assert.equal(allowed(txt, "/tenders"), true);
    assert.equal(allowed(txt, "/admin"), false);
    assert.equal(allowed(txt, "/tenders", "somebot"), false);
  });

  it("treats an empty Disallow and comments as no rule", () => {
    assert.equal(allowed("User-agent: * # all\nDisallow:\n", "/anything"), true);
  });
});

describe("robots.txt enforcement", () => {
  after(() => closeSharedBrowser());

  async function portal() {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/robots.txt") return res.end("User-agent: *\nDisallow: /secret\n");
      if (req.url === "/page")
        return res.end(`<!doctype html><html><body>page<script>fetch("/secret/data").catch(()=>{});fetch("/open/data").catch(()=>{})</script></body></html>`);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, hits, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
  }

  it("blocks a disallowed path over HTTP before any request is made", async () => {
    const p = await portal();
    try {
      const httpc = politeHttp(new AbortController().signal);
      await assert.rejects(httpc.fetch(`${p.base}/secret/file.pdf`), /robots\.txt disallows/);
      assert.deepEqual(p.hits, ["/robots.txt"]);
    } finally {
      await p.close();
    }
  });

  it("blocks disallowed requests the browser page makes, and lets the rest through", async () => {
    const p = await portal();
    try {
      await politeBrowser(new AbortController().signal).withPage(async (page) => {
        await page.goto(`${p.base}/page`);
        // The page's two fetches pass the 1 request/second gate one after the other.
        await page.waitForTimeout(3000);
      });
      assert.ok(p.hits.includes("/open/data"), `allowed fetch missing: ${p.hits.join(", ")}`);
      assert.ok(!p.hits.includes("/secret/data"), "disallowed fetch reached the portal");
    } finally {
      await p.close();
    }
  });
});
