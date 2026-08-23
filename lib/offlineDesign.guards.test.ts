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
    // 24.4 said "nothing is implemented". Each phase since has had to say which
    // of them is true, or the document stops describing reality.
    //
    // NARROWED TWICE, both times because the honest status changed.
    //
    // It first required the literal "NOT IMPLEMENTED", which held while some
    // phase still had that status. 24.5F then narrowed it to "IN PROGRESS or NOT
    // IMPLEMENTED", because the code fixes had landed and the hardware QA had
    // not run.
    //
    // 24.5F IS NOW COMPLETE — validated on real Android and Windows hardware and
    // end to end against staging (§27) — so there is no unfinished phase left to
    // name, and an assertion demanding one would force the table to understate
    // reality. What must remain true is that EVERY phase carries a recognised
    // status: no row may go blank, and none may be quietly dropped.
    const doc = read(DESIGN_DOC);
    const table = doc.slice(doc.indexOf("## Implementation status"), doc.indexOf("### What 24.5"));

    expect(table).not.toBe("");

    for (const phase of ["24.5A", "24.5B", "24.5C", "24.5D", "24.5E", "24.5F"]) {
      expect(`phase ${phase} has a row`).toBe(`phase ${phase} has a row`);
      expect(table).toContain(phase);
    }

    expect(table).toContain("IMPLEMENTED");

    // Every phase row carries one of the recognised statuses. The regex is per
    // ROW, so a phase losing its status fails here rather than passing on some
    // other row's word.
    for (const phase of ["24.5A", "24.5B", "24.5C", "24.5D", "24.5E", "24.5F"]) {
      const row = table.split("\n").find((line) => line.includes(`**${phase}**`)) ?? "";

      expect(`phase ${phase} carries a status`).toBe(`phase ${phase} carries a status`);
      expect(row).toMatch(/\*\*(IMPLEMENTED|COMPLETE|IN PROGRESS|NOT IMPLEMENTED)\*\*/);
    }

    // The closeout that replaced "hardware QA not started" must actually exist.
    expect(doc).not.toContain("hardware QA not started");
    expect(doc).toContain("## 27. Feature 24.5F closeout — COMPLETE");
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
  it("no sync engine or offline-sale submission module exists", () => {
    // SUPERSEDED IN PART BY 24.5C. lib/saleQueue.ts was on this list as a fence
    // around the design phase; 24.5C implemented it. What survives is the next
    // fence: 24.5D owns submission, and none of it exists yet.
    for (const premature of [
      "lib/offline.ts",
      "lib/offlineSale.ts",
      "lib/syncEngine.ts",
      "lib/offlineSync.ts",
      "lib/saleSync.ts",
    ]) {
      expect(`24.5D+ module exists early: ${premature}`).toBe(
        `24.5D+ module exists early: ${premature}`
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
  it("the 24.5 server contract lives in ONE new migration, and edits none", () => {
    // SUPERSEDED BY 24.5B, deliberately. This previously asserted that NO
    // migration mentioned occurred_at, source or complete_sale_v4 — a fence
    // around the design phase. 24.5B implemented exactly that contract, so
    // keeping the fence would mean a passing suite could only be bought by not
    // doing the approved work.
    //
    // What survives is the property that actually protects production: the new
    // contract is additive and confined to its own file. No earlier migration
    // — least of all the one carrying complete_sale_v3 — may have been edited
    // to accommodate it.
    const migrationsDir = join(repoRoot, "supabase/migrations");
    const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));

    const carriers = migrations.filter((name) =>
      readFileSync(join(migrationsDir, name), "utf-8").includes("complete_sale_v4")
    );

    expect(carriers).toEqual([
      "20260819120000_offline_sale_contract_and_complete_sale_v4.sql",
    ]);

    // v3's own migration is untouched by the new contract.
    const v3Migration = readFileSync(
      join(migrationsDir, "20260810120000_modifier_contract_and_complete_sale_v3.sql"),
      "utf-8"
    );

    for (const added of ["occurred_at", "offline_queued", "complete_sale_v4"]) {
      expect(`v3 migration contains ${added}`).toBe(`v3 migration contains ${added}`);
      expect(v3Migration).not.toContain(added);
    }
  });

  it("the client still calls complete_sale_v3 and nothing newer", () => {
    const deviceRpc = read("lib/device.rpc.ts");

    // 24.5B built the server contract but wired NO client onto it. The device
    // still calls v3, and that is the point of the phase boundary.
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

  it("no client ever allocates a receipt number or a stock figure", () => {
    // NARROWED BY 24.5E, and the narrowing is the point.
    //
    // This used to ban the word "provisionalReceipt" everywhere, as a fence
    // around 24.4's design-only scope. 24.5E built the provisional receipt —
    // the owner-approved decision D in docs/OFFLINE_ARCHITECTURE.md §8 — so
    // keeping that ban would mean a passing suite could only be bought by not
    // doing the approved work.
    //
    // What survives is the property the original guard was actually protecting:
    // the two things only the SERVER may produce. A client that allocated an
    // order number would create a second numbering authority, and one that
    // computed a stock shortfall would be inventing an inventory fact it has no
    // basis for. A provisional receipt does neither: it carries a derived
    // reference and no order number at all.
    for (const file of productSourceFiles()) {
      const source = read(file);

      for (const premature of [
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
    // FEATURE 24.6 HAS NOW STARTED, with owner approval, so lib/publishProgress.ts
    // exists deliberately and asserting its absence would only pin this file to a
    // past that has moved on. The boundary it protected is still real, so it is
    // restated rather than dropped: publish progress is an OWNER-EDITOR concern
    // and must not reach into the device, offline or branding surfaces.
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/device");
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/saleQueue");
    expect(read("lib/publishProgress.ts")).not.toContain("@/lib/brand");
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
