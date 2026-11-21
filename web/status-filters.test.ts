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
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString().replace("Z", "+00:00");
  const statuses = [
    ["failed", "Needs a person", "Eingriff nötig"], ["healing", "Being repaired", "Wird repariert"],
    ["integrating", "Being attached", "Wird angebunden"], ["serving", "Serving", "Liefert"],
  ] as const;
  const portals = statuses.map(([state]) => ({
    id: state, url: `https://${state}.example`, state, reason: `Status: ${state}`,
    tenderCount: 0, openCount: 0, lastSuccessAt: null, busy: null, recipeVersion: 0, tier: null, family: null, costUsd: 0,
    recent: state === "serving" ? [{ kind: "repair", result: "ok", startedAt: ago(30), finishedAt: ago(29), summary: "Recent recovery" }]
      : state === "failed" ? [{ kind: "read", result: "failed", startedAt: ago(10), finishedAt: ago(9), summary: "Failed read" }] : [],
  }));
  const log = portals.map((p) => ({
    id: `run-${p.id}`, portal_id: p.id, url: p.url, kind: "repair", result: "failed", summary: p.reason,
    started_at: ago(10), finished_at: ago(9), cost_usd: 0, events: [{ at: ago(9), level: "warn", message: `Detail for ${p.id}` }],
  }));
  log.push({ ...log[0]!, id: "failed-repeat", started_at: ago(15), finished_at: ago(14), events: [{ at: ago(14), level: "info", message: "Earlier attempt details" }] });
  await page.route("**/internal/overview", (route) => route.fulfill({ json: portals }));
  await page.route("**/internal/ledger", (route) => route.fulfill({ json: [] }));
  await page.route("**/internal/log*", (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.has("all")
    ? [...log, { ...log[0]!, id: "passed-read", kind: "read", result: "ok", summary: "Routine success", events: [] }]
    : log }));

  await page.goto(`${server.resolvedUrls!.local[0]}#/issues`);
  for (const [language, labelIndex] of [["English", 1], ["Deutsch", 2]] as const) {
    await page.getByRole("button", { name: language, exact: true }).click();
    assert.match(await page.locator("#tab-issues").innerText(), /\b2$/);
    await page.getByText(language === "English" ? /Last 24 hours: 1 read \(1 failed\)/ : /Letzte 24 Stunden: 1 Abruf \(1 fehlgeschlagen\)/).waitFor();
    for (const tab of ["issues", "log"] as const) {
      await page.locator(`#tab-${tab}`).click();
      const panel = page.locator(`#panel-${tab}`);
      await panel.getByText("failed.example", { exact: true }).first().waitFor();
      if (tab === "log") {
        const failedRuns = panel.getByRole("button", { name: language === "English" ? "Failed runs (5)" : "Fehlgeschlagene Läufe (5)", exact: true });
        const count = (n: number) => panel.getByRole("heading", { name: `${n} ${language === "English" ? n === 1 ? "run" : "runs" : n === 1 ? "Lauf" : "Läufe"}`, exact: true });
        const counter = count(5);
        await failedRuns.waitFor();
        await counter.waitFor();
        const headerLabels = language === "English" ? ["Time", "Portal", "Outcome", "Took", "Model cost"] : ["Zeit", "Portal", "Ergebnis", "Dauer", "Kosten"];
        for (const label of headerLabels) {
          const button = panel.getByRole("button", { name: label, exact: true });
          for (let i = 0; i < 2; i++) {
            await button.click();
            await counter.waitFor();
            assert.equal(await panel.locator("ol > li > button").count(), 5);
          }
        }
        const search = panel.getByRole("searchbox");
        await search.fill("failed.example");
        await count(2).waitFor();
        await panel.getByRole("button", { name: /failed\.example/ }).last().click();
        await panel.getByText("Earlier attempt details", { exact: true }).waitFor();
        await search.fill("no-such-portal");
        await count(0).waitFor();
        await search.clear();
        const passing = panel.getByRole("switch");
        await passing.click();
        await count(6).waitFor();
        const repairs = panel.getByRole("button", { name: language === "English" ? "Repairs" : "Reparaturen", exact: true });
        await repairs.click();
        await count(5).waitFor();
        await failedRuns.click();
        await count(5).waitFor();
        await panel.getByRole("button", { name: language === "English" ? "Everything" : "Alles", exact: true }).click();
        await passing.click();
        await counter.waitFor();
        await page.setViewportSize({ width: 375, height: 850 });
        const sortMenu = panel.locator('button[aria-haspopup="listbox"]');
        for (const [index, first] of [[2, "failed.example"], [3, "serving.example"]] as const) {
          await sortMenu.click();
          await panel.getByRole("option").nth(index).click();
          await counter.waitFor();
          assert.match(await panel.getByRole("heading", { level: 3 }).first().innerText(), new RegExp(`^${first.replace(".", "\\.")}`));
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.setViewportSize({ width: 1280, height: 900 });
      } else {
        await panel.getByText("Recent recovery").waitFor();
        assert.equal(await panel.getByRole("heading").count(), 4);
      }
      for (const status of statuses) {
        const [state] = status;
        const label = status[labelIndex];
        const card = page.getByRole("button", { name: `1 ${label}`, exact: true });
        await card.click();
        await panel.getByText(`${state}.example`, { exact: true }).first().waitFor();
        assert.equal(new URL(page.url()).hash, `#/${tab}`);
        assert.equal(await card.getAttribute("aria-pressed"), "true");
        if (tab === "issues") {
          await panel.getByRole("heading", { name: label, exact: true }).waitFor();
          assert.equal(await panel.getByRole("heading").count(), 1);
          assert.equal(await panel.getByText("Recent recovery").count(), 0);
        }
        for (const [other] of statuses) {
          if (other !== state) assert.equal(await panel.getByText(`${other}.example`, { exact: true }).count(), 0);
        }
        await card.click();
        await panel.getByText("failed.example", { exact: true }).first().waitFor();
        await panel.getByText("healing.example", { exact: true }).waitFor();
        assert.equal(await card.getAttribute("aria-pressed"), "false");
      }
    }
  }
  assert.deepEqual(errors, []);
});