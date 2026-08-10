// Feature 16.4A — pure state-model tests. No DOM, no Supabase, matching this
// repository's Node-only Vitest setup.
import { describe, expect, it } from "vitest";
import {
  DEVICE_ERROR_MESSAGES,
  createDeviceError,
  decideConfigState,
  decidePairingState,
  getDeviceDisplayName,
  isDeviceOperational,
  parseDeviceConfig,
  parsePairingState,
  resolveDeviceIdentity,
  toDeviceDisplayConfig,
} from "@/lib/deviceSession";
import { detectNativeShell } from "@/lib/nativeShell";
import type { DevicePairing } from "@/lib/deviceSession";
import { DEVICE_AUTH_STORAGE_KEY } from "@/lib/supabase/deviceClient";
import { GENERATED_POS_CONFIG_SCHEMA_VERSION } from "@/lib/generatedPosConfig";

const PAIRING: DevicePairing = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  buildJobId: "33333333-3333-4333-8333-333333333333",
  deviceName: null,
  platform: "android",
  createdAt: "2026-08-01T00:00:00Z",
  revokedAt: null,
};

function validConfig() {
  return {
    schemaVersion: GENERATED_POS_CONFIG_SCHEMA_VERSION,
    generatedAt: "2026-08-01T00:00:00.000Z",
    project: {
      projectId: PAIRING.projectId,
      projectName: "Corner Cafe",
      templateId: "cafe",
      layout: "menu-grid",
    },
    businessProfile: {
      businessName: "Corner Cafe",
      addressLine1: "",
      addressLine2: "",
      city: "",
      state: "",
      postalCode: "",
      phone: "",
      email: "",
      website: "",
    },
    branding: { accentColor: "#111111" },
    menuItems: [
      {
        id: "m1",
        name: "Latte",
        price: 4.5,
        category: "Drinks",
        trackInventory: true,
        stockQuantity: 12,
      },
      {
        id: "m2",
        name: "Water",
        price: 1,
        category: "Drinks",
        trackInventory: false,
        stockQuantity: 0,
      },
    ],
    tax: { enabled: false, rate: 0, pricesIncludeTax: false, showTaxSeparately: true },
    receipt: {
      currency: "USD",
      footer: "",
      orderPrefix: "ORD-",
      tipsEnabled: false,
      showBusinessName: true,
      headerMessage: "",
      showTaxLine: true,
      showTipLine: true,
      showPaymentMethod: true,
      showOrderNumber: true,
    },
  };
}

describe("parsePairingState", () => {
  it("reads an active paired device", () => {
    const result = parsePairingState({
      paired: true,
      device_id: PAIRING.deviceId,
      project_id: PAIRING.projectId,
      build_job_id: PAIRING.buildJobId,
      device_name: null,
      platform: "android",
      created_at: PAIRING.createdAt,
      revoked_at: null,
      active: true,
    });

    expect(result).toEqual({ paired: true, pairing: PAIRING, active: true });
  });

  it("derives active from revoked_at, never from the payload's own boolean", () => {
    // A payload claiming active:true while carrying a revoked_at must NOT be
    // treated as active — the timestamp is the authoritative field.
    const result = parsePairingState({
      paired: true,
      device_id: PAIRING.deviceId,
      project_id: PAIRING.projectId,
      build_job_id: PAIRING.buildJobId,
      revoked_at: "2026-08-02T00:00:00Z",
      active: true,
    });

    expect(result).toEqual({
      paired: true,
      pairing: { ...PAIRING, deviceName: null, platform: null, createdAt: null, revokedAt: "2026-08-02T00:00:00Z" },
      active: false,
    });
  });

  it("reads the unpaired and unauthenticated reasons", () => {
    expect(parsePairingState({ paired: false, reason: "not_paired" })).toEqual({
      paired: false,
      reason: "not_paired",
    });
    expect(
      parsePairingState({ paired: false, reason: "not_authenticated" })
    ).toEqual({ paired: false, reason: "not_authenticated" });
  });

  it("never treats an unrecognized payload as paired", () => {
    for (const value of [null, undefined, 42, "paired", [], {}, { paired: "yes" }]) {
      expect(parsePairingState(value).paired).toBe(false);
    }
  });

  it("rejects a paired payload missing an identity field", () => {
    expect(
      parsePairingState({ paired: true, device_id: PAIRING.deviceId }).paired
    ).toBe(false);
  });
});

describe("decidePairingState", () => {
  it("sends an active device to config loading", () => {
    expect(
      decidePairingState({ paired: true, pairing: PAIRING, active: true })
    ).toEqual({ status: "loading_config", pairing: PAIRING });
  });

  it("sends a revoked device to the revoked screen", () => {
    expect(
      decidePairingState({ paired: true, pairing: PAIRING, active: false })
    ).toEqual({ status: "revoked", pairing: PAIRING });
  });

  it("sends an unpaired device to the pairing screen", () => {
    expect(decidePairingState({ paired: false, reason: "not_paired" })).toEqual({
      status: "unpaired",
      notice: null,
    });
  });

  it("sends a session-less device back to sign-in", () => {
    expect(
      decidePairingState({ paired: false, reason: "not_authenticated" })
    ).toEqual({ status: "signing_in" });
  });

  it("treats an unreadable payload as an error, never as paired", () => {
    expect(decidePairingState({ paired: false, reason: "unreadable" })).toEqual(
      createDeviceError("unavailable")
    );
  });
});

describe("parseDeviceConfig", () => {
  it("accepts a valid pinned snapshot", () => {
    const result = parseDeviceConfig({
      ok: true,
      project_id: PAIRING.projectId,
      build_job_id: PAIRING.buildJobId,
      config_schema_version: 1,
      config: validConfig(),
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a malformed config rather than rendering it partially", () => {
    const broken = validConfig();
    // @ts-expect-error deliberately corrupting the contract
    delete broken.menuItems;

    expect(
      parseDeviceConfig({
        ok: true,
        project_id: PAIRING.projectId,
        build_job_id: PAIRING.buildJobId,
        config: broken,
      })
    ).toEqual({ ok: false, reason: "config_unavailable" });
  });

  it("rejects an unknown schema version", () => {
    const future = { ...validConfig(), schemaVersion: 999 };

    expect(
      parseDeviceConfig({
        ok: true,
        project_id: PAIRING.projectId,
        build_job_id: PAIRING.buildJobId,
        config: future,
      }).ok
    ).toBe(false);
  });

  it("maps not_paired and config_unavailable distinctly", () => {
    expect(parseDeviceConfig({ ok: false, error: "not_paired" })).toEqual({
      ok: false,
      reason: "not_paired",
    });
    expect(parseDeviceConfig({ ok: false, error: "config_unavailable" })).toEqual({
      ok: false,
      reason: "config_unavailable",
    });
  });
});

describe("decideConfigState", () => {
  it("opens the POS on a valid config", () => {
    const config = validConfig();
    const state = decideConfigState(
      // @ts-expect-error narrow shape is validated elsewhere
      { ok: true, projectId: PAIRING.projectId, buildJobId: PAIRING.buildJobId, config },
      PAIRING
    );

    expect(state.status).toBe("ready");
  });

  it("treats not_paired during config load as revocation", () => {
    // get_device_config filters revoked_at is null, so a device revoked
    // between the state check and the config load simply stops matching.
    expect(
      decideConfigState({ ok: false, reason: "not_paired" }, PAIRING)
    ).toEqual({ status: "revoked", pairing: PAIRING });
  });

  it("blocks the POS when the config is unavailable", () => {
    expect(
      decideConfigState({ ok: false, reason: "config_unavailable" }, PAIRING)
    ).toEqual({ status: "config_unavailable", pairing: PAIRING });
  });
});

describe("toDeviceDisplayConfig", () => {
  it("strips stock tracking so frozen counts are never shown as live", () => {
    const device = toDeviceDisplayConfig(validConfig() as never);

    for (const item of device.menuItems) {
      expect(item.trackInventory).toBe(false);
      expect(item.stockQuantity).toBe(0);
    }
  });

  it("leaves pricing, tax and receipt settings exactly as pinned", () => {
    const source = validConfig();
    const device = toDeviceDisplayConfig(source as never);

    expect(device.menuItems.map((item) => item.price)).toEqual([4.5, 1]);
    expect(device.menuItems.map((item) => item.name)).toEqual(["Latte", "Water"]);
    expect(device.tax).toEqual(source.tax);
    expect(device.receipt).toEqual(source.receipt);
    expect(device.branding).toEqual(source.branding);
  });

  it("does not mutate the source config", () => {
    const source = validConfig();
    toDeviceDisplayConfig(source as never);

    expect(source.menuItems[0].trackInventory).toBe(true);
    expect(source.menuItems[0].stockQuantity).toBe(12);
  });
});

describe("resolveDeviceIdentity", () => {
  it("names a native-shell device 'POS Device' on platform 'android'", () => {
    expect(resolveDeviceIdentity(true)).toEqual({
      deviceName: "POS Device",
      platform: "android",
    });
  });

  it("names a browser device 'POS Device' on platform 'web'", () => {
    expect(resolveDeviceIdentity(false)).toEqual({
      deviceName: "POS Device",
      platform: "web",
    });
  });

  it("satisfies the paired_devices CHECK constraints", () => {
    // paired_devices_device_name_check / _platform_check reject a value that
    // is present but blank after btrim.
    for (const identity of [resolveDeviceIdentity(true), resolveDeviceIdentity(false)]) {
      expect(identity.deviceName.trim()).not.toBe("");
      expect(identity.platform.trim()).not.toBe("");
    }
  });

  it("carries no owner, hardware or session identifier", () => {
    const identity = resolveDeviceIdentity(true);

    // The shape itself is the guarantee: exactly two fields, both fixed
    // product vocabulary. There is nowhere to put an auth_user_id, a serial,
    // or an owner-specific name.
    expect(Object.keys(identity).sort()).toEqual(["deviceName", "platform"]);

    for (const value of Object.values(identity)) {
      expect(value).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      );
    }

    expect(["POS Device"]).toContain(identity.deviceName);
    expect(["android", "web"]).toContain(identity.platform);
  });

  it("is stable — the same input always yields the same identity", () => {
    // device_name and platform are frozen by D4c at insert, so a value that
    // varied between calls could never be corrected afterwards.
    expect(resolveDeviceIdentity(true)).toEqual(resolveDeviceIdentity(true));
    expect(resolveDeviceIdentity(false)).toEqual(resolveDeviceIdentity(false));
  });
});

describe("native-shell detection feeding the identity", () => {
  it("maps Capacitor's own isNativePlatform() to the android platform", () => {
    expect(
      resolveDeviceIdentity(detectNativeShell({ isNativePlatform: () => true }))
        .platform
    ).toBe("android");
  });

  it("falls back to web for a browser, a missing global, or a throwing bridge", () => {
    const nonNative: unknown[] = [
      undefined,
      null,
      {},
      { isNativePlatform: () => false },
      {
        isNativePlatform: () => {
          throw new Error("bridge unavailable");
        },
      },
    ];

    for (const capacitor of nonNative) {
      expect(resolveDeviceIdentity(detectNativeShell(capacitor)).platform).toBe("web");
    }
  });
});

describe("device presentation helpers", () => {
  it("names an unnamed device by platform", () => {
    expect(getDeviceDisplayName(PAIRING)).toBe("Unnamed android device");
    expect(
      getDeviceDisplayName({ ...PAIRING, platform: null })
    ).toBe("This device");
    expect(
      getDeviceDisplayName({ ...PAIRING, deviceName: "Front counter" })
    ).toBe("Front counter");
  });

  it("treats only the ready state as operational", () => {
    expect(isDeviceOperational({ status: "checking" })).toBe(false);
    expect(isDeviceOperational({ status: "revoked", pairing: PAIRING })).toBe(false);
    expect(
      isDeviceOperational({ status: "config_unavailable", pairing: PAIRING })
    ).toBe(false);
    expect(isDeviceOperational(createDeviceError("offline"))).toBe(false);
    expect(
      isDeviceOperational({
        status: "ready",
        pairing: PAIRING,
        config: validConfig() as never,
      })
    ).toBe(true);
  });

  it("exposes no raw database text in its error messages", () => {
    for (const message of Object.values(DEVICE_ERROR_MESSAGES)) {
      expect(message).not.toMatch(/sql|postgres|rpc|constraint|relation|auth\.uid/i);
    }
  });
});

describe("device storage isolation", () => {
  it("uses a storage key distinct from any owner cookie name", () => {
    expect(DEVICE_AUTH_STORAGE_KEY).toBe("pos-canvas-device-auth");
    // @supabase/ssr derives the owner cookie name from the project ref
    // ("sb-<ref>-auth-token"). A device key in that namespace would be read as
    // the owner session by the server client.
    expect(DEVICE_AUTH_STORAGE_KEY.startsWith("sb-")).toBe(false);
  });
});
