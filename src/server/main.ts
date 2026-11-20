import { config } from "../platform/config.js";
import { buildServer } from "../platform/server.js";
import { orchestrator } from "../platform/orchestrator.js";
import { store } from "../platform/store.js";
import { seedDemo } from "../platform/seedDemo.js";

if (process.env.SEED_DEMO === "1" && store.listPortals().length === 0) {
  seedDemo();
}

const app = await buildServer();
await app.listen({ port: config.port, host: "0.0.0.0" });
orchestrator.start();
console.log(`Watchtower on http://localhost:${config.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
