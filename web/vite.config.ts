import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  // es2022: noVNC (the Mac screen) uses top-level await; it is loaded on demand, in its own chunk.
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  server: { proxy: { "/api/v1/screen/ws": { target: "ws://127.0.0.1:3094", ws: true }, "/api": "http://127.0.0.1:3094", "/svc-api": "http://127.0.0.1:3094", "/icons": "http://127.0.0.1:3094" } },
});
