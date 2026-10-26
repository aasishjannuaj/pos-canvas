// IND-1 — static guards on the live status indicator's safety boundary.
//
// The indicator is DISPLAY ONLY. These pin, at the source level, that its new
// modules cannot reach checkout, offline entry, reconnect, sync, retries,
// pairing state or employee sessions; that its one backend call is the
// read-only get_device_pairing_state with retries off and a real abort; that it
// polls with timers, never setInterval; and that every existing financial
// timing constant is exactly what the accepted REL-1 candidate shipped.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { RECONNECT_PROBE_BACKOFF_MS, RECONNECT_PROBE_MAX_MS } from "@/lib/deviceReconnectProbe";
import { SYNC_BACKOFF_BASE_MS, SYNC_BACKOFF_FACTOR, SYNC_BACKOFF_MAX_MS } from "@/lib/saleSyncClassifier";
import { SALE_SUBMISSION_TIMEOUT_MS } from "@/lib/offlineSaleRpc";
import { SALE_LOOKUP_TIMEOUT_MS, SALE_RECOVERY_TIMEOUT_MS } from "@/lib/saleRecoveryRpc";
import { DAILY_REFRESH_BACKOFF_MS, DAILY_REFRESH_GRACE_MS, DAILY_REFRESH_MAX_MS } from "@/lib/dailyRegister";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

/** Source with comments stripped, so prose cannot satisfy an assertion. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const LIVE = "lib/liveStatus.ts";
const LOOP = "lib/serverReachability.ts";
const PILL = "components/device/LiveStatusIndicator.tsx";
const RPC = "lib/device.rpc.ts";
const APP = "components/device/DeviceApp.tsx";

const imports = (file: string) =>
  [...code(read(file)).matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gm)].map((m) => m[1]).sort();

/** The probe helper's full text, from its signature to the closing brace before the next export. */
function probeHelper(): string {
  const source = code(read(RPC));
  const start = source.indexOf("export async function probeDeviceReachability(");

  expect(start, "probeDeviceReachability not found").toBeGreaterThan(-1);

  const next = source.indexOf("\nexport ", start + 10);

  return source.slice(start, next === -1 ? undefined : next);
}

describe("the new modules can reach nothing financial", () => {
  it("liveStatus imports only the pure pairing parser and the sale-status type", () => {
    expect(imports(LIVE)).toEqual(["@/lib/deviceSession", "@/lib/offlineSaleStatus"]);
    expect(code(read(LIVE))).toContain('import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";');
    expect(code(read(LIVE))).toContain('import { parsePairingState } from "@/lib/deviceSession";');
  });

  it("the loop imports only liveStatus", () => {
    expect(new Set(imports(LOOP))).toEqual(new Set(["@/lib/liveStatus"]));
  });

  it("the indicator imports only React, the probe helper, the online hint, liveStatus, the loop and a type", () => {
    expect(new Set(imports(PILL))).toEqual(
      new Set([
        "react",
        "@/lib/device.rpc",
        "@/lib/deviceConnectivity",
        "@/lib/liveStatus",
        "@/lib/offlineSaleStatus",
        "@/lib/serverReachability",
      ])
    );
    expect(code(read(PILL))).toContain('import { probeDeviceReachability } from "@/lib/device.rpc";');
    expect(code(read(PILL))).toContain('import { readOnlineHint } from "@/lib/deviceConnectivity";');
    expect(code(read(PILL))).toContain('import type { OfflineSaleStatus } from "@/lib/offlineSaleStatus";');
  });

  it("no new module mentions a sale, sync, recovery, queue, employee, register or checkout entry point", () => {
    const banned = [
      /complete_sale/,
      /\brunSync\b/,
      /triggerSaleSync|runSaleSync/,
      /enterOffline|returnOnlineFromReconnect|startReconnectProbe/,
      /saleQueue|offlineQueue|deviceOfflineStore/,
      /saleRecovery|uncertainSale|recoveryAuthority/,
      /employee|EmployeePos|register_session|ensure_daily/i,
      /checkout|Checkout/,
      /setState\(|setGate|setSaleStatus/,
      /localStorage|sessionStorage|indexedDB/,
    ];

    for (const file of [LIVE, LOOP, PILL]) {
      const source = code(read(file));

      for (const pattern of banned) {
        expect(`${file}: ${pattern} ${pattern.test(source)}`).toBe(`${file}: ${pattern} false`);
      }
    }
  });

  it("polls with one-shot timers only — no setInterval anywhere in the new code", () => {
    for (const file of [LIVE, LOOP, PILL]) {
      expect(code(read(file))).not.toMatch(/setInterval/);
    }

    expect(code(read(LIVE))).not.toMatch(/setTimeout|Date\.now|fetch\(/);
    expect(code(read(LOOP))).not.toMatch(/setTimeout|Date\.now|fetch\(|window\.|document\./);
  });

  it("the indicator is not interactive; the existing sync bar keeps its controls", () => {
    const pill = code(read(PILL));

    expect(pill).not.toMatch(/<button|onClick|onKeyDown|href=/);
    expect(code(read(APP))).toContain("<DeviceSyncStatus");
  });
});

describe("the one backend call", () => {
  it("is the read-only get_device_pairing_state, retries off, with a real abort signal", () => {
    const helper = probeHelper();

    expect(helper).toContain('.rpc("get_device_pairing_state")');
    expect(helper).toContain(".retry(false)");
    expect(helper).toContain(".abortSignal(signal)");
    expect(helper.match(/\.rpc\(/g) ?? []).toHaveLength(1);
    expect(helper).not.toMatch(/\.from\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|auth\./);
  });

  it("the existing fetchDevicePairingState is byte-for-byte the accepted call", () => {
    const source = code(read(RPC));

    expect(source).toContain(
      'const { data, error, status } =\n      await getDeviceSupabaseClient().rpc("get_device_pairing_state");'
    );
    expect(source.match(/rpc\("get_device_pairing_state"\)/g) ?? []).toHaveLength(2);
  });

  it("only the indicator calls the probe helper", () => {
    expect(code(read(APP))).not.toContain("probeDeviceReachability");
    expect(code(read(APP))).not.toContain("startServerReachability");
  });
});

describe("DeviceApp: placement only", () => {
  it("renders the indicator once, inside headerTrailing, beside the operator menu", () => {
    const app = code(read(APP));
    const ready = app.slice(app.indexOf('case "ready": {'));
    const slotStart = ready.indexOf("headerTrailing={");
    const slot = ready.slice(slotStart, ready.indexOf("logoBaseUrl={", slotStart));

    expect(slotStart).toBeGreaterThan(-1);

    expect(app.match(/<LiveStatusIndicator/g) ?? []).toHaveLength(1);
    expect(slot).toContain("<LiveStatusIndicator");
    expect(slot).toContain("<OperatorMenu");
    expect(slot.indexOf("<LiveStatusIndicator")).toBeLessThan(slot.indexOf("<OperatorMenu"));
  });

  it("passes only values — no callback that could write DeviceApp state", () => {
    const app = code(read(APP));
    const start = app.indexOf("<LiveStatusIndicator");
    const props = app.slice(start, app.indexOf("/>", start));

    expect(props).not.toContain("=>");
    expect(props).not.toMatch(/\bset[A-Z]\w*/);
    expect(props).toContain("expectedDeviceId={state.pairing.deviceId}");
    expect(props).toContain('runtimeMode={offlineMode ? "offline" : "online"}');
    expect(props).toContain("saleStatus={saleStatus}");
    expect(props).toContain("saleStatusLoaded={saleStatus !== EMPTY_SALE_STATUS}");
    expect(props).toContain("syncing={syncing}");
    expect(props).toContain("paused={activeOverlay !== null}");
  });
});

describe("existing financial timing is exactly the accepted candidate's", () => {
  it("reconnect probe: 5, 10, 20, 30, 60s", () => {
    expect([...RECONNECT_PROBE_BACKOFF_MS]).toEqual([5_000, 10_000, 20_000, 30_000, 60_000]);
    expect(RECONNECT_PROBE_MAX_MS).toBe(60_000);
  });

  it("per-sale retry: 5s x 3^(n-1), capped at 15 min", () => {
    expect([SYNC_BACKOFF_BASE_MS, SYNC_BACKOFF_FACTOR, SYNC_BACKOFF_MAX_MS]).toEqual([5_000, 3, 900_000]);
  });

  it("sale submission 30s, recovery lookup 15s, recovery 30s", () => {
    expect([SALE_SUBMISSION_TIMEOUT_MS, SALE_LOOKUP_TIMEOUT_MS, SALE_RECOVERY_TIMEOUT_MS]).toEqual([
      30_000, 15_000, 30_000,
    ]);
  });

  it("daily register refresh: 60s, 5, 15, 30 min, capped at 6h, grace 5s", () => {
    expect([...DAILY_REFRESH_BACKOFF_MS]).toEqual([60_000, 300_000, 900_000, 1_800_000]);
    expect(DAILY_REFRESH_MAX_MS).toBe(21_600_000);
    expect(DAILY_REFRESH_GRACE_MS).toBe(5_000);
  });
});
