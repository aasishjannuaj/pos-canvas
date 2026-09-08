// Feature 26.3 — the owner's Offer update path.
//
// WHAT IS PROVED WHERE. The state derivation is pure and is tested directly,
// exhaustively, against the same boundary the server uses. The security
// properties — that the browser never writes the table, that the action goes
// through the RPC, that no service-role client is reachable — are structural
// and are asserted against source, the way every other owner-device property in
// this repository is.
//
// WHAT IS NOT PROVED HERE. That the database refuses a wrong-owner offer. That
// is offer_device_config_update's own guarantee, covered by
// lib/deviceConfigUpdate.guards.test.ts and exercised on staging in 26.1. These
// tests prove the client never tries to do that job itself.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  canOfferDeviceUpdate,
  getDeviceUpdateStateLabel,
  mapPairedDeviceRow,
  resolveDeviceUpdateState,
} from "@/lib/devices";
import type { PairedDeviceSummary } from "@/lib/devices";
import { selectLatestSucceededBuild } from "@/lib/devicePairing.owner";
import { mapBuildJobRow } from "@/lib/buildJobs";
import type { BuildJobSummary } from "@/lib/buildJobs";

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

function device(overrides: Partial<PairedDeviceSummary> = {}): PairedDeviceSummary {
  return {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    projectId: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
    buildJobId: B1,
    deviceName: "Front Till",
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
// The state derivation
// ---------------------------------------------------------------------------

describe("resolveDeviceUpdateState", () => {
  it("says up to date when the pin is already the latest build", () => {
    expect(resolveDeviceUpdateState(device({ buildJobId: B2 }), B2)).toBe("up_to_date");
  });

  it("says update available when the pin is behind and nothing is offered", () => {
    expect(resolveDeviceUpdateState(device({ buildJobId: B1 }), B2)).toBe(
      "update_available"
    );
  });

  it("says update offered when the latest build is the one already offered", () => {
    expect(
      resolveDeviceUpdateState(
        device({ buildJobId: B1, offeredBuildJobId: B2 }),
        B2
      )
    ).toBe("update_offered");
  });

  it("says update available again when a NEWER build supersedes the offer", () => {
    // Offered B2, then B3 published. The server would overwrite the offer, so
    // the owner must not be stranded reading "Update offered" forever.
    expect(
      resolveDeviceUpdateState(
        device({ buildJobId: B1, offeredBuildJobId: B2 }),
        B3
      )
    ).toBe("update_available");
  });

  it("says up to date even while a stale offer lingers on the row", () => {
    // Pin already caught up; a leftover offer of an older build is not news.
    expect(
      resolveDeviceUpdateState(
        device({ buildJobId: B2, offeredBuildJobId: B1 }),
        B2
      )
    ).toBe("up_to_date");
  });

  for (const status of ["revoked", "unpaired"] as const) {
    it(`gives a ${status} device no state at all`, () => {
      const inactive = device({
        status,
        buildJobId: B1,
        revokedAt: status === "revoked" ? "2026-09-02T00:00:00.000Z" : null,
        unpairedAt: status === "unpaired" ? "2026-09-02T00:00:00.000Z" : null,
      });

      // NOT "up_to_date" — a device that is not running is not reassuring news,
      // and the server refuses to offer to it either way.
      expect(resolveDeviceUpdateState(inactive, B2)).toBe("none");
      expect(canOfferDeviceUpdate(inactive, B2)).toBe(false);
    });
  }

  it("gives no state when the project has no succeeded build", () => {
    expect(resolveDeviceUpdateState(device(), null)).toBe("none");
    expect(resolveDeviceUpdateState(device(), "")).toBe("none");
    expect(canOfferDeviceUpdate(device(), null)).toBe(false);
  });

  it("offers an action in exactly one state", () => {
    expect(canOfferDeviceUpdate(device({ buildJobId: B1 }), B2)).toBe(true);
    expect(canOfferDeviceUpdate(device({ buildJobId: B2 }), B2)).toBe(false);
    expect(
      canOfferDeviceUpdate(device({ buildJobId: B1, offeredBuildJobId: B2 }), B2)
    ).toBe(false);
  });

  it("renders no chip for the none state", () => {
    expect(getDeviceUpdateStateLabel("none")).toBeNull();
    expect(getDeviceUpdateStateLabel("up_to_date")).toBe("Up to date");
    expect(getDeviceUpdateStateLabel("update_available")).toBe("Update available");
    expect(getDeviceUpdateStateLabel("update_offered")).toBe("Update offered");
  });
});

describe("mapping the offer columns", () => {
  const row = {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    project_id: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
    build_job_id: B1,
    device_name: "Front Till",
    platform: "android",
    created_at: "2026-09-01T10:00:00.000Z",
    last_seen_at: null,
    revoked_at: null,
    unpaired_at: null,
  };

  it("reads an offer when one is present", () => {
    const mapped = mapPairedDeviceRow({
      ...row,
      offered_build_job_id: B2,
      offered_at: "2026-09-04T09:00:00.000Z",
    });

    expect(mapped?.offeredBuildJobId).toBe(B2);
    expect(mapped?.offeredAt).toBe("2026-09-04T09:00:00.000Z");
    // The pin is untouched by an offer. This is the whole contract.
    expect(mapped?.buildJobId).toBe(B1);
  });

  it("reads no offer when the columns are absent, null or empty", () => {
    expect(mapPairedDeviceRow(row)?.offeredBuildJobId).toBeNull();
    expect(
      mapPairedDeviceRow({ ...row, offered_build_job_id: null, offered_at: null })
        ?.offeredBuildJobId
    ).toBeNull();
    expect(
      mapPairedDeviceRow({ ...row, offered_build_job_id: "  ", offered_at: "" })
        ?.offeredBuildJobId
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe("the offer goes through the server boundary and nowhere else", () => {
  const action = code(read("lib/devicePairing.actions.ts"));
  const server = code(read("lib/devicePairing.server.ts"));
  const panel = code(read("components/devices/DeviceManagementPanel.tsx"));
  const row = code(read("components/devices/DeviceRow.tsx"));

  it("the action is a thin wrapper that delegates and queries nothing", () => {
    expect(action).toContain("offerDeviceConfigUpdate");
    expect(action).not.toContain(".from(");
    expect(action).not.toContain(".rpc(");
    expect(action).not.toContain("createClient");
  });

  it("the server function calls the RPC, not the table", () => {
    const fn = server.slice(
      server.indexOf("export async function offerDeviceConfigUpdate"),
      server.indexOf("export async function cancelDevicePairingToken")
    );

    // Whitespace-normalised: the call is formatted across lines, and how it is
    // wrapped is not a property worth pinning.
    const flat = fn.replace(/\s+/g, " ");

    expect(flat).toContain('.rpc( "offer_device_config_update"');
    expect(fn).toContain("p_device_id");
    expect(fn).toContain("p_build_job_id");
    // Never a direct write. paired_devices is the RPC's to touch.
    expect(fn).not.toContain('.from("paired_devices")');
    expect(fn).not.toContain("update(");
  });

  it("sends no owner id — the database derives it from auth.uid()", () => {
    const fn = server.slice(
      server.indexOf("export async function offerDeviceConfigUpdate"),
      server.indexOf("export async function cancelDevicePairingToken")
    );

    expect(fn).not.toContain("p_owner");
    expect(fn).not.toContain("ownerId");
    expect(fn).not.toContain("owner_id");
  });

  it("rejects a malformed uuid before it reaches the database", () => {
    // Both columns are uuid; a malformed value would arrive as an
    // invalid-input-syntax error rather than as a non-matching row.
    expect(action).toContain("isValidUuid(input?.deviceId)");
    expect(action).toContain("isValidUuid(input?.buildJobId)");
  });

  it("cannot throw out of the server action", () => {
    // SECOND-PASS FIX. createDevicePairingToken has always been wrapped; this
    // was not. A throw from createClient or the transport escaped the action,
    // rejected the caller's await, and left the button spinning forever.
    const fn = server.slice(
      server.indexOf("export async function offerDeviceConfigUpdate"),
      server.indexOf("export async function cancelDevicePairingToken")
    );

    expect(fn).toContain("try {");
    expect(fn).toContain("} catch {");
    expect(fn).toContain('category: "threw"');
    // The thrown value is not bound, so nothing it carries can be returned.
    expect(fn).not.toMatch(/catch\s*\(/);
  });

  it("uses no service-role client anywhere in the pairing layer", () => {
    for (const source of [action, server]) {
      expect(source).not.toContain("createAdminClient");
      expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(source).not.toContain("@/lib/supabase/admin");
      expect(source).not.toContain("service_role");
    }
  });

  it("returns a sanitized message, never the Postgres error", () => {
    const fn = server.slice(
      server.indexOf("export async function offerDeviceConfigUpdate"),
      server.indexOf("export async function cancelDevicePairingToken")
    );

    // ENUMERATED, NOT BLOCKLISTED. An earlier version of this test banned the
    // two spellings I happened to think of, and `(error as {message: string})
    // .message` sailed straight past it. Every message this function can
    // return has to be one of the two first-party strings, so any third
    // source — however it is spelled — fails.
    // Anchored on `return {` so the function's own `message: string` type
    // annotation is not mistaken for something it returns.
    const returned = [...fn.matchAll(/return\s*\{[^}]*message:\s*([^,\n}]+)/g)].map(
      (m) => m[1].trim()
    );

    expect(returned.length).toBeGreaterThan(0);
    for (const value of returned) {
      expect([
        "OFFER_FAILURE_MESSAGE",
        '"A valid device and configuration are required."',
      ]).toContain(value);
    }

    // And the error object is never read for text at all.
    expect(fn).not.toMatch(/error[^\n]*\.message/);
    // The log records a category, not the database's words.
    expect(fn).toContain('category: "rpc_failed"');
  });

  it("treats already_offered as success rather than an error", () => {
    const fn = server.slice(
      server.indexOf("export async function offerDeviceConfigUpdate"),
      server.indexOf("export async function cancelDevicePairingToken")
    );

    expect(fn).toContain("already_offered");
    expect(fn).toContain("ok: true, alreadyOffered");
  });

  it("the browser reaches the offer only through the action", () => {
    expect(panel).toContain("offerDeviceUpdate");
    expect(panel).toContain('from "@/lib/devicePairing.actions"');
    for (const source of [panel, row]) {
      expect(source).not.toContain("offer_device_config_update");
      expect(source).not.toContain("paired_devices");
      expect(source).not.toContain(".rpc(");
    }
  });
});

// ---------------------------------------------------------------------------
// The panel's own refusals
// ---------------------------------------------------------------------------

describe("the panel refuses before it requests", () => {
  const panel = code(read("components/devices/DeviceManagementPanel.tsx"));
  const handler = panel.slice(
    panel.indexOf("async function handleOfferUpdate"),
    panel.indexOf("return (")
  );

  it("re-derives offerability rather than trusting the rendered row", () => {
    // The list may have gone stale since the button was drawn.
    expect(handler).toContain("canOfferDeviceUpdate(device, latestBuildJobId)");
  });

  it("latches concurrent offers on a REF, not on React state", () => {
    // SECOND-PASS FIX. The guard read `offeringDeviceId !== null`, which is
    // React state and is not written synchronously — several taps in one tick
    // all read the same null and all proceed. Feature 26.2 shipped that exact
    // hole and staging fired five apply requests through it; this is the same
    // component pattern, so it had the same hole.
    expect(handler).toContain("offeringRef.current ||");
    expect(handler).toContain("offeringRef.current = true;");
    expect(handler).not.toContain("offeringDeviceId !== null ||");

    const guardAt = handler.indexOf("offeringRef.current ||");
    const callAt = handler.indexOf("await offerDeviceUpdate(");

    expect(guardAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(guardAt);
    // The refusal must LEAVE, not fall through into the request.
    expect(handler.slice(guardAt, callAt)).toContain("return;");
  });

  it("always releases the latch, even when the action throws", () => {
    // SECOND-PASS FIX. Without a finally, a rejected server action left the
    // latch set and the row stuck on "Offering…" until the panel remounted,
    // with nothing on screen explaining why.
    expect(handler).toContain("} finally {");
    expect(handler).toContain("offeringRef.current = false;");
    expect(handler).toContain("setOfferingDeviceId(null);");

    const finallyAt = handler.indexOf("} finally {");
    const releaseAt = handler.indexOf("offeringRef.current = false;");

    expect(releaseAt).toBeGreaterThan(finallyAt);
    // And a throw still tells the owner something.
    expect(handler).toContain("catch {");
    expect(handler).toContain("OFFER_UNAVAILABLE_MESSAGE");
  });

  it("disables every offer button while any one is in flight", () => {
    // SECOND-PASS FIX. The latch is a single-flight across the whole list, so
    // a second row's button did nothing when pressed while looking clickable.
    const row = code(read("components/devices/DeviceRow.tsx"));

    expect(row).toContain("disabled={anyOfferInFlight}");
    expect(row).toContain('{isOffering ? "Offering…" : "Offer update"}');
    expect(code(read("components/devices/PairedDeviceList.tsx"))).toContain(
      "anyOfferInFlight={offeringDeviceId !== null}"
    );
  });

  it("names the one device that is working, so the label is accurate", () => {
    expect(handler).toContain("setOfferingDeviceId(device.id)");
    expect(panel).toContain("offeringDeviceId={offeringDeviceId}");
    // Revoke's busy state stays independent of offering.
    expect(panel).toContain("busyDeviceId={isRevoking");
  });

  it("refuses when the project has no build to offer", () => {
    expect(handler).toContain("latestBuildJobId === null");
  });

  it("shows the owner when an offer failed", () => {
    // Caught by lint as an unused variable, but the real defect was silent:
    // a refused offer un-busied the button and said nothing at all.
    expect(handler).toContain("setOfferError(result.message)");
    expect(panel).toContain("offerErrorMessage={offerError}");

    const list = code(read("components/devices/PairedDeviceList.tsx"));

    expect(list).toContain("{offerErrorMessage}");
    expect(list).toContain('role="alert"');
    // Distinct from the list-load error: "devices are unreadable" and "that
    // one offer did not go through" are different sentences.
    expect(list).toContain("offerErrorMessage !== null");
    expect(list).toContain("errorMessage !== null");
  });

  it("clears a previous offer error before trying again", () => {
    expect(handler).toContain("setOfferError(null)");
  });

  it("reloads from the server instead of patching the row locally", () => {
    expect(handler).toContain("await refreshAll()");
    // Inventing the offer client-side would let the list claim one the
    // database does not have.
    expect(handler).not.toContain("setDevices(");
  });

  it("sends the latest succeeded build, resolved by the pairing helper", () => {
    expect(panel).toContain("selectLatestSucceededBuild(jobs)");
    expect(handler).toContain("buildJobId: latestBuildJobId");
  });

  it("never offers against a build baseline that Refresh could not update", () => {
    // SECOND-PASS FIX, and the one with teeth. loadBuilds ran only in the mount
    // effect, so Refresh reloaded devices while `jobs` — and therefore
    // latestBuildJobId — stayed frozen. An owner whose colleague published in
    // the meantime pressed Offer and sent the SUPERSEDED build: the server
    // accepts it, because it is still a real succeeded build of this project,
    // and the till is quietly offered last week's menu.
    expect(panel).toContain("const refreshAll = useCallback(async () => {");

    const refresh = panel.slice(
      panel.indexOf("const refreshAll = useCallback"),
      panel.indexOf("useEffect(")
    );

    expect(refresh).toContain("await loadBuilds()");
    expect(refresh).toContain("await loadDevices()");
    // Builds first: they decide what every row's state means.
    expect(refresh.indexOf("loadBuilds")).toBeLessThan(refresh.indexOf("loadDevices"));

    // Every reload path goes through it — the button, the mount, and the
    // post-offer refresh. A bare loadDevices() would reintroduce the freeze.
    expect(panel).toContain("void refreshAll();");
    expect(panel).not.toContain("void loadDevices();");
  });

  it("adds no bulk action", () => {
    // Feature 26.4's job. One device per press, and the handler takes exactly
    // one device.
    expect(panel).toContain("handleOfferUpdate(device: PairedDeviceSummary)");
    expect(panel).not.toContain("offerAll");
    expect(panel).not.toContain("devices.map(async");
    expect(panel).not.toContain("Promise.all");
  });
});

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

describe("the row shows one action, in one state", () => {
  const row = code(read("components/devices/DeviceRow.tsx"));

  it("renders the button only for update_available", () => {
    expect(row).toContain('updateState === "update_available" && (');
    expect(row).toContain("Offer update");
  });

  it("derives its own state rather than being told what to show", () => {
    expect(row).toContain("resolveDeviceUpdateState(device, latestBuildJobId)");
  });

  it("keeps Revoke working, gated on active as before", () => {
    expect(row).toContain("{active && (");
    expect(row).toContain("onRevoke(device)");
    expect(row).toContain("Revoke");
  });

  it("shows no build identifiers to the owner", () => {
    expect(row).not.toContain("{device.buildJobId}");
    expect(row).not.toContain("{device.offeredBuildJobId}");
  });
});

// ---------------------------------------------------------------------------
// Regression: the staging sequence that failed
// ---------------------------------------------------------------------------

/**
 * WHAT THIS CAN AND CANNOT PROVE. This repository has no DOM environment —
 * vitest runs in node and nothing renders React — so these exercise the
 * COMPOSITION the panel performs (load jobs -> select latest -> resolve each
 * row) with the panel's own functions, plus structural assertions that the
 * panel really is wired that way. They cannot prove React re-rendered.
 *
 * They exist because staging reported "Refresh, and no row offers an update".
 * The cause turned out to be that the build under test predated this feature,
 * but the sequence itself deserves a test that would have failed if the code
 * had been at fault.
 */
function job(id: string, createdAt: string, status = "succeeded"): BuildJobSummary {
  return mapBuildJobRow({
    id,
    project_id: "pppppppp-pppp-4ppp-8ppp-pppppppppppp",
    target: "android",
    status,
    config_schema_version: 1,
    config_hash: "hash",
    retried_from_job_id: null,
    failure_code: null,
    failure_message: null,
    started_at: createdAt,
    finished_at: createdAt,
    created_at: createdAt,
    updated_at: createdAt,
  } as never) as BuildJobSummary;
}

describe("publish in another tab, then Refresh, without remounting", () => {
  const B1 = job("11111111-1111-4111-8111-111111111111", "2026-09-07T02:00:00Z");
  const B2 = job("22222222-2222-4222-8222-222222222222", "2026-09-08T02:00:00Z");

  const pinnedToB1 = device({ buildJobId: B1.id, offeredBuildJobId: null });

  it("reads Up to date while the panel only knows about B1", () => {
    const latest = selectLatestSucceededBuild([B1])?.id ?? null;

    expect(latest).toBe(B1.id);
    expect(resolveDeviceUpdateState(pinnedToB1, latest)).toBe("up_to_date");
    expect(canOfferDeviceUpdate(pinnedToB1, latest)).toBe(false);
  });

  it("becomes Update available as soon as Refresh brings B2 in", () => {
    // Exactly what loadBuilds does: replace jobs with the newly fetched list.
    const latest = selectLatestSucceededBuild([B2, B1])?.id ?? null;

    expect(latest).toBe(B2.id);
    expect(resolveDeviceUpdateState(pinnedToB1, latest)).toBe("update_available");
    expect(canOfferDeviceUpdate(pinnedToB1, latest)).toBe(true);
  });

  it("would offer B2, never the B1 the panel opened on", () => {
    const latest = selectLatestSucceededBuild([B2, B1])?.id ?? null;

    expect(latest).toBe(B2.id);
    expect(latest).not.toBe(B1.id);
  });

  it("picks the newest by createdAt, not by arrival order", () => {
    // getProjectBuildJobs returns newest-first, but the panel must not depend
    // on that: a build arriving out of order still must not become "latest".
    expect(selectLatestSucceededBuild([B1, B2])?.id).toBe(B2.id);
    expect(selectLatestSucceededBuild([B2, B1])?.id).toBe(B2.id);
  });

  it("ignores a newer build that has not succeeded", () => {
    const queued = job("33333333-3333-4333-8333-333333333333", "2026-09-09T02:00:00Z", "queued");

    expect(selectLatestSucceededBuild([queued, B2, B1])?.id).toBe(B2.id);
  });

  it("is wired in the panel as load-builds-then-derive, in that order", () => {
    const panel = code(read("components/devices/DeviceManagementPanel.tsx"));

    // latestBuildJobId is derived in the RENDER body from `jobs` state, not
    // inside the async flow — deriving it after setJobs in the same async
    // function would read the previous render's value and reintroduce exactly
    // the staleness this feature had.
    const deriveAt = panel.indexOf("const latestBuildJobId = selectLatestSucceededBuild(jobs)");
    const refreshAt = panel.indexOf("const refreshAll = useCallback");

    expect(deriveAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(-1);
    expect(deriveAt).toBeGreaterThan(refreshAt);

    const refresh = panel.slice(refreshAt, panel.indexOf("useEffect("));

    expect(refresh).not.toContain("selectLatestSucceededBuild");
    expect(refresh).not.toContain("jobs");
  });
});

describe("a build-list failure cannot silently erase update availability", () => {
  const panel = code(read("components/devices/DeviceManagementPanel.tsx"));

  it("keeps the last known builds instead of claiming there are none", () => {
    // `setJobs([])` on failure said "this project has never published", which
    // dropped latestBuildJobId to null and quietly removed every chip and
    // button — the exact symptom staging reported, with no error shown.
    const loader = panel.slice(
      panel.indexOf("const loadBuilds = useCallback"),
      panel.indexOf("const refreshAll = useCallback")
    );

    expect(loader).not.toContain("setJobs([])");
    expect(loader).not.toContain("result.ok ? result.jobs : []");
    expect(loader).toContain("setBuildsError(result.message)");
    expect(loader).toContain("setJobs(result.jobs)");
    expect(loader).toContain("setBuildsError(null)");
  });

  it("refuses to offer while the baseline is unverified", () => {
    const handler = panel.slice(
      panel.indexOf("async function handleOfferUpdate"),
      panel.indexOf("async function handleCreateCode")
    );

    expect(handler).toContain("buildsError !== null ||");
  });

  it("tells the owner the update status may be stale", () => {
    const list = code(read("components/devices/PairedDeviceList.tsx"));

    expect(panel).toContain("buildsErrorMessage={buildsError}");
    expect(list).toContain("buildsErrorMessage !== null");
    expect(list).toContain("may be out of date");
  });
});
