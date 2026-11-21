/** A portal whose scripts or data robots.txt forbids (e.g. boamp.fr: /static/ and /api/) ends blocked, with robots.txt named. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { attachWithModel, look } from "./cartographer.js";
import type { PortalContext } from "../shared/modules.js";

let server: http.Server;
let base = "";
before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<!doctype html><html><body><div id="app"></div><script src="/static/app.js"></script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** A fake browser page that reports the app script as refused by robots.txt, like the polite browser does. */
function robotsBrowser(): PortalContext["browser"] {
  const page = {
    handlers: [] as Array<(r: unknown) => void>,
    on(ev: string, h: (r: unknown) => void) {
      if (ev === "requestfailed") this.handlers.push(h);
    },
    async goto() {
      for (const h of this.handlers)
        h({ url: () => `${base}/static/app.js`, resourceType: () => "script", failure: () => ({ errorText: "net::ERR_BLOCKED_BY_CLIENT" }) });
    },
    async waitForLoadState() {},
    async content() {
      return '<!doctype html><html><body><div id="app"></div></body></html>';
    },
  };
  return { withPage: (fn) => fn(page as never) };
}

function ctx(answer: string): PortalContext & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    portalId: "pr",
    url: `${base}/`,
    http: { fetch: (u, init) => fetch(u, init) },
    browser: robotsBrowser(),
    llm: {
      async json(opts) {
        prompts.push(opts.user);
        return opts.schema.parse({ action: "give_up", navigateTo: null, reason: answer, recipe: null }) as never;
      },
    },
    log: () => {},
    signal: new AbortController().signal,
    prompts,
  };
}

test("look records paths the browser refused because of robots.txt", async () => {
  const l = await look(ctx("x"), `${base}/`);
  assert.deepEqual(l.robotsBlocked, [`${new URL(base).host}/static/`]);
});

test("the model is told, and a portal it cannot read for that reason ends blocked with robots.txt named", async () => {
  const c = ctx("The page shows no tenders; its scripts did not load.");
  const out = await attachWithModel(c);
  assert.match(c.prompts[0]!, /robots\.txt forbids these paths/);
  assert.equal(out.kind, "blocked");
  assert.match((out as { reason: string }).reason, /^robots\.txt forbids \/static\/, which this portal needs to show its tender list/);
});
