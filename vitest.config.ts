import { defineConfig } from "vitest/config";
import path from "node:path";

// Feature 14.1 — minimal Vitest config: only what's needed to resolve the
// existing "@/*" tsconfig path alias and run pure lib/ logic under Node
// (no DOM/browser environment needed — this suite never touches React,
// the DOM, or any browser API, matching lib/generatedPosConfig.ts's own
// dependency-free design).
//
// Feature 15.2 — "server-only" aliased to a local no-op stub (see
// test/stubs/server-only.ts) for this Vitest run only. The real package
// has no Node-vs-browser distinction of its own — it only no-ops under a
// Next.js-specific build condition and otherwise always throws — so
// without this alias, any .server.ts file that imports it (including
// lib/buildJobs.server.ts, and the pre-existing lib/projects.server.ts/
// lib/orders.server.ts) cannot be loaded under plain Node/Vitest at all.
// This alias only affects this test config; it has no bearing on the real
// Next.js build, which resolves "server-only" through its own pipeline.
export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "test/stubs/server-only.ts"),
    },
  },
});
