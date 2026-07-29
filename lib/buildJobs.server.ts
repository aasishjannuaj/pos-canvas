import "server-only";
import { createHash } from "node:crypto";
import type { GeneratedPosConfig } from "@/lib/generatedPosConfig";
import { canonicalizeGeneratedPosConfig } from "@/lib/buildJobs";

// Feature 15.2 — the one place node:crypto is used in this domain. Kept in
// its own server-only module (the "server-only" import enforces this at
// build time — Next.js fails the build if this file is ever pulled into a
// client bundle, the same mechanism lib/projects.server.ts and
// lib/orders.server.ts already rely on) so this hashing logic can never
// end up in browser code. lib/buildJobs.ts stays free of any Node-only
// import specifically so it remains safe to import from anywhere,
// including a future client component that only needs the status/target
// types or transition validation — those never need node:crypto at all.
//
// Deliberately no database access here yet (no createBuildJob, no reads) —
// this feature is schema/domain foundation only, per the approved scope.
export function computeGeneratedPosConfigHash(config: GeneratedPosConfig): string {
  const canonical = canonicalizeGeneratedPosConfig(config);
  return createHash("sha256").update(canonical).digest("hex");
}
