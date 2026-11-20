import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react(), tailwindcss()],
  build: { outDir: path.resolve(import.meta.dirname, "../dist/web"), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/portals": "http://localhost:8080",
      "/internal": "http://localhost:8080",
      "/files": "http://localhost:8080",
    },
  },
});
