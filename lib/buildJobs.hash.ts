// Feature 15.5 — computeGeneratedPosConfigHash extracted out of
// lib/buildJobs.server.ts into its own neutral module, deliberately with
// no "server-only" import. lib/buildJobs.server.ts begins with
// `import "server-only"`, so importing anything from it — even a single
// named export — runs that side-effecting import too, which throws
// unconditionally outside Next.js's "react-server" bundling condition
// (see node_modules/server-only/index.js). worker/once.ts needs this exact
// hash function to verify a claimed job's config_snapshot integrity
// (Feature 15.5's snapshot-validation requirement), but runs as a plain
// Node process via `tsx`, never through Next's bundler — so it cannot
// import lib/buildJobs.server.ts at all.
//
// node:crypto itself is not the problem — it works fine in both a Next.js
// server context and a plain Node worker process; only the "server-only"
// package's own unconditional throw is. lib/buildJobs.server.ts now
// re-exports this function unchanged, so its own existing callers/tests
// (lib/buildJobs.server.test.ts) see no behavior or import-path change.
import { createHash } from "node:crypto";
import { canonicalizeGeneratedPosConfig } from "@/lib/buildJobs";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";

export function computeGeneratedPosConfigHash(config: GeneratedPosConfig): string {
  const canonical = canonicalizeGeneratedPosConfig(config);
  return createHash("sha256").update(canonical).digest("hex");
}
