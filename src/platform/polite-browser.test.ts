/** One portal's Chromium crash must not fail the other portals' pages. Uses a fake Chromium. */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { politeBrowser, setBrowserLaunchForTests } from "./polite.js";

interface Fake {
  browser: Browser;
  crash: () => void;
}

function fakeBrowser(): Fake {
  let connected = true;
  const onDisconnect: Array<() => void> = [];
  const contexts: Array<{ fail: (e: Error) => void }> = [];
  const browser = {
    isConnected: () => connected,
    on(event: string, cb: () => void) {
      if (event === "disconnected") onDisconnect.push(cb);
      return browser;
    },
    async newContext() {
      if (!connected) throw new Error("Target page, context or browser has been closed");
      let fail: (e: Error) => void = () => {};
      const dead = new Promise<never>((_r, reject) => (fail = reject));
      dead.catch(() => {});
      contexts.push({ fail });
      return {
        route: async () => {},
        close: async () => {},
        newPage: async () => ({ on: () => {}, dead }),
      };
    },
    close: async () => {},
  } as unknown as Browser;
  return {
    browser,
    crash() {
      connected = false;
      for (const c of contexts) c.fail(new Error("Target page, context or browser has been closed"));
      for (const cb of onDisconnect) cb();
    },
  };
}

afterEach(() => setBrowserLaunchForTests(null));

test("a Chromium crash during one portal's page relaunches the browser and retries the other portal's page", async () => {
  const launched: Fake[] = [];
  setBrowserLaunchForTests(async () => {
    const f = fakeBrowser();
    launched.push(f);
    return f.browser;
  });
  let runs = 0;
  const other = politeBrowser(new AbortController().signal).withPage(async (page) => {
    runs += 1;
    if (runs === 1) await (page as unknown as { dead: Promise<never> }).dead; // dies with the browser
    return "other portal read";
  });
  let crasherRuns = 0;
  const crasher = politeBrowser(new AbortController().signal).withPage(async (page) => {
    crasherRuns += 1;
    if (crasherRuns > 1) return "crasher read";
    launched[0]!.crash();
    await (page as unknown as { dead: Promise<never> }).dead;
  });
  // Both pages died with the browser; each gets one retry on the new Chromium.
  assert.equal(await crasher, "crasher read");
  assert.equal(await other, "other portal read");
  assert.equal(runs, 2);
  assert.equal(crasherRuns, 2);
  assert.equal(launched.length, 2, "a fresh Chromium was launched once");

  // Later pages use the new browser, not the dead one.
  assert.equal(await politeBrowser(new AbortController().signal).withPage(async () => "later"), "later");
  assert.equal(launched.length, 2);
});

test("a portal's own error is not retried while the browser is up", async () => {
  setBrowserLaunchForTests(async () => fakeBrowser().browser);
  let runs = 0;
  await assert.rejects(
    politeBrowser(new AbortController().signal).withPage(async () => {
      runs += 1;
      throw new Error("selector not found");
    }),
    /selector not found/,
  );
  assert.equal(runs, 1);
});
