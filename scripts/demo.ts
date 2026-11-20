/**
 * Demo data for the dashboard, served without the worker. Owned by A.
 *
 *   DATA_DIR=data/demo npx tsx scripts/demo.ts        # seeds once, then serves on :8080
 */
import fs from "node:fs";
import path from "node:path";

process.env.DATA_DIR ??= "data/demo";
const fresh = !fs.existsSync(path.join(process.env.DATA_DIR, "watchtower.db"));
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const { buildServer } = await import("../src/platform/server.js");
const { config } = await import("../src/platform/config.js");
const { seedDemo } = await import("../src/platform/seedDemo.js");

if (fresh) {
  seedDemo();
  console.log(`Seeded demo data in ${process.env.DATA_DIR}.`);
}
const app = await buildServer();
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`Demo dashboard on http://localhost:${config.port} (worker off; delete ${process.env.DATA_DIR} to reseed).`);
