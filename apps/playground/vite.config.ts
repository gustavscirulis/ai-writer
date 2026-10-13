import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Stands in for the app's `writer-embed://` scheme so HTML embeds run here
// too. It serves the same page but without its CSP, so check embed isolation
// in the desktop app (`e2e/specs/embed.spec.js`), not here.
const embedFrame: Plugin = {
  name: "writer-embed-frame",
  configureServer(server) {
    const page = new URL("../desktop/src-tauri/src/embed-frame.html", import.meta.url);
    server.middlewares.use("/embed-frame.html", (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(readFileSync(page));
    });
  },
};

// The playground mounts the desktop app's editor core straight from its
// source tree, so the `@` alias points at the desktop `src` directory just as
// it does in `apps/desktop/vite.config.ts`.
export default defineConfig({
  plugins: [react(), embedFrame],
  resolve: {
    alias: {
      "@": new URL("../desktop/src", import.meta.url).pathname,
      "@shared": new URL("../desktop/shared", import.meta.url).pathname,
    },
  },
  server: { port: 1430, strictPort: true },
});
