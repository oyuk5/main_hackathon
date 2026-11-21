/**
 * HTTP server on port 8080: the public API (exact shapes from the brief), file bytes,
 * internal endpoints for the dashboard, and the dashboard itself at GET /. Owned by A.
 */
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { store, type PortalRow } from "./store.js";
import { orchestrator } from "./orchestrator.js";
import { filePath } from "./documents.js";
import { AddPortalBody, type PortalEntry, type Run } from "../shared/contract.js";
import { toEpoch } from "../shared/time.js";
import { dateTimeEpoch } from "./calendar.js";

function entry(p: PortalRow): PortalEntry {
  return {
    id: p.id,
    url: p.url,
    state: p.state,
    reason: p.reason,
    tenderCount: store.countTenders(p.id),
    lastSuccessAt: p.last_success_at,
  };
}

export async function buildServer(options: { demo?: boolean } = {}) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" } });
  // `curl -d '{"url":…}'` without a content-type header sends form-urlencoded: read such a body as JSON too.
  app.addContentTypeParser(["application/x-www-form-urlencoded", "text/plain"], { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, JSON.parse(String(body)));
    } catch {
      const error = new Error("Body is not valid JSON") as Error & { statusCode: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  // ---------------------------------------------------------------- public API (contract)

  app.post("/portals", async (req, reply) => {
    if (options.demo) return reply.code(403).send({ error: "Adding portals is disabled in the demo." });
    const body = AddPortalBody.safeParse(req.body);
    // zod's url() accepts any scheme (ftp:, javascript:, file:); a portal is a web address.
    if (!body.success || !/^https?:$/.test(new URL(body.data.url.trim()).protocol))
      return reply.code(400).send({ error: "Body must be { \"url\": \"https://...\" }" });
    const { id } = orchestrator.addPortal(body.data.url);
    return reply.code(201).send({ id });
  });

  app.get("/portals", async () => store.listPortals().map(entry));

  app.get<{ Params: { id: string } }>("/portals/:id", async (req, reply) => {
    const p = store.getPortal(req.params.id);
    return p ? entry(p) : reply.code(404).send({ error: "Unknown portal" });
  });

  app.delete<{ Params: { id: string } }>("/portals/:id", async (req, reply) => {
    if (!store.getPortal(req.params.id)) return reply.code(404).send({ error: "Unknown portal" });
    orchestrator.remove(req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/portals/:id/refresh", async (req, reply) => {
    if (!store.getPortal(req.params.id)) return reply.code(404).send({ error: "Unknown portal" });
    return reply.code(202).send({ runId: orchestrator.refresh(req.params.id) });
  });

  app.get<{ Params: { id: string }; Querystring: { changedSince?: string | string[] } }>("/portals/:id/tenders", async (req, reply) => {
    if (!store.getPortal(req.params.id)) return reply.code(404).send({ error: "Unknown portal" });
    const all = store.listTenders(req.params.id);
    const raw = req.query.changedSince;
    const bad = () => reply.code(400).send({ error: "changedSince must be one date-time with offset, e.g. 2026-12-09T10:00:00+01:00" });
    if (Array.isArray(raw)) return bad();
    // An unencoded "+01:00" arrives as " 01:00" in a query string. Put the plus back.
    const since = raw?.trim().replace(/ (\d{2}:\d{2})$/, "+$1");
    if (!since) return all;
    // Date.parse alone accepts "1" (year 2001) and times without offset (read as server time).
    const t = dateTimeEpoch(since);
    if (Number.isNaN(t)) return bad();
    return all.filter((x) => toEpoch(x.lastChangedAt) > t);
  });

  app.get<{ Params: { id: string } }>("/portals/:id/runs", async (req, reply) => {
    if (!store.getPortal(req.params.id)) return reply.code(404).send({ error: "Unknown portal" });
    return store.listRuns(req.params.id).map(
      (r): Run => ({ id: r.id, kind: r.kind, startedAt: r.started_at, finishedAt: r.finished_at, result: r.result }),
    );
  });

  app.get<{ Params: { sha: string } }>("/files/:sha", async (req, reply) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.sha)) return reply.code(404).send({ error: "Unknown file" });
    const p = filePath(req.params.sha);
    if (!fs.existsSync(p)) return reply.code(404).send({ error: "Unknown file" });
    reply.header("content-type", "application/octet-stream");
    return reply.send(fs.createReadStream(p));
  });

  // No authentication, as the brief specifies (API and dashboard alike).
  await app.register(async (internal) => registerInternalRoutes(internal), { prefix: "/internal" });

  const webRoot = path.resolve("dist/web");
  if (fs.existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: "/", index: ["index.html"] });
  } else {
    app.get("/", async (_req, reply) =>
      reply.type("text/html").send("<h1>Watchtower</h1><p>Dashboard not built. Run <code>npm run build:web</code>.</p>"),
    );
  }
  return app;
}

function registerInternalRoutes(app: FastifyInstance) {

  app.get("/overview", async () =>
    store.listPortals().map((p) => {
      const job = orchestrator.isBusy(p.id);
      const recipe = store.currentRecipe(p.id);
      const cost = store.ledger(p.id).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
      return {
        ...entry(p),
        openCount: store.countOpenTenders(p.id),
        busy: job ? { runId: job.runId, kind: job.kind } : null,
        recipeVersion: p.recipe_version,
        tier: recipe?.tier ?? null,
        family: recipe?.family ?? null,
        /** Two-letter country from the recipe, for the dashboard map; null when not national or unknown. */
        country: recipe?.countryCode ?? null,
        costUsd: cost,
        lastRun: store.listRuns(p.id)[0] ?? null,
        // Runs started in the last 24 hours, newest first, for the dashboard's activity strip.
        recent: store
          .listRuns(p.id)
          .filter((r) => toEpoch(r.started_at) > Date.now() - 24 * 3_600_000)
          .slice(0, 200)
          .map((r) => ({
            kind: r.kind, result: r.result, startedAt: r.started_at, finishedAt: r.finished_at,
            // What a repair did or why a read failed, for the dashboard's tickets. Passing reads need none.
            summary: r.kind === "repair" || r.result === "failed" ? r.summary.slice(0, 400) : "",
          })),
      };
    }),
  );

  app.get<{ Params: { id: string } }>("/portals/:id", async (req, reply) => {
    const p = store.getPortal(req.params.id);
    if (!p) return reply.code(404).send({ error: "Unknown portal" });
    return {
      portal: entry(p),
      runs: store.listRuns(p.id),
      events: store.listEvents(p.id),
      recipes: store.listRecipes(p.id).map((r) => ({ ...r, json: JSON.parse(r.json) })),
      baseline: store.getBaseline(p.id),
      ledger: store.ledger(p.id),
      runCosts: store.costByRun(p.id),
      busy: orchestrator.isBusy(p.id) ? { runId: orchestrator.isBusy(p.id)!.runId, kind: orchestrator.isBusy(p.id)!.kind } : null,
    };
  });

  app.get("/ledger", async () => store.ledger());

  // What happened, newest first: each run with its problem, what was done and the outcome.
  app.get<{ Querystring: { all?: string; limit?: string } }>("/log", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);
    return store.journal(limit, req.query.all === "1");
  });

}
