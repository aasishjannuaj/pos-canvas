import { defineConfig } from "vitest/config";
import path from "node:path";

// Feature 14.1 — minimal Vitest config: only what's needed to resolve the
// existing "@/*" tsconfig path alias and run pure lib/ logic under Node
// (no DOM/browser environment needed — this suite never touches React,
// the DOM, or any browser API, matching lib/generatedPosConfig.ts's own
// dependency-free design).
export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
