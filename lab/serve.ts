/**
 * Lab server (person D): the private demo portals, on their own port (default 4100).
 *   npm run lab                      → http://localhost:4100
 *   LAB_PORT=4200 npm run lab        → another port
 *   LAB_TODAY=2026-11-20 npm run lab → fixed dates, for repeatable evals
 *
 * Portals:      /stadtwerke/  /ville/  /gmina/
 * Ground truth: /_truth/<slug>.json (robots.txt disallows it, and nothing links to it)
 * Lab control:  GET /_lab/state (variants, request counts, fastest request rate seen per portal)
 *               POST /_lab/variant?portal=<slug>&v=<variant> (used by the mutator)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { notFound, page, sendHtml, sendJson, truthOf, type LabPortal } from "./portals/common.js";
import { gmina } from "./portals/gmina.js";
import { stadtwerke } from "./portals/stadtwerke.js";
import { ville } from "./portals/ville.js";

export const portals: LabPortal[] = [stadtwerke, ville, gmina];

interface Traffic {
  requests: number;
  /** Most requests seen inside any one-second window: the brief allows 1. */
  maxPerSecond: number;
  recent: number[];
}

export interface Lab {
  server: Server;
  variants: Map<string, string>;
  traffic: Map<string, Traffic>;
}

const ROBOTS = "User-agent: *\nDisallow: /_truth/\nDisallow: /_lab/\n";

function baseOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? "localhost"}`;
}

function count(lab: Lab, slug: string): void {
  const t = lab.traffic.get(slug) ?? { requests: 0, maxPerSecond: 0, recent: [] };
  const now = Date.now();
  t.requests++;
  t.recent = [...t.recent.filter((x) => now - x < 1000), now];
  t.maxPerSecond = Math.max(t.maxPerSecond, t.recent.length);
  lab.traffic.set(slug, t);
}

function route(lab: Lab, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://lab");
  const path = decodeURIComponent(url.pathname);
  const base = baseOf(req);

  if (path === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(ROBOTS);
    return;
  }
  if (path === "/") {
    const items = portals.map((p) => `<li><a href="/${p.slug}/">${p.name}</a> (${p.country}): ${p.kind}</li>`).join("");
    return sendHtml(res, page("Watchtower lab", "en", `<h1>Watchtower lab portals</h1><ul>${items}</ul>`));
  }
  const truth = path.match(/^\/_truth\/([a-z]+)\.json$/);
  if (truth) {
    const p = portals.find((x) => x.slug === truth[1]);
    return p ? sendJson(res, truthOf(p, base, lab.variants.get(p.slug) ?? "v1")) : notFound(res);
  }
  if (path === "/_lab/state") {
    return sendJson(res, {
      portals: portals.map((p) => ({
        slug: p.slug,
        url: `${base}/${p.slug}/`,
        variant: lab.variants.get(p.slug) ?? "v1",
        variants: { v1: "The original portal.", ...p.variants },
        requests: lab.traffic.get(p.slug)?.requests ?? 0,
        maxPerSecond: lab.traffic.get(p.slug)?.maxPerSecond ?? 0,
      })),
    });
  }
  if (path === "/_lab/variant" && req.method === "POST") {
    const slug = url.searchParams.get("portal") ?? "";
    const v = url.searchParams.get("v") ?? "v1";
    const p = portals.find((x) => x.slug === slug);
    if (!p) return sendJson(res, { error: `unknown portal ${slug}` }, 404);
    if (v !== "v1" && !(v in p.variants)) return sendJson(res, { error: `unknown variant ${v}`, variants: ["v1", ...Object.keys(p.variants)] }, 400);
    lab.variants.set(slug, v);
    return sendJson(res, { portal: slug, variant: v, change: v === "v1" ? "The original portal." : p.variants[v] });
  }

  const slug = path.split("/")[1] ?? "";
  const p = portals.find((x) => x.slug === slug);
  if (!p) return notFound(res);
  if (path === `/${slug}`) {
    res.writeHead(301, { location: `/${slug}/` });
    res.end();
    return;
  }
  count(lab, slug);
  p.handle(req, res, path.slice(slug.length + 1), url, { base, variant: lab.variants.get(slug) ?? "v1" });
}

export function createLab(): Lab {
  const lab: Lab = { server: undefined as unknown as Server, variants: new Map(), traffic: new Map() };
  lab.server = createServer((req, res) => {
    try {
      route(lab, req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  return lab;
}

const self = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();
if ((process.argv[1] ?? "").replace(/\\/g, "/").toLowerCase() === self) {
  const port = Number(process.env.LAB_PORT ?? 4100);
  const host = process.env.LAB_HOST ?? "0.0.0.0";
  createLab().server.listen(port, host, () => {
    console.log(`Watchtower lab on http://localhost:${port}`);
    for (const p of portals) console.log(`  ${p.name.padEnd(20)} http://localhost:${port}/${p.slug}/   truth: /_truth/${p.slug}.json`);
    console.log("  From the Docker container use http://host.docker.internal:" + port + "/<portal>/");
  });
}
