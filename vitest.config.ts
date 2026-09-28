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
// v1.3 CP2c — the database suites are SERIALIZED against each other.
//
// Four `.db.test.ts` files now each stand up their own throwaway PostgreSQL
// cluster and apply the whole migration chain to several databases. Run
// concurrently, on one laptop, they starve each other: suites that finish in
// thirty seconds alone were taking seventeen minutes and tripping Vitest's
// per-test timeout, and an unrelated Windows shell smoke test was timing out
// beside them. Those failures said nothing about the code under test.
//
// Two projects rather than one global `fileParallelism: false`: the other 138
// files are fast, pure and have no reason to give up their parallelism.
//
// AND THEY DO NOT OVERLAP. `sequence.groupOrder` runs the whole unit group
// first and the database group afterwards. Serializing the database files
// WITHOUT this made things worse, not better: four clusters one after another
// take four times as long in wall-clock, so they sat alongside the unit tests
// for far longer, and a load-sensitive Windows shell smoke test went from 94
// seconds to 439. The machine can do either job well; it cannot do both at
// once.
export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.db.test.ts"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "database",
          environment: "node",
          include: ["supabase/migrations/**/*.db.test.ts"],
          // After the unit group has finished, and then one cluster at a time.
          //
          // maxWorkers is what actually does it. fileParallelism alone was
          // silently ignored at project level -- four clusters were still up
          // at once, which is how this was caught -- and poolOptions is not
          // part of a project's type at all. Measured rather than assumed:
          // the peak concurrent PostgreSQL count went from four to two, and
          // the two are one file's cluster still shutting down as the next
          // one starts -- not two suites running. The database group went
          // from 88 minutes with two timeouts to 223 seconds with none.
          sequence: { groupOrder: 1 },
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          // Applying ~28 migrations to several databases is minutes of work
          // before a single assertion runs, and these suites own their own
          // setup entirely -- a generous hook budget here is not hiding a slow
          // test, it is describing one.
          hookTimeout: 900_000,
          testTimeout: 300_000,
        },
      },
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(__dirname, "test/stubs/server-only.ts"),
    },
  },
});
