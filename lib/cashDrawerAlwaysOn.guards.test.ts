// v1.3.4 OWNER DECISION (2026-10-28) — the cash drawer is ALWAYS ON for a
// paired Windows till. There is no per-register setting and nothing in the
// editor: the owner removed it after a re-paired till silently lost it.
//
// Replaces lib/cashDrawerOwnerConfig.guards.test.ts, which pinned the owner
// toggle this decision removed. What still holds is held by
// lib/cashDrawer.guards.test.ts and lib/cashDrawer.test.ts: cash only, Windows
// only, one durable claim per sale, never on sync/replay/reprint.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });

describe("no drawer setting exists for the owner", () => {
  it("the Devices screens render no drawer control or drawer wording", () => {
    for (const file of walk("components/devices")) {
      const source = code(read(file));
      for (const banned of ["Auto-open cash drawer", "cashDrawer", "CashDrawer", "cash-drawer", "drawer"]) {
        expect(`${file}: ${banned} ${source.includes(banned)}`).toBe(`${file}: ${banned} false`);
      }
    }
  });

  it("no owner action, server wrapper or component can call the setter RPC", () => {
    for (const file of [...walk("lib"), ...walk("components"), ...walk("app")]) {
      const source = code(read(file));
      for (const banned of ["set_device_cash_drawer_enabled", "setDeviceCashDrawerEnabled", "setOwnerDeviceCashDrawerEnabled"]) {
        expect(`${file}: ${banned} ${source.includes(banned)}`).toBe(`${file}: ${banned} false`);
      }
    }
  });
});

describe("the till decides by itself", () => {
  const app = code(read("components/device/DeviceApp.tsx"));
  const handler = app.slice(app.indexOf("const handleSaleCompleted"), app.indexOf("}, []);", app.indexOf("const handleSaleCompleted")));

  it("any ready pairing enables it; no stored setting is consulted", () => {
    expect(handler).toContain("autoOpenEnabled: readyPairingRef.current !== null,");
    expect(handler).not.toContain("cashDrawerEnabled");
  });

  it("cash-only, Windows-only and once-per-sale still live in the one coordinator", () => {
    expect(handler).toContain("void runAutomaticDrawerEvent({");
    expect(handler).toContain("claim: claimAutomaticDrawerEvent,");
    const drawer = code(read("lib/cashDrawer.ts"));
    expect(drawer.indexOf("isAutomaticDrawerEligible(event.paymentMethod)")).toBeLessThan(drawer.indexOf("isAutomaticDrawerPlatform(platform)"));
    expect(drawer.indexOf("isAutomaticDrawerPlatform(platform)")).toBeLessThan(drawer.indexOf("claim(event.saleRequestId)"));
  });
});
