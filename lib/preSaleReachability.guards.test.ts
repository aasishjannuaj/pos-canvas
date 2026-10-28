// v1.3.4 — WHERE the quick pre-sale check sits is the safety property: before
// any sale identity is planned, armed or sent, and never for a retry or a
// resumed (uncertain) sale. Source-order checks, in the style of the other
// checkout guards.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const runtime = code(readFileSync("components/runtime/PosRuntime.tsx", "utf8"));
const deviceApp = code(readFileSync("components/device/DeviceApp.tsx", "utf8"));
const complete = runtime.slice(runtime.indexOf("async function completeSale()"));
const at = (needle: string) => {
  const i = complete.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe("the pre-sale server check", () => {
  it("runs once, only for a NEW online sale", () => {
    expect([...complete.matchAll(/await checkServerBeforeSale\(\)/g)]).toHaveLength(1);
    expect(complete).toContain("if (checkServerBeforeSale !== null && resumed === null && saleRequest === null) {");
  });

  it("comes after the offline branch and BEFORE the plan, the arm, the dispatch gate and the submit", () => {
    const check = at("await checkServerBeforeSale()");
    expect(at("const saved = await queueOfflineSale(")).toBeLessThan(check);
    for (const later of ["const plan = planSaleSubmission(", "const armed = await armOnlineSale(", "authorizeSaleDispatch?.({\n        requestId: plan.request.id", "await submitSale({"]) {
      expect(check, later).toBeLessThan(at(later));
    }
  });

  it("on silence it sends nothing: shows the message, tells the host, returns", () => {
    const block = complete.slice(at("if (!reachable) {"), at("const plan = planSaleSubmission("));
    expect(block).toContain("setSaleSaveError(SALE_SWITCHING_TO_OFFLINE_MESSAGE);");
    expect(block).toContain("offlineAutoSaveRef.current = true;");
    expect(block).toContain("onServerUnreachableBeforeSale?.() ?? false");
    expect(block).toContain("return;");
    for (const banned of ["submitSale", "armOnlineSale", "setUncertainSale", "setSaleRequest", "onSaleRejected"]) {
      expect(block, banned).not.toContain(banned);
    }
  });

  it("a throwing check counts as silence, never as permission", () => {
    const block = complete.slice(at("let reachable = false;"), at("if (!reachable) {"));
    expect(block).toContain("reachable = (await checkServerBeforeSale()) === true;");
    expect(block).toContain("catch {\n          reachable = false;");
  });

  it("the device host supplies it only while ONLINE, and silence moves the till offline", () => {
    expect(deviceApp).toContain("checkServerBeforeSale={offlineSaleAllowed ? null : checkServerBeforeSale}");
    expect(deviceApp).toContain("onServerUnreachableBeforeSale={offlineSaleAllowed ? null : handleServerUnreachableBeforeSale}");
    expect(deviceApp).toContain("const checkServerBeforeSale = checkDeviceServerReachable;");
    expect([...deviceApp.matchAll(/canReachServer: checkDeviceServerReachable/g)]).toHaveLength(2);
    const handler = deviceApp.slice(deviceApp.indexOf("const handleServerUnreachableBeforeSale"));
    expect(handler.slice(0, handler.indexOf("}, [enterOffline"))).toContain("void enterOfflineFromTransportFailure();");
  });

  it("v1.3.4: the till presses Pay itself once offline saving is available — through completeSale, never around it", () => {
    const event = runtime.slice(runtime.indexOf("const runOfflineAutoSave = useEffectEvent("));
    const body = event.slice(0, event.indexOf("});") + 3);
    expect(body).toContain("if (!offlineAutoSaveRef.current || queueOfflineSale === null || !checkoutOpen) {");
    expect(body).toContain("offlineAutoSaveRef.current = false;\n    void completeSale();");
    for (const banned of ["queueOfflineSale(", "submitSale", "armOnlineSale"]) {
      expect(body, banned).not.toContain(banned);
    }
    expect(runtime).toContain("runOfflineAutoSave();\n  }, [queueOfflineSale, offlineAutoSaveToken]);");
  });

  it("v1.3.4: every press, a closed checkout and the timeout disarm it", () => {
    expect(complete.slice(0, complete.indexOf("if (checkoutBlockedReason !== null)"))).toContain("offlineAutoSaveRef.current = false;");
    const close = runtime.slice(runtime.indexOf("function closeCheckout()"));
    expect(close.slice(0, close.indexOf("\n  }\n"))).toContain("offlineAutoSaveRef.current = false;");
    // The wait is the HOST's timer (the runtime tree may not hold timers).
    expect(deviceApp).toContain("setTimeout(() => resolve(false), OFFLINE_AUTO_SAVE_WAIT_MS);");
    expect(runtime).toContain("if (available !== true) giveUp();");
    expect(runtime).toContain("setSaleSaveError(SALE_SERVER_UNREACHABLE_MESSAGE);");
    expect(runtime).not.toContain("setTimeout");
  });
});
