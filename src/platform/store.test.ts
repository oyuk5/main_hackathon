import assert from "node:assert/strict";
import { after, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { removeTemp } from "./testkit.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-ledger-"));
process.env.DATA_DIR = dir;
after(() => removeTemp(dir));

it("migrates old model usage and reports cached input only when nonzero", async () => {
  const legacy = new DatabaseSync(path.join(dir, "watchtower.db"));
  legacy.exec(`CREATE TABLE llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, portal_id TEXT, run_id TEXT, purpose TEXT NOT NULL,
    model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd REAL NOT NULL, at TEXT NOT NULL
  ); INSERT INTO llm_calls (purpose, model, input_tokens, output_tokens, cost_usd, at)
    VALUES ('attach', 'test', 100, 4, 1, '2026-11-20T10:00:00+01:00');`);
  legacy.close();
  const { store } = await import("./store.js");
  assert.deepEqual(store.ledger(), [{ purpose: "attach", calls: 1, input_tokens: 100, output_tokens: 4, cost_usd: 1 }]);
  store.addLlmCall({ portalId: null, runId: null, purpose: "attach", model: "test", inputTokens: 100, cachedTokens: 75, outputTokens: 6, costUsd: 1, at: "2026-11-20T10:01:00+01:00" });
  assert.deepEqual(store.ledger(), [{ purpose: "attach", calls: 2, input_tokens: 200, output_tokens: 10, cost_usd: 2, cached_tokens: 75 }]);
});