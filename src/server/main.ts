import { config } from "../platform/config.js";
import { buildServer } from "../platform/server.js";
import { orchestrator } from "../platform/orchestrator.js";

const app = await buildServer();
await app.listen({ port: config.port, host: "0.0.0.0" });
orchestrator.start();
console.log(`Watchtower on http://localhost:${config.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
