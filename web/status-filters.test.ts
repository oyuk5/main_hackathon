import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

test("status cards filter the current dashboard tab without navigating", async (t) => {
  const server = await createServer({
    configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
  });
  t.after(() => server.close());
  await server.listen();
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const statuses = [
    ["failed", "Needs a person", "Eingriff nötig"], ["healing", "Being repaired", "Wird repariert"],
    ["integrating", "Being attached", "Wird angebunden"], ["serving", "Serving", "Liefert"],
  ] as const;
  const portals = statuses.map(([state]) => ({
    id: state, url: `https://${state}.example`, state, reason: `Status: ${state}`,
    tenderCount: 0, lastSuccessAt: null, busy: null, recipeVersion: 0, tier: null, family: null, costUsd: 0,
  }));
  const log = portals.map((p) => ({
    id: p.id, portal_id: p.id, url: p.url, kind: "repair", result: "failed", summary: p.reason,
    started_at: "2026-11-20T12:00:00+01:00", finished_at: "2026-11-20T12:01:00+01:00", cost_usd: 0, events: [],
  }));
  await page.route("**/auth/config", (route) => route.fulfill({ json: {} }));
  await page.route("**/internal/overview", (route) => route.fulfill({ json: portals }));
  await page.route("**/internal/ledger", (route) => route.fulfill({ json: [] }));
  await page.route("**/internal/log*", (route) => route.fulfill({ json: log }));

  await page.goto(`${server.resolvedUrls!.local[0]}#/issues`);
  for (const [language, labelIndex] of [["English", 1], ["Deutsch", 2]] as const) {
    await page.getByRole("button", { name: language, exact: true }).click();
    for (const tab of ["issues", "log"] as const) {
      await page.locator(`#tab-${tab}`).click();
      const panel = page.locator(`#panel-${tab}`);
      await panel.getByText("failed.example", { exact: true }).waitFor();
      for (const status of statuses) {
        const [state] = status;
        const label = status[labelIndex];
        const card = page.getByRole("button", { name: `1 ${label}`, exact: true });
        await card.click();
        await panel.getByText(`${state}.example`, { exact: true }).waitFor();
        assert.equal(new URL(page.url()).hash, `#/${tab}`);
        assert.equal(await card.getAttribute("aria-pressed"), "true");
        if (tab === "issues") await panel.getByRole("heading", { name: label, exact: true }).waitFor();
        for (const [other] of statuses) {
          if (other !== state) assert.equal(await panel.getByText(`${other}.example`, { exact: true }).count(), 0);
        }
        await card.click();
        await panel.getByText("failed.example", { exact: true }).waitFor();
        await panel.getByText("healing.example", { exact: true }).waitFor();
        assert.equal(await card.getAttribute("aria-pressed"), "false");
      }
    }
  }
});