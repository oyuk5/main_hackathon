/** robots.txt parsing and enforcement for plain HTTP and for every request the browser makes. */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { closeSharedBrowser, gate, parseRobots, politeBrowser, politeHttp, robotsAllow, robotsAllows } from "./polite.js";
import { fakePortal } from "./testkit.js";

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
    const times: number[] = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      times.push(performance.now());
      if (req.url === "/robots.txt") return res.end("User-agent: *\nDisallow: /secret\n");
      if (req.url === "/page")
        return res.end(`<!doctype html><html><body>page<script>fetch("/secret/data").catch(()=>{});fetch("/open/data").catch(()=>{})</script></body></html>`);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, hits, times, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
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
      for (let i = 1; i < p.times.length; i++) assert.ok(p.times[i]! - p.times[i - 1]! >= 1000, `browser requests too close: ${p.hits[i - 1]} → ${p.hits[i]}`);
    } finally {
      await p.close();
    }
  });
});

describe("per-portal gate", () => {
  it("spaces requests to one host by at least a second, and leaves other hosts alone", async () => {
    const host = `gate-test-${Date.now()}.example`;
    const t0 = Date.now();
    await gate(host);
    await gate(host);
    await gate(host);
    const same = Date.now() - t0;
    assert.ok(same >= 2000, `three requests to one host took only ${same} ms`);
    const t1 = Date.now();
    await Promise.all([gate(`a-${host}`), gate(`b-${host}`), gate(`c-${host}`)]);
    assert.ok(Date.now() - t1 < 200, "different hosts must not wait for each other");
  });

  it("an abort while waiting rejects at once", async () => {
    const host = `abort-test-${Date.now()}.example`;
    await gate(host);
    const c = new AbortController();
    const t0 = Date.now();
    const waiting = gate(host, c.signal);
    setTimeout(() => c.abort(), 50);
    await assert.rejects(waiting, /aborted/);
    assert.ok(Date.now() - t0 < 500);
  });
});

describe("robots.txt edge cases", () => {
  it("a robots.txt that answers 500 allows everything", async () => {
    const p = await fakePortal({ "/robots.txt": (_q, res) => res.writeHead(500).end("broken") });
    try {
      assert.equal(await robotsAllows(`${p.base}/tenders`), true);
    } finally {
      await p.close();
    }
  });

  it("an unreachable portal's robots.txt counts as allowed (the real request will fail on its own)", async () => {
    assert.equal(await robotsAllows("http://127.0.0.1:9/tenders"), true);
  });

  it("robots.txt is fetched once per portal, even for parallel requests", async () => {
    const p = await fakePortal({ "/robots.txt": (_q, res) => res.end("User-agent: *\nDisallow: /x\n") });
    try {
      await Promise.all([robotsAllows(`${p.base}/a`), robotsAllows(`${p.base}/b`), robotsAllows(`${p.base}/c`)]);
      assert.equal(p.hits.filter((h) => h === "/robots.txt").length, 1);
    } finally {
      await p.close();
    }
  });

  it("matches query strings and ignores rules for other bots", () => {
    const txt = "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /*?print=1\n";
    const rules = parseRobots(txt, "watchtowerbot");
    assert.equal(robotsAllow(rules, "/tender/1?print=1"), false);
    assert.equal(robotsAllow(rules, "/tender/1"), true);
  });
});

describe("redirects over plain HTTP", () => {
  async function redirecting() {
    const hits: { path: string; at: number; cookie: string }[] = [];
    const server = http.createServer((req, res) => {
      hits.push({ path: req.url!, at: Date.now(), cookie: req.headers.cookie ?? "" });
      if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /blocked\n");
      if (req.url === "/a") return res.writeHead(302, { location: "/b", "set-cookie": "lang=en; Path=/" }).end();
      // Loops until the cookie from /a comes back, like a cookie-based locale redirect.
      if (req.url === "/b") return req.headers.cookie?.includes("lang=en") ? res.writeHead(301, { location: "/c" }).end() : res.writeHead(302, { location: "/a" }).end();
      if (req.url === "/c") return res.writeHead(200, { "content-type": "text/plain" }).end("final");
      if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
      if (req.url === "/to-blocked") return res.writeHead(302, { location: "/blocked/x" }).end();
      if (req.url === "/form") return res.writeHead(303, { location: "/echo" }).end();
      if (req.url === "/echo") return res.writeHead(200).end(req.method);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, hits, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
  }

  it("gates every hop, sends cookies back, and lands on the final address", async () => {
    const p = await redirecting();
    try {
      const res = await politeHttp(new AbortController().signal).fetch(`${p.base}/a`);
      assert.equal(await res.text(), "final");
      assert.equal(res.url, `${p.base}/c`);
      const hops = p.hits.filter((h) => h.path !== "/robots.txt");
      assert.deepEqual(hops.map((h) => h.path), ["/a", "/b", "/c"]);
      assert.equal(hops[1]!.cookie, "lang=en");
      for (let i = 1; i < hops.length; i++) assert.ok(hops[i]!.at - hops[i - 1]!.at >= 1000, `hop ${i} came ${hops[i]!.at - hops[i - 1]!.at} ms after the last`);
    } finally {
      await p.close();
    }
  });

  it("refuses a redirect hop that robots.txt disallows", async () => {
    const p = await redirecting();
    try {
      const httpc = politeHttp(new AbortController().signal);
      await assert.rejects(httpc.fetch(`${p.base}/to-blocked`), /robots\.txt disallows \/blocked\/x/);
      assert.ok(!p.hits.some((h) => h.path.startsWith("/blocked")));
    } finally {
      await p.close();
    }
  });

  it("turns a POST into a GET after 303", async () => {
    const p = await redirecting();
    try {
      const res = await politeHttp(new AbortController().signal).fetch(`${p.base}/form`, { method: "POST", body: "q=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
      assert.equal(await res.text(), "GET");
    } finally {
      await p.close();
    }
  });
});

describe("request cancellation over plain HTTP", () => {
  it("does not send a request cancelled while it is waiting for the host gate", { timeout: 4_000 }, async () => {
    const p = await fakePortal({ "/open": (_req, res) => res.end("ok") });
    try {
      const job = new AbortController();
      const httpc = politeHttp(job.signal);
      await robotsAllows(`${p.base}/open`, job.signal); // reserves the first host slot
      const request = new AbortController();
      const pending = httpc.fetch(`${p.base}/open`, { signal: request.signal });
      request.abort(new Error("request cancelled"));
      await assert.rejects(pending, /request cancelled/);
      assert.deepEqual(p.hits, ["/robots.txt"]);
      assert.equal(job.signal.aborted, false);
    } finally {
      await p.close();
    }
  });

  it("cancels an in-flight HTTP response without cancelling the job", { timeout: 5_000 }, async () => {
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    const p = await fakePortal({ "/hang": () => reached() });
    try {
      const job = new AbortController();
      const request = new AbortController();
      const pending = politeHttp(job.signal).fetch(`${p.base}/hang`, { signal: request.signal });
      await started;
      request.abort(new Error("request cancelled"));
      await assert.rejects(pending, /request cancelled/);
      assert.equal(job.signal.aborted, false);
    } finally {
      await p.close();
    }
  });
});

describe("the robots.txt request counts toward the per-host rate", () => {
  it("keeps the gap between robots.txt and the first page request", { timeout: 10_000 }, async () => {
    const at: Array<[string, number]> = [];
    const server = http.createServer((req, res) => {
      at.push([req.url ?? "", Date.now()]);
      if (req.url === "/robots.txt") return void res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow:\n");
      res.writeHead(200, { "content-type": "text/html" }).end("<p>list</p>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await (await politeHttp(new AbortController().signal).fetch(`${base}/list`)).text();
      assert.deepEqual(at.map(([u]) => u), ["/robots.txt", "/list"]);
      const gap = at[1]![1] - at[0]![1];
      assert.ok(gap >= 1000, `robots.txt and the first page were ${gap} ms apart`);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
