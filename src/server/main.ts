import { config } from "../platform/config.js";
import { buildServer } from "../platform/server.js";
import { orchestrator } from "../platform/orchestrator.js";
import { store } from "../platform/store.js";
import { seedDemo } from "../platform/seedDemo.js";
import { installCrashGuard } from "../platform/crashguard.js";

installCrashGuard();

const demo = process.env.SEED_DEMO === "1";
if (demo && store.listPortals().length === 0) {
  seedDemo();
}

const app = await buildServer({ demo });
await app.listen({ port: config.port, host: "0.0.0.0" });
if (!demo) orchestrator.start();
console.log(`Watchtower on http://localhost:${config.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
