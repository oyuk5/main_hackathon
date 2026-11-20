/**
 * HTTP server on port 8080: the public API (exact shapes from the brief), file bytes,
 * internal endpoints for the dashboard, and the dashboard itself at GET /. Owned by A.
 */
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { store, type PortalRow } from "./store.js";
import { orchestrator } from "./orchestrator.js";
import { filePath } from "./documents.js";
import { AddPortalBody, type PortalEntry, type Run } from "../shared/contract.js";
import { toEpoch } from "../shared/time.js";

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

export async function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" } });

  // ---------------------------------------------------------------- public API (contract)

  app.post("/portals", async (req, reply) => {
    const body = AddPortalBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Body must be { \"url\": \"https://...\" }" });
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

  app.get<{ Params: { id: string }; Querystring: { changedSince?: string } }>("/portals/:id/tenders", async (req, reply) => {
    if (!store.getPortal(req.params.id)) return reply.code(404).send({ error: "Unknown portal" });
    const all = store.listTenders(req.params.id);
    // An unencoded "+01:00" arrives as " 01:00" in a query string. Put the plus back.
    const since = req.query.changedSince?.trim().replace(/ (\d{2}:\d{2})$/, "+$1");
    if (!since) return all;
    const t = toEpoch(since);
    if (Number.isNaN(t)) return reply.code(400).send({ error: "changedSince must be a date-time with offset" });
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

  // ---------------------------------------------------------------- internal (dashboard only)

  app.get("/internal/overview", async () =>
    store.listPortals().map((p) => {
      const job = orchestrator.isBusy(p.id);
      const recipe = store.currentRecipe(p.id);
      const cost = store.ledger(p.id).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
      return {
        ...entry(p),
        busy: job ? { runId: job.runId, kind: job.kind } : null,
        recipeVersion: p.recipe_version,
        tier: recipe?.tier ?? null,
        family: recipe?.family ?? null,
        costUsd: cost,
        lastRun: store.listRuns(p.id)[0] ?? null,
      };
    }),
  );

  app.get<{ Params: { id: string } }>("/internal/portals/:id", async (req, reply) => {
    const p = store.getPortal(req.params.id);
    if (!p) return reply.code(404).send({ error: "Unknown portal" });
    return {
      portal: entry(p),
      runs: store.listRuns(p.id),
      events: store.listEvents(p.id),
      recipes: store.listRecipes(p.id).map((r) => ({ ...r, json: JSON.parse(r.json) })),
      baseline: store.getBaseline(p.id),
      ledger: store.ledger(p.id),
    };
  });

  app.get("/internal/ledger", async () => store.ledger());

  // ---------------------------------------------------------------- dashboard at GET /

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
