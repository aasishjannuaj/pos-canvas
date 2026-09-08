// Feature 26.4 — offering the latest configuration to every eligible till.
//
// WHAT IS PROVED WHERE. Eligibility and the outcome wording are pure and are
// tested directly. The server loop and the concurrency guards have no DOM or
// database in this suite, so they are asserted against source — the same split
// every device feature in this repository uses, and the same one whose limits
// Feature 26.3's staging failure made concrete.
//
// WHAT IS NOT PROVED HERE. That the database refuses a wrong-owner device.
// offer_device_config_update owns that, and 26.1 exercised it on staging. What
// these prove is that the bulk path adds no authority of its own: it resolves
// its own build, filters with the same predicate as the single-device button,
// and calls the same RPC once per device.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  describeBulkOfferOutcome,
  selectOfferableDevices,
} from "@/lib/devices";
import type { PairedDeviceSummary } from "@/lib/devices";
import { selectLatestSucceededBuildId } from "@/lib/devicePairing.owner";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Strips comments, so prose can never satisfy a source assertion. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const B1 = "11111111-1111-4111-8111-111111111111";
const B2 = "22222222-2222-4222-8222-222222222222";
const B3 = "33333333-3333-4333-8333-333333333333";

function device(
  id: string,
  overrides: Partial<PairedDeviceSummary> = {}
): PairedDeviceSummary {
  return {
    id,
    projectId: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
    buildJobId: B1,
    deviceName: `Till ${id}`,
    platform: "android",
    status: "active",
    createdAt: "2026-09-01T10:00:00.000Z",
    lastSeenAt: null,
    unpairedAt: null,
    revokedAt: null,
    offeredBuildJobId: null,
    offeredAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Which devices a bulk offer touches
// ---------------------------------------------------------------------------

describe("selectOfferableDevices", () => {
  it("selects only devices whose pin is behind the latest build", () => {
    const devices = [device("a"), device("b"), device("c", { buildJobId: B2 })];

    expect(selectOfferableDevices(devices, B2).map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("skips devices already up to date", () => {
    expect(selectOfferableDevices([device("a", { buildJobId: B2 })], B2)).toEqual([]);
  });

  it("skips devices already offered this exact build", () => {
    // Re-offering would be a no-op the server reports as already_offered, and
    // would reset nothing — but it would also be a request for no reason.
    const already = device("a", { buildJobId: B1, offeredBuildJobId: B2 });

    expect(selectOfferableDevices([already], B2)).toEqual([]);
  });

  it("INCLUDES a device holding a superseded offer", () => {
    // Offered B2, then B3 published. Re-pointing it at B3 is the whole point.
    const stale = device("a", { buildJobId: B1, offeredBuildJobId: B2 });

    expect(selectOfferableDevices([stale], B3).map((d) => d.id)).toEqual(["a"]);
  });

  for (const status of ["revoked", "unpaired"] as const) {
    it(`skips ${status} devices`, () => {
      const inactive = device("a", {
        status,
        revokedAt: status === "revoked" ? "2026-09-02T00:00:00.000Z" : null,
        unpairedAt: status === "unpaired" ? "2026-09-02T00:00:00.000Z" : null,
      });

      expect(selectOfferableDevices([inactive], B2)).toEqual([]);
    });
  }

  it("selects nothing when there is no latest build", () => {
    expect(selectOfferableDevices([device("a"), device("b")], null)).toEqual([]);
    expect(selectOfferableDevices([device("a")], "")).toEqual([]);
  });

  it("selects nothing from an empty device list", () => {
    expect(selectOfferableDevices([], B2)).toEqual([]);
  });

  it("uses the SAME predicate as the per-device button", () => {
    // Two ideas of "eligible" would mean the count promises one thing and the
    // rows show another.
    expect(code(read("lib/devices.ts"))).toContain(
      "devices.filter((device) => canOfferDeviceUpdate(device, latestBuildJobId))"
    );
  });
});

// ---------------------------------------------------------------------------
// One rule for "latest"
// ---------------------------------------------------------------------------

describe("the server resolves the same latest build as the client", () => {
  const rows = [
    { id: B1, status: "succeeded", createdAt: "2026-09-07T02:00:00Z" },
    { id: B2, status: "succeeded", createdAt: "2026-09-08T02:00:00Z" },
  ];

  it("picks the newest succeeded build by createdAt", () => {
    expect(selectLatestSucceededBuildId(rows)).toBe(B2);
    expect(selectLatestSucceededBuildId([...rows].reverse())).toBe(B2);
  });

  it("ignores builds that have not succeeded", () => {
    expect(
      selectLatestSucceededBuildId([
        ...rows,
        { id: B3, status: "queued", createdAt: "2026-09-09T02:00:00Z" },
      ])
    ).toBe(B2);
  });

  it("returns null when nothing has succeeded", () => {
    expect(selectLatestSucceededBuildId([])).toBeNull();
    expect(
      selectLatestSucceededBuildId([{ id: B1, status: "failed", createdAt: "x" }])
    ).toBeNull();
  });

  it("shares one implementation with selectLatestSucceededBuild", () => {
    const owner = code(read("lib/devicePairing.owner.ts"));

    expect(owner).toContain("return latestSucceeded(jobs);");
    expect(owner).toContain("return latestSucceeded(candidates)?.id ?? null;");
    // Exactly one place filters on succeeded and reduces by createdAt.
    expect(owner.match(/status === "succeeded"/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// What the owner is told
// ---------------------------------------------------------------------------

describe("describeBulkOfferOutcome", () => {
  it("reports a clean full success", () => {
    expect(describeBulkOfferOutcome({ eligible: 5, offered: 5, failed: 0 })).toBe(
      "Update offered to 5 devices."
    );
  });

  it("does not hide a partial failure", () => {
    expect(describeBulkOfferOutcome({ eligible: 6, offered: 5, failed: 1 })).toBe(
      "Update offered to 5 of 6 devices. 1 device could not be updated. Refresh to see the current state."
    );
  });

  it("says how many remain when the batch cap was hit", () => {
    const text = describeBulkOfferOutcome({ eligible: 73, offered: 50, failed: 0 });

    expect(text).toContain("Update offered to 50 devices.");
    expect(text).toContain("23 devices still need this update — offer again.");
  });

  it("reports total failure without claiming any success", () => {
    const text = describeBulkOfferOutcome({ eligible: 3, offered: 0, failed: 3 });

    expect(text).toContain("Update offered to 0 of 3 devices.");
    expect(text).toContain("3 devices could not be updated.");
  });

  it("says nothing happened when nothing was eligible", () => {
    expect(describeBulkOfferOutcome({ eligible: 0, offered: 0, failed: 0 })).toBe(
      "No devices needed this update."
    );
  });

  it("uses singular wording for one device", () => {
    expect(describeBulkOfferOutcome({ eligible: 1, offered: 1, failed: 0 })).toBe(
      "Update offered to 1 device."
    );
  });
});

// ---------------------------------------------------------------------------
// The server boundary
// ---------------------------------------------------------------------------

describe("the bulk offer stays inside the existing boundary", () => {
  const server = code(read("lib/devicePairing.server.ts"));
  const action = code(read("lib/devicePairing.actions.ts"));
  const panel = code(read("components/devices/DeviceManagementPanel.tsx"));
  const list = code(read("components/devices/PairedDeviceList.tsx"));

  const fn = server.slice(
    server.indexOf("export async function offerDeviceConfigUpdateToAll"),
    server.indexOf("export async function cancelDevicePairingToken")
  );

  it("adds no new database function — it reuses the 26.1 RPC per device", () => {
    expect(fn).toContain("await offerDeviceConfigUpdate({");
    // No bulk RPC, and therefore no second un-deployed migration.
    expect(server).not.toContain("offer_device_config_update_bulk");
    expect(server).not.toContain("p_device_ids");
  });

  it("takes only a project id — never a device list or a build id", () => {
    expect(action).toContain("export async function offerDeviceUpdateToAll(\n  projectId: string\n)");
    expect(action).not.toContain("deviceIds");
    expect(action).not.toContain("buildJobId: string[]");
  });

  it("resolves the build baseline server-side, not from the caller", () => {
    expect(fn).toContain("selectLatestSucceededBuildId");
    expect(fn).toContain('.eq("status", "succeeded")');
    // The client's idea of latest never crosses the boundary.
    expect(fn).not.toContain("input.buildJobId");
  });

  it("fails closed when no build baseline can be resolved", () => {
    expect(fn).toContain("if (latestBuildJobId === null)");
    expect(fn).toContain("BULK_OFFER_NO_BUILD_MESSAGE");

    const nullCheckAt = fn.indexOf("if (latestBuildJobId === null)");
    const loopAt = fn.indexOf("for (const device of batch)");

    expect(nullCheckAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(nullCheckAt);
    expect(fn.slice(nullCheckAt, loopAt)).toContain("return {");
  });

  it("filters with the shared predicate rather than its own rule", () => {
    expect(fn).toContain("selectOfferableDevices(devices, latestBuildJobId)");
  });

  it("bounds the batch so the loop cannot be unbounded", () => {
    expect(server).toContain("export const MAX_BULK_OFFER_DEVICES = 50;");
    expect(fn).toContain("eligible.slice(0, MAX_BULK_OFFER_DEVICES)");
    // The excess is reported, not silently dropped.
    expect(fn).toContain("eligible: eligible.length");
  });

  it("loops sequentially — no unbounded parallel fan-out", () => {
    expect(fn).toContain("for (const device of batch)");
    expect(fn).not.toContain("Promise.all");
    expect(fn).not.toContain("Promise.allSettled");
  });

  it("counts partial failures instead of aborting the run", () => {
    expect(fn).toContain("offered += 1");
    expect(fn).toContain("failed += 1");
    // A failed device must not end the loop.
    const loop = fn.slice(fn.indexOf("for (const device of batch)"));
    expect(loop.slice(0, loop.indexOf("}\n\n"))).not.toContain("break");
  });

  it("never writes the table from the browser", () => {
    for (const source of [panel, list]) {
      expect(source).not.toContain("paired_devices");
      expect(source).not.toContain(".rpc(");
      expect(source).not.toContain(".from(");
      expect(source).not.toContain("createClient");
    }
  });

  it("uses no service-role client, directly or by import", () => {
    for (const source of [server, action, panel, list]) {
      expect(source).not.toContain("createAdminClient");
      expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(source).not.toContain("@/lib/supabase/admin");
      expect(source).not.toContain("service_role");
    }
    // buildJobs.server.ts constructs the admin client, so the pairing layer
    // must not reach for it just to read build rows.
    expect(server).not.toContain("@/lib/buildJobs.server");
  });

  it("returns only first-party messages", () => {
    const returned = [...fn.matchAll(/return\s*\{[^}]*message:\s*([^,\n}]+)/g)].map(
      (m) => m[1].trim()
    );

    expect(returned.length).toBeGreaterThan(0);
    for (const value of returned) {
      expect([
        "BULK_OFFER_UNAVAILABLE_MESSAGE",
        "BULK_OFFER_NO_BUILD_MESSAGE",
        '"A valid project is required."',
        '"You must be signed in to offer updates."',
      ]).toContain(value);
    }
    expect(fn).not.toMatch(/error[^\n]*\.message/);
  });

  it("cannot throw out of the server action", () => {
    expect(fn).toContain("try {");
    expect(fn).toContain("} catch {");
    expect(fn).not.toMatch(/catch\s*\(/);
  });

  it("validates the project id as a uuid before any database call", () => {
    expect(action).toContain("isValidUuid(projectId)");
  });
});

// ---------------------------------------------------------------------------
// Concurrency, both directions
// ---------------------------------------------------------------------------

describe("bulk and single-device offers cannot overlap", () => {
  const panel = code(read("components/devices/DeviceManagementPanel.tsx"));
  const list = code(read("components/devices/PairedDeviceList.tsx"));
  const bulk = panel.slice(
    panel.indexOf("async function handleOfferUpdateToAll"),
    panel.indexOf("async function handleOfferUpdate(")
  );
  const single = panel.slice(
    panel.indexOf("async function handleOfferUpdate("),
    panel.indexOf("async function handleCreateCode")
  );

  it("shares ONE synchronous latch between both handlers", () => {
    // React state is not written synchronously — 26.2 and 26.3 both shipped
    // that hole. One ref covers both flows, so neither can start while the
    // other is running.
    expect(bulk).toContain("offeringRef.current ||");
    expect(bulk).toContain("offeringRef.current = true;");
    expect(single).toContain("offeringRef.current ||");
    expect(single).toContain("offeringRef.current = true;");
    expect(bulk).not.toContain("bulkOffering ||");
  });

  it("releases the latch in a finally, in both handlers", () => {
    for (const handler of [bulk, single]) {
      expect(handler).toContain("} finally {");
      expect(handler).toContain("offeringRef.current = false;");
    }
  });

  it("blocks a repeated bulk press before any request is made", () => {
    const guardAt = bulk.indexOf("offeringRef.current ||");
    const callAt = bulk.indexOf("await offerDeviceUpdateToAll(");

    expect(guardAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(guardAt);
    expect(bulk.slice(guardAt, callAt)).toContain("return;");
  });

  it("disables the bulk button while a single-row offer is running", () => {
    expect(list).toContain("disabled={bulkOffering || offeringDeviceId !== null}");
  });

  it("disables every single-row button while a bulk offer is running", () => {
    // Otherwise a row button looks clickable and silently does nothing —
    // exactly the dishonest busy state fixed in 26.3.
    expect(list).toContain(
      "anyOfferInFlight={offeringDeviceId !== null || bulkOffering}"
    );
  });

  it("refuses to bulk-offer while the build baseline is unverified", () => {
    expect(bulk).toContain("buildsError !== null ||");
  });

  it("refuses to bulk-offer when nothing is eligible", () => {
    expect(bulk).toContain("offerableCount === 0");
  });

  it("re-reads server truth on EVERY path, including a throw", () => {
    // One unconditional refresh rather than one per branch: a throw can leave
    // devices offered by a request that then came apart, and that is exactly
    // the path a per-branch refresh forgets.
    expect(bulk.match(/await refreshAll\(\)/g)).toHaveLength(1);

    const catchAt = bulk.indexOf("} catch {");
    const refreshAt = bulk.indexOf("await refreshAll()");

    expect(catchAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(catchAt);
    // The catch must not bail out before the refresh.
    expect(bulk.slice(catchAt, refreshAt)).not.toContain("return;");
  });
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

describe("the bulk control appears only when it would do something", () => {
  const list = code(read("components/devices/PairedDeviceList.tsx"));
  const panel = code(read("components/devices/DeviceManagementPanel.tsx"));

  it("renders nothing when no device is eligible", () => {
    expect(list).toContain("{offerableCount > 0 && (");
  });

  it("states the count before the owner presses it", () => {
    expect(list).toContain("devices can be updated to the latest configuration");
    expect(list).toContain("1 device can be updated to the latest configuration.");
  });

  it("is labelled for what it does", () => {
    expect(list).toContain('"Offer update to all"');
    expect(list).toContain('{bulkOffering ? "Offering…" : "Offer update to all"}');
  });

  it("counts eligibility with the shared helper, not a local rule", () => {
    expect(panel).toContain("selectOfferableDevices(devices, latestBuildJobId).length");
  });

  it("counts zero while the build baseline is unverified", () => {
    expect(panel).toContain("buildsError !== null ? 0 :");
  });

  it("shows the server's counts, not the ones it displayed", () => {
    const bulk = panel.slice(
      panel.indexOf("async function handleOfferUpdateToAll"),
      panel.indexOf("async function handleOfferUpdate(")
    );

    expect(bulk).toContain("describeBulkOfferOutcome(result)");
    expect(list).toContain("{bulkNotice}");
  });

  it("adds no bulk revoke and no bulk apply", () => {
    for (const source of [panel, list]) {
      expect(source).not.toContain("revokeAll");
      expect(source).not.toContain("applyAll");
      expect(source).not.toContain("forceUpdate");
    }
  });
});
