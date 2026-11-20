/**
 * Persistence on SQLite (node:sqlite, built into Node 22.13+). One file in DATA_DIR.
 * Owned by A. Keep SQL here; other modules call these functions.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { PortalState, Tender } from "../shared/contract.js";
import type { Baseline, GoldenRecord } from "../shared/modules.js";
import type { Recipe } from "../shared/recipe.js";

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, "watchtower.db"));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS portals (
  id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, state TEXT NOT NULL, reason TEXT NOT NULL,
  last_success_at TEXT, created_at TEXT NOT NULL, next_due_at INTEGER NOT NULL DEFAULT 0,
  baseline_json TEXT, recipe_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recipes (
  portal_id TEXT NOT NULL, version INTEGER NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL,
  origin TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', PRIMARY KEY (portal_id, version)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, portal_id TEXT NOT NULL, kind TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, result TEXT, summary TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, portal_id TEXT NOT NULL, run_id TEXT, at TEXT NOT NULL,
  level TEXT NOT NULL, message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenders (
  portal_id TEXT NOT NULL, tender_id TEXT NOT NULL, json TEXT NOT NULL, content_hash TEXT NOT NULL,
  refs_hash TEXT NOT NULL DEFAULT '', last_changed_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (portal_id, tender_id)
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, portal_id TEXT, run_id TEXT, purpose TEXT NOT NULL,
  model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL, at TEXT NOT NULL, cached_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_portal ON runs (portal_id, seq);
CREATE INDEX IF NOT EXISTS events_portal ON events (portal_id, id);
`);

// Older databases keep all usage rows; calls recorded before this migration have no cache count.
if (!db.prepare("PRAGMA table_info(llm_calls)").all().some((column) => column.name === "cached_tokens")) {
  db.exec("ALTER TABLE llm_calls ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0");
}

let seq = Number((db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM runs").get() as { s: number }).s);

export interface PortalRow {
  id: string;
  url: string;
  state: PortalState;
  reason: string;
  last_success_at: string | null;
  created_at: string;
  next_due_at: number;
  baseline_json: string | null;
  recipe_version: number;
}

export const store = {
  // ---------------------------------------------------------------- portals
  getPortal(id: string): PortalRow | undefined {
    return db.prepare("SELECT * FROM portals WHERE id = ?").get(id) as PortalRow | undefined;
  },
  getPortalByUrl(url: string): PortalRow | undefined {
    return db.prepare("SELECT * FROM portals WHERE url = ?").get(url) as PortalRow | undefined;
  },
  listPortals(): PortalRow[] {
    return db.prepare("SELECT * FROM portals ORDER BY created_at").all() as unknown as PortalRow[];
  },
  insertPortal(p: { id: string; url: string; state: PortalState; reason: string; createdAt: string }) {
    db.prepare("INSERT INTO portals (id, url, state, reason, created_at) VALUES (?, ?, ?, ?, ?)").run(
      p.id, p.url, p.state, p.reason, p.createdAt,
    );
  },
  setState(id: string, state: PortalState, reason: string, lastSuccessAt?: string) {
    if (lastSuccessAt) {
      db.prepare("UPDATE portals SET state = ?, reason = ?, last_success_at = ? WHERE id = ?").run(state, reason, lastSuccessAt, id);
    } else {
      db.prepare("UPDATE portals SET state = ?, reason = ? WHERE id = ?").run(state, reason, id);
    }
  },
  setNextDue(id: string, epochMs: number) {
    db.prepare("UPDATE portals SET next_due_at = ? WHERE id = ?").run(epochMs, id);
  },
  getBaseline(id: string): Baseline {
    const row = this.getPortal(id);
    return row?.baseline_json
      ? (JSON.parse(row.baseline_json) as Baseline)
      : { lastGoodCount: null, lastGoodFieldFill: null, lastGoodSkeletonHash: null, golden: [] };
  },
  setBaseline(id: string, b: Baseline) {
    db.prepare("UPDATE portals SET baseline_json = ? WHERE id = ?").run(JSON.stringify(b), id);
  },
  deletePortal(id: string) {
    for (const t of ["recipes", "runs", "events", "tenders"]) db.prepare(`DELETE FROM ${t} WHERE portal_id = ?`).run(id);
    db.prepare("DELETE FROM portals WHERE id = ?").run(id);
  },

  // ---------------------------------------------------------------- recipes
  saveRecipe(portalId: string, recipe: Recipe, origin: "attach" | "repair" | "family", note: string, at: string): number {
    const row = this.getPortal(portalId);
    const version = (row?.recipe_version ?? 0) + 1;
    db.prepare("INSERT INTO recipes (portal_id, version, json, created_at, origin, note) VALUES (?, ?, ?, ?, ?, ?)").run(
      portalId, version, JSON.stringify(recipe), at, origin, note,
    );
    db.prepare("UPDATE portals SET recipe_version = ? WHERE id = ?").run(version, portalId);
    return version;
  },
  currentRecipe(portalId: string): Recipe | null {
    const r = db
      .prepare("SELECT json FROM recipes WHERE portal_id = ? ORDER BY version DESC LIMIT 1")
      .get(portalId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Recipe) : null;
  },
  listRecipes(portalId: string) {
    return db
      .prepare("SELECT version, created_at, origin, note, json FROM recipes WHERE portal_id = ? ORDER BY version")
      .all(portalId) as unknown as { version: number; created_at: string; origin: string; note: string; json: string }[];
  },
  setGolden(portalId: string, golden: GoldenRecord[]) {
    this.setBaseline(portalId, { ...this.getBaseline(portalId), golden });
  },

  // ---------------------------------------------------------------- runs + events
  insertRun(r: { id: string; portalId: string; kind: "read" | "repair"; startedAt: string }) {
    seq += 1;
    db.prepare("INSERT INTO runs (id, portal_id, kind, started_at, seq) VALUES (?, ?, ?, ?, ?)").run(r.id, r.portalId, r.kind, r.startedAt, seq);
  },
  finishRun(id: string, result: "ok" | "failed", finishedAt: string, summary: string) {
    db.prepare("UPDATE runs SET result = ?, finished_at = ?, summary = ? WHERE id = ?").run(result, finishedAt, summary, id);
  },
  listRuns(portalId: string) {
    return db
      .prepare("SELECT id, kind, started_at, finished_at, result, summary FROM runs WHERE portal_id = ? ORDER BY seq DESC")
      .all(portalId) as unknown as {
      id: string; kind: "read" | "repair"; started_at: string; finished_at: string | null; result: "ok" | "failed" | null; summary: string;
    }[];
  },
  /** On startup: runs that were still going when the process stopped. */
  failInterruptedRuns(at: string) {
    db.prepare("UPDATE runs SET result = 'failed', finished_at = ?, summary = 'Interrupted by a restart.' WHERE result IS NULL").run(at);
  },
  /**
   * Runs across all portals, newest first, for the dashboard's log. `everything` false leaves out
   * reads that passed, which are most runs and say nothing new.
   */
  journal(limit: number, everything: boolean) {
    const runs = db
      .prepare(
        `SELECT r.id, r.portal_id, p.url, r.kind, r.started_at, r.finished_at, r.result, r.summary,
                (SELECT COALESCE(SUM(c.cost_usd), 0) FROM llm_calls c WHERE c.run_id = r.id) AS cost_usd
         FROM runs r JOIN portals p ON p.id = r.portal_id
         ${everything ? "" : "WHERE NOT (r.kind = 'read' AND r.result = 'ok')"}
         ORDER BY r.seq DESC LIMIT ?`,
      )
      .all(limit) as unknown as {
      id: string; portal_id: string; url: string; kind: "read" | "repair"; started_at: string; finished_at: string | null;
      result: "ok" | "failed" | null; summary: string; cost_usd: number;
    }[];
    const events = db.prepare("SELECT at, level, message FROM events WHERE run_id = ? ORDER BY id LIMIT 50");
    return runs.map((r) => ({ ...r, events: events.all(r.id) as unknown as { at: string; level: string; message: string }[] }));
  },
  addEvent(portalId: string, runId: string | null, at: string, level: string, message: string) {
    db.prepare("INSERT INTO events (portal_id, run_id, at, level, message) VALUES (?, ?, ?, ?, ?)").run(portalId, runId, at, level, message);
  },
  listEvents(portalId: string, limit = 200) {
    return db
      .prepare("SELECT run_id, at, level, message FROM events WHERE portal_id = ? ORDER BY id DESC LIMIT ?")
      .all(portalId, limit) as unknown as { run_id: string | null; at: string; level: string; message: string }[];
  },

  // ---------------------------------------------------------------- tenders
  getTenderRow(portalId: string, tenderId: string) {
    return db.prepare("SELECT * FROM tenders WHERE portal_id = ? AND tender_id = ?").get(portalId, tenderId) as
      | { json: string; content_hash: string; refs_hash: string; last_changed_at: string }
      | undefined;
  },
  upsertTender(portalId: string, t: Tender, contentHash: string, refsHash: string, seenAt: string) {
    db.prepare(
      `INSERT INTO tenders (portal_id, tender_id, json, content_hash, refs_hash, last_changed_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (portal_id, tender_id) DO UPDATE SET json = excluded.json, content_hash = excluded.content_hash,
         refs_hash = excluded.refs_hash, last_changed_at = excluded.last_changed_at, last_seen_at = excluded.last_seen_at`,
    ).run(portalId, t.id, JSON.stringify(t), contentHash, refsHash, t.lastChangedAt, seenAt);
  },
  listTenders(portalId: string): Tender[] {
    return (db.prepare("SELECT json FROM tenders WHERE portal_id = ? ORDER BY tender_id").all(portalId) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as Tender,
    );
  },
  countTenders(portalId: string): number {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM tenders WHERE portal_id = ?").get(portalId) as { n: number }).n);
  },

  // ---------------------------------------------------------------- ledger
  addLlmCall(c: { portalId: string | null; runId: string | null; purpose: string; model: string; inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd: number; at: string }) {
    db.prepare(
      "INSERT INTO llm_calls (portal_id, run_id, purpose, model, input_tokens, output_tokens, cost_usd, at, cached_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(c.portalId, c.runId, c.purpose, c.model, c.inputTokens, c.outputTokens, c.costUsd, c.at, c.cachedTokens ?? 0);
  },
  /** Model cost per run of one portal, for the dashboard's run history. */
  costByRun(portalId: string): Record<string, number> {
    const rows = db
      .prepare("SELECT run_id, SUM(cost_usd) AS cost FROM llm_calls WHERE portal_id = ? AND run_id IS NOT NULL GROUP BY run_id")
      .all(portalId) as unknown as { run_id: string; cost: number }[];
    return Object.fromEntries(rows.map((r) => [r.run_id, r.cost]));
  },
  ledger(portalId?: string) {
    const where = portalId ? "WHERE portal_id = ?" : "";
    const args = portalId ? [portalId] : [];
    const rows = db
      .prepare(`SELECT purpose, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_usd) AS cost_usd, SUM(cached_tokens) AS cached_tokens FROM llm_calls ${where} GROUP BY purpose`)
      .all(...args) as unknown as { purpose: string; calls: number; input_tokens: number; output_tokens: number; cost_usd: number; cached_tokens: number }[];
    return rows.map(({ cached_tokens, ...row }) => cached_tokens > 0 ? { ...row, cached_tokens } : row);
  },
};
