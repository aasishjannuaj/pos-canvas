// Feature 15.2 — a Vitest-only stand-in for the "server-only" package.
//
// The real "server-only" package (node_modules/server-only) has no
// generic Node-vs-browser distinction: its package.json `exports` map only
// no-ops under a Next.js-specific "react-server" condition, and throws
// unconditionally otherwise (see node_modules/server-only/index.js). That
// means importing any file that does `import "server-only"` — including
// the pre-existing lib/projects.server.ts and lib/orders.server.ts, not
// just anything added in this feature — always throws under plain Node or
// Vitest, regardless of environment. This is presumably why no .server.ts
// file has been unit-tested in this repo before now.
//
// This stub is wired up only via vitest.config.ts's resolve.alias, which
// applies exclusively to the Vitest test run — it has no effect whatsoever
// on the real Next.js build, which resolves "server-only" through its own
// webpack pipeline untouched by this file. The actual enforcement of
// "this can't reach a client bundle" in production continues to come from
// Next.js's own build (both this package's real behavior there, and
// separately from node:crypto simply not being polyfilled for the client).
export {};
