// Feature 24.4 — the offline architecture is a DESIGN, and these guards say so.
//
// WHY A DESIGN PHASE NEEDS GUARDS AT ALL: 24.4's whole value is that it decided
// things before writing them. The failure mode is not a bug — it is scope creep
// that looks like progress: a "small" IndexedDB helper, a "harmless" occurred_at
// column, a queue module added "while the design is fresh". Each would ship an
// untested half of a money-handling feature under a documentation commit.
//
// These assert the BOUNDARY, not the design's content. A design document cannot
// be unit-tested and pretending otherwise would be test-count inflation; what
// can be checked is that no runtime, no schema and no RPC moved.
//
// EVERY ONE OF THESE IS EXPECTED TO BE DELETED OR INVERTED BY 24.5. That is the
// point — they are a fence around a phase, not a permanent rule, and 24.5's
// first commit should replace them with substantive checks the way 24.2 and
// 24.3 replaced their predecessors.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf-8");
}

function exists(relativePath: string): boolean {
  return existsSync(join(repoRoot, relativePath));
}

const DESIGN_DOC = "docs/OFFLINE_ARCHITECTURE.md";

/** Every non-test source file that ships to a browser or a server. */
function productSourceFiles(): string[] {
  const roots = ["lib", "components", "app"];
  const files: string[] = [];

  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(repoRoot, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        walk(next);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.(test|guards\.test)\.tsx?$/.test(entry.name)) continue;

      files.push(next);
    }
  };

  for (const root of roots) walk(root);

  return files;
}

// ---------------------------------------------------------------------------
// The artifact 24.4 was supposed to produce
// ---------------------------------------------------------------------------

describe("Feature 24.4 produced a design document", () => {
  it("the document exists", () => {
    expect(exists(DESIGN_DOC)).toBe(true);
  });

  it("it decides the questions that block 24.5 rather than listing them", () => {
    // Each of these is a decision 24.5 cannot start without. Their absence would
    // mean the design phase deferred its own job.
    const doc = read(DESIGN_DOC);

    for (const required of [
      "Offline capability matrix",
      "Local config cache",
      "Offline device auth",
      "Sale identity and idempotency",
      "Queued sale data model",
      "Price authority",
      "Receipt numbering",
      "Inventory",
      "Payment methods",
      "Sync state machine",
      "Server contract for 24.5",
      "Revocation policy",
      "Config update policy",
      "Local data security",
      "Cross-platform storage decision",
      "Offline UX",
      "Failure-scenario matrix",
      "Implementation sequence for 24.5",
      "Test plan for 24.5",
      "Explicitly deferred complexity",
      "Approved product decisions",
    ]) {
      expect(`design doc missing: ${required}`).toBe(`design doc missing: ${required}`);
      expect(doc).toContain(required);
    }
  });

  it("it records which phases are implemented and which are not", () => {
    // 24.4 said "nothing is implemented". 24.5A implemented the first phase, so
    // the document must now say which, or it stops describing reality.
    const doc = read(DESIGN_DOC);

    expect(doc).toContain("24.5A");
    expect(doc).toContain("IMPLEMENTED");
    expect(doc).toContain("NOT IMPLEMENTED");
  });

  it("the owner's seven decisions are recorded as decided, not still open", () => {
    // The 24.4 review approved all seven. A design document that still calls
    // them open would send 24.5 back to ask questions that already have answers.
    const doc = read(DESIGN_DOC);

    expect(doc).not.toContain("## 22. Open product decisions");
    expect(doc).toContain("None is outstanding.");

    for (const decided of [
      "**7 days** from `lastVerifiedAt`",
      "cannot reopen or re-enter the POS",
      "never destroyed because current stock changed",
      "**Blocked by default.**",
      "OFFLINE RECEIPT",
      "read-only",
    ]) {
      expect(`decision not recorded: ${decided}`).toBe(`decision not recorded: ${decided}`);
      expect(doc).toContain(decided);
    }
  });

  it("both timestamps are kept, and a bad clock never destroys a sale", () => {
    const doc = read(DESIGN_DOC);

    expect(doc).toContain("Time — two timestamps, both preserved");
    expect(doc).toContain("A device clock is untrusted input.");
    expect(doc).toContain("An unresolvable clock never destroys the sale.");
  });

  it("it makes no security claim the product cannot support", () => {
    // §15 forbids these explicitly; a future edit must not quietly add one.
    const doc = read(DESIGN_DOC).toLowerCase();

    for (const banned of ["military grade", "military-grade", "bank grade", "bank-grade"]) {
      // The document may DISCUSS the ban, so only an unqualified claim counts:
      // every occurrence must sit next to the prohibition that names it.
      const index = doc.indexOf(banned);
      if (index === -1) continue;
      expect(doc.slice(Math.max(0, index - 200), index)).toMatch(/no |never|forbid|not /);
    }
  });
});

// ---------------------------------------------------------------------------
// No offline runtime was implemented
// ---------------------------------------------------------------------------

describe("Feature 24.4 implemented no offline runtime", () => {
  // SUPERSEDED IN PART BY 24.5A, deliberately and with the reason recorded.
  //
  // Two of this block's original assertions — "no product source touches
  // IndexedDB" and "the device has no local config persistence" — were fences
  // around the DESIGN phase. 24.5A implemented exactly the thing they fenced,
  // so keeping them would mean a passing suite could only be bought by not
  // doing the approved work. They are replaced by the substantive checks in
  // lib/offlineReadOnly.guards.test.ts, which assert that IndexedDB lives in
  // ONE module and that the cache holds configuration and never a sale.
  //
  // What survives here is everything 24.5A was still not allowed to do.
  it("no sale queue, sync engine or offline-sale module exists", () => {
    for (const premature of [
      "lib/offline.ts",
      "lib/offlineQueue.ts",
      "lib/offlineSale.ts",
      "lib/syncEngine.ts",
      "lib/saleQueue.ts",
    ]) {
      expect(`24.5C+ module exists early: ${premature}`).toBe(
        `24.5C+ module exists early: ${premature}`
      );
      expect(exists(premature)).toBe(false);
    }
  });

  it("the config cache is read-only to the device and stores no sale", () => {
    // 24.5A caches a configuration. It does not cache, queue or replay money.
    const cache = read("lib/deviceOfflineCache.ts");

    for (const premature of ["QueuedSale", "saleRequestId", "paymentMethod"]) {
      expect(`cache: ${premature}`).toBe(`cache: ${premature}`);
      expect(cache).not.toContain(premature);
    }
  });
});

// ---------------------------------------------------------------------------
// No server contract moved
// ---------------------------------------------------------------------------

describe("Feature 24.4 changed no schema, RPC or migration", () => {
  it("no migration mentions the 24.5 server contract", () => {
    // §12 proposes occurred_at, a source column and complete_sale_v4. None of
    // them may exist yet: a migration is the one thing here that is not
    // revertible by deleting a file.
    const migrationsDir = join(repoRoot, "supabase/migrations");
    const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));

    for (const name of migrations) {
      const sql = readFileSync(join(migrationsDir, name), "utf-8");

      for (const premature of ["occurred_at", "complete_sale_v4", "offline_queued"]) {
        expect(`${name} contains ${premature}`).toBe(`${name} contains ${premature}`);
        expect(sql).not.toContain(premature);
      }
    }
  });

  it("the client still calls complete_sale_v3 and nothing newer", () => {
    const deviceRpc = read("lib/device.rpc.ts");

    expect(deviceRpc).toContain('rpc("complete_sale_v3"');
    expect(deviceRpc).not.toContain("complete_sale_v4");
  });

  it("the sale request contract is untouched", () => {
    // The design REUSES this rather than replacing it (§5). Reuse means it must
    // still look exactly as it did.
    const saleRequest = read("lib/saleRequest.ts");

    expect(saleRequest).toContain("export function createSaleRequestId");
    expect(saleRequest).toContain("cryptoImpl.randomUUID()");
    expect(saleRequest).not.toContain("offline");
  });

  it("receipt numbering and inventory logic are untouched", () => {
    // Both are server-side and neither may gain a client-side counterpart here.
    for (const file of productSourceFiles()) {
      const source = read(file);

      for (const premature of [
        "provisionalReceipt",
        "provisionalOrderNumber",
        "allocateOrderNumber",
        "stockShortfall",
      ]) {
        expect(`${file} defines ${premature}`).toBe(`${file} defines ${premature}`);
        expect(source).not.toContain(premature);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Adjacent phases did not start
// ---------------------------------------------------------------------------

describe("Feature 24.4 stops at design", () => {
  it("no 24.6 publish-progress work began", () => {
    expect(exists("lib/publishProgress.ts")).toBe(false);
    expect(exists("components/editor/PublishProgress.tsx")).toBe(false);
  });

  it("pairing and revocation behaviour is unchanged", () => {
    const deviceRpc = read("lib/device.rpc.ts");

    expect(deviceRpc).toContain("get_device_pairing_state");
    expect(deviceRpc).toContain("isPossibleRevocationError");
    expect(deviceRpc).not.toContain("offlineLease");
    expect(deviceRpc).not.toContain("pairingAssertion");
  });

  it("Android and Windows branding is untouched by this phase", () => {
    // 24.2 and 24.3 are complete and closed; a design phase has no business
    // anywhere near them.
    expect(read("android/app/src/main/res/values/styles.xml")).toContain(
      '<item name="windowSplashScreenBackground">@color/ic_launcher_background</item>'
    );
    expect(exists("windows-shell/build/icon.ico")).toBe(true);
    expect(exists("windows-shell/splash.html")).toBe(true);
  });
});
