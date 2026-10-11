import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// In development Vite serves the app and forwards /api to the Hono server (npm run dev starts both).
// PORT, when a tool sets it, is for this page server; the API keeps API_PORT (scripts/dev-api.ts).
export default defineConfig({
  plugins: [react()],
  // Parley's version, for Settings › About.
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? JSON.parse(readFileSync("package.json", "utf8")).version) },
  server: {
    port: Number(process.env.PORT ?? 5173),
    proxy: {
      "/api": { target: `http://localhost:${process.env.API_PORT ?? 8787}` },
      "/manifest.webmanifest": { target: `http://localhost:${process.env.API_PORT ?? 8787}` },
    },
  },
});
