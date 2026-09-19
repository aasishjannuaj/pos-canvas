// v1.3 CP2d — the DeviceApp daily register conversion, guarded at the source.
//
// Source guards, in the house style: they read the shipped files and assert
// WHERE behaviour lives and what it CANNOT do, which no unit test can. The
// rules being protected here are the ones the Control Room locked and which a
// later edit could quietly undo without failing anything else:
//
//   * startup stays locked, and a server-reported session never unlocks it;
//   * normal readiness never touches the legacy register RPCs or opening cash;
//   * the till never derives a business date from its own clock;
//   * midnight is freshness, and can only ever ADD;
//   * the offline authority rules are unchanged by any of it.
//
// EACH GUARD CARRIES ITS OWN NEGATIVE CONTROL. A source guard that would pass
// against the very code it forbids is decoration, so every rule below is
// re-checked against a mutated copy of the real file and must fail there.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(join(repoRoot, relative), "utf-8");

/** Source with comments stripped, so prose can neither satisfy nor trip a guard. */
function code(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n");
}

const DEVICE_APP = "components/device/DeviceApp.tsx";
const POS_GATES = "components/device/PosGates.tsx";
const app = code(read(DEVICE_APP));
const gates = code(read(POS_GATES));
const gateModule = code(read("lib/posGate.ts"));
const dailyModule = code(read("lib/dailyRegister.ts"));

/**
 * Applies one deliberate break to the real source and returns it.
 *
 * The anchor must be UNIQUE, for the reason CP2c's controls found the hard way:
 * a substring that occurs twice mutates whichever came first, and a control
 * that mutates the wrong line proves nothing at all.
 */
function broken(source: string, from: string, to: string): string {
  const occurrences = source.split(from).length - 1;

  expect(`anchor occurrences for ${JSON.stringify(from.slice(0, 48))}`).toBe(
    occurrences === 1 ? `anchor occurrences for ${JSON.stringify(from.slice(0, 48))}` : `${occurrences}`
  );

  return source.replace(from, to);
}

function filesUnder(relative: string): string[] {
  const out: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(join(repoRoot, dir))) {
      const child = join(dir, entry);

      if (statSync(join(repoRoot, child)).isDirectory()) {
        if (entry !== "node_modules" && !entry.startsWith(".")) walk(child);
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(child);
      }
    }
  };

  walk(relative);

  return out;
}

// ===========================================================================
// STARTUP AUTH
// ===========================================================================

describe("startup stays locked, whoever the server says is signed in", () => {
  /** The rule, as a function of source text. */
  const startupIsLocked = (source: string): boolean =>
    /export function applyStartupLock\(\): PosGateState \{\s*return EMPTY_POS_GATE_STATE;\s*\}/.test(source);

  it("1-2. a cold start holds nothing, so nothing observed can unlock it", () => {
    expect(startupIsLocked(gateModule)).toBe(true);
    expect(gateModule).toContain("employee: null,");
  });

  it("CONTROL: the guard fails if startup adopts a server-reported session", () => {
    const mutated = broken(
      gateModule,
      "export function applyStartupLock(): PosGateState {\n  return EMPTY_POS_GATE_STATE;\n}",
      "export function applyStartupLock(observed: { employee: EmployeeSession | null }): PosGateState {\n  return { ...EMPTY_POS_GATE_STATE, employee: observed.employee };\n}"
    );

    expect(startupIsLocked(mutated)).toBe(false);
  });

  it("3. only Employee ID + PIN populates the operator, and the card is unchanged", () => {
    expect(app).toContain("EmployeeLockCard");
    expect(app).toContain("handleEmployeeCodeLogin(employeeCode, pin)");
    expect(app).toContain("employeeLoginByCode(employeeCode, pin)");

    // The primary card still asks for exactly three digits and exactly four.
    expect(gates).toContain("maxLength={3}");
    expect(gates).toContain("maxLength={4}");
    expect(gates).toContain('inputMode="numeric"');
    expect(gates).not.toContain('type="number"');
  });

  it("33. the PIN is exactly four digits everywhere it is stated", () => {
    const session = code(read("lib/employeeSession.ts"));

    expect(session).toContain("/^[0-9]{4}$/");
    expect(session).toContain("EMPLOYEE_PIN_MAX_LENGTH = 4");
    expect(session).not.toContain("EMPLOYEE_PIN_MAX_LENGTH = 6");
  });

  it("the roster is not the cashier's way in", () => {
    // The lock card is what the employee gate renders. A roster-first login
    // would have to render a selector there instead.
    const overlay = app.slice(app.indexOf("const gateOverlay ="), app.indexOf("const activeOverlay ="));

    expect(overlay).toContain("EmployeeLockCard");
    expect(overlay).not.toContain("EmployeeSelector");
  });
});

// ===========================================================================
// NORMAL FLOW — NO REGISTER MANAGEMENT
// ===========================================================================

describe("the normal cashier flow has no register step at all", () => {
  const usesLegacyRegisters = (source: string): boolean =>
    /openRegisterSession|closeRegisterSession|fetchCurrentRegisterSession|openingCash|RegisterOpenPanel/.test(
      source
    );

  it("7-9, 56. DeviceApp calls none of the legacy register RPCs, and asks for no cash", () => {
    expect(usesLegacyRegisters(app)).toBe(false);
  });

  it("CONTROL: the guard fails if normal flow calls open_register_session", () => {
    const mutated = broken(
      app,
      "      const daily = await acquireDaily();\n      const revalidated = await readEmployeeSession();",
      "      const daily = await acquireDaily();\n      await openRegisterSession(crypto.randomUUID(), 0);\n      const revalidated = await readEmployeeSession();"
    );

    expect(usesLegacyRegisters(mutated)).toBe(true);
  });

  it("4. the day comes from ensure_daily_register_context, with zero arguments", () => {
    expect(app).toContain("ensureDailyRegisterContext");

    const wrapper = code(read("lib/daily.rpc.ts"));

    expect(wrapper).toContain('rpc(\n      "ensure_daily_register_context"\n    )');
    // No second argument: not a project, a device, a date, a zone or an amount.
    expect(wrapper).not.toMatch(/ensure_daily_register_context",\s*\{/);
    for (const forbidden of ["p_project_id", "p_paired_device_id", "p_business_date", "p_timezone", "p_opening_cash"]) {
      expect(`${forbidden}: ${wrapper.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
  });

  it("5-6. login ensures the day and then RE-READS the employee before unlocking", () => {
    const login = app.slice(
      app.indexOf("const handleEmployeeCodeLogin"),
      app.indexOf("const recoverDailyContext")
    );

    const ensure = login.indexOf("await acquireDaily()");
    const revalidate = login.indexOf("await readEmployeeSession()");
    const apply = login.indexOf("applyEmployeeAuthenticated(");

    expect(ensure).toBeGreaterThan(-1);
    expect(revalidate).toBeGreaterThan(ensure);
    expect(apply).toBeGreaterThan(revalidate);
    expect(login).toContain("revalidated,");
  });

  it("57. the legacy register contracts still exist for admin and rollback", () => {
    const rpc = code(read("lib/register.rpc.ts"));

    expect(rpc).toContain("open_register_session");
    expect(rpc).toContain("get_current_register_session");
    expect(rpc).toContain("close_register_session");
    // And the panel remains in source, simply unused by normal readiness.
    expect(gates).toContain("export function RegisterOpenPanel");
  });

  it("54-55. nothing converts, closes or mutates a legacy row", () => {
    for (const forbidden of ["closeRegisterSession", "closed_by_employee_id", "business_date ="]) {
      expect(`${forbidden}: ${app.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
  });
});

// ===========================================================================
// THE CLIENT CLOCK IS NOT AUTHORITY
// ===========================================================================

describe("no business date is ever derived on the device", () => {
  /** Every way a client could invent a calendar day. */
  const DERIVATIONS = [
    "toISOString().slice(0, 10)",
    "toISOString().slice(0,10)",
    "toLocaleDateString",
    "resolvedOptions().timeZone",
    "getTimezoneOffset",
    "toDateString",
  ];

  const derivesADate = (source: string): boolean =>
    DERIVATIONS.some((pattern) => source.includes(pattern));

  it("16. neither the host nor the pure module computes one", () => {
    expect(derivesADate(app)).toBe(false);
    expect(derivesADate(dailyModule)).toBe(false);
    expect(derivesADate(gateModule)).toBe(false);
  });

  it("CONTROL: the guard fails if the host reads the device's own timezone", () => {
    const mutated = broken(
      app,
      "  const acquireDaily = useCallback(async (): Promise<DailyAcquisition> => {",
      "  const acquireDaily = useCallback(async (): Promise<DailyAcquisition> => {\n    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;\n    void zone;"
    );

    expect(derivesADate(mutated)).toBe(true);
  });

  it("the only clock reading is for SCHEDULING, and it is named as such", () => {
    // Date.now() appears where a delay is computed and nowhere that decides a
    // day. The scheduler takes `nowMs` as an argument precisely so this is
    // checkable.
    expect(dailyModule).toContain("nowMs: number;");
    expect(dailyModule).not.toContain("Date.now()");
    expect(app).toContain("nowMs: Date.now()");
  });

  it("20-21. a missing business timezone is a setup state, never a local fallback", () => {
    expect(gateModule).toContain('setup: "business_timezone"');
    expect(app).toContain("BusinessTimezoneRequiredCard");
    // No picker, no default, no manual register escape hatch.
    expect(gates).not.toContain("America/");
    expect(gates).not.toContain("UTC");
  });

  it("CONTROL: the guard fails if the timezone state falls back to a manual register", () => {
    const mutated = broken(
      app,
      "        ) : posGate === \"timezone\" ? (",
      "        ) : posGate === \"timezone\" ? (\n          <RegisterOpenPanel employee={gate.employee!} busy={false} error={null} recovery={false} onOpen={() => {}} onAdoptCurrentRegister={() => {}} onSwitchEmployee={() => {}} />\n        ) : false ? ("
    );

    expect(/RegisterOpenPanel/.test(mutated)).toBe(true);
  });
});

// ===========================================================================
// MIDNIGHT IS FRESHNESS
// ===========================================================================

describe("midnight can only ever add", () => {
  const refresh = gateModule.slice(
    gateModule.indexOf("export function applyDailyRefresh"),
    gateModule.indexOf("export function applySaleRegisterAdoption")
  );

  const refreshCanLockTheTill = (source: string): boolean =>
    /applyStartupLock\(\)|EMPTY_POS_GATE_STATE/.test(source);

  it("25-28. a refresh never signs anyone out and never clears the till", () => {
    expect(refreshCanLockTheTill(refresh)).toBe(false);
    // It returns the state untouched when there is nobody signed in, and when
    // the server could not be reached.
    expect(refresh).toContain("return state;");
  });

  it("CONTROL: the guard fails if a refresh logs the employee out", () => {
    const mutated = broken(
      refresh,
      '    if (acquisition.reason === "unavailable") {',
      '    if (acquisition.reason === "unavailable") {\n      return applyStartupLock();\n    }\n    if (false) {'
    );

    expect(refreshCanLockTheTill(mutated)).toBe(true);
  });

  it("30-31. the timer is scheduled from the SERVER's closedAt, with a backoff", () => {
    expect(app).toContain("nextDailyRefreshDelayMs({");
    expect(app).toContain("closedAtMs: timestampMs(gate.daily.closedAt)");
    expect(app).toContain("consecutiveUnchanged: dailyUnchangedRef.current");
    expect(app).toContain("dailyUnchangedRef.current += 1");
  });

  it("the timer does not run while offline, so a queued midnight changes nothing", () => {
    const effect = app.slice(
      app.indexOf("    if (!gateDerivationAllowed || !gate.establishedOnline || gate.daily === null) {"),
      app.indexOf("document.addEventListener(\"visibilitychange\"")
    );

    expect(effect).toContain("gateDerivationAllowed");
    expect(effect).toContain("return;");
  });

  it("29. a refresh that finds a new day replaces the expectation without a login", () => {
    expect(refresh).toContain("withDaily(state.employee, state.daily, acquisition, state.recovery)");
    expect(refresh).not.toContain("employeeLoginByCode");
  });
});

// ===========================================================================
// OFFLINE
// ===========================================================================

describe("offline authority is unchanged by any of this", () => {
  const offlineGate = gateModule.slice(
    gateModule.indexOf("export function canCheckoutOffline"),
    gateModule.indexOf("export type OfflineAttributionClaims")
  );

  it("39, 43-44. checkout needs state established ONLINE in this app run", () => {
    expect(offlineGate).toContain("!state.establishedOnline");
    expect(offlineGate).toContain("state.employee === null");
    expect(offlineGate).toContain("state.daily === null");
  });

  it("CONTROL: the guard fails if establishment stops being required", () => {
    const mutated = broken(offlineGate, "    !state.establishedOnline ||", "    false ||");

    expect(mutated.includes("!state.establishedOnline")).toBe(false);
  });

  it("40-42. the RETAINED day is what a queued sale claims — nothing is invented", () => {
    const claims = gateModule.slice(
      gateModule.indexOf("export function buildOfflineClaims"),
      gateModule.indexOf("// ---------------------------------------------------------------------------\n// Stale-state handling")
    );

    expect(claims).toContain("state.daily?.registerSessionId ?? null");
    // No date arithmetic, no next-day id, no clock.
    expect(claims).not.toContain("Date");
    expect(claims).not.toContain("+ 1");
  });

  it("nothing about the operator is persisted, so a cold start holds nothing", () => {
    for (const forbidden of ["localStorage", "sessionStorage"]) {
      expect(`${forbidden} in posGate: ${gateModule.includes(forbidden)}`).toBe(
        `${forbidden} in posGate: false`
      );
      expect(`${forbidden} in dailyRegister: ${dailyModule.includes(forbidden)}`).toBe(
        `${forbidden} in dailyRegister: false`
      );
    }
  });

  it("67-68. the queue's own contract is untouched", () => {
    const queue = code(read("lib/saleQueue.ts"));

    expect(queue).toContain("registerSessionId");
    expect(queue).not.toContain("businessDate");
    expect(queue).not.toContain("ensure_daily_register_context");
  });
});

// ===========================================================================
// RECONNECT AND RESUME
// ===========================================================================

describe("reconnect and resume compare POS SESSION IDENTITY, never the person", () => {
  const reconnect = gateModule.slice(
    gateModule.indexOf("export function applyReconnectDerivation"),
    gateModule.indexOf("export function applyDailyRefresh")
  );

  const comparesSessionId = (source: string): boolean =>
    source.includes("employeeSessionId !== state.employee.employeeSessionId");

  it("33-36. the same person with a NEW session is not the same authority", () => {
    expect(comparesSessionId(reconnect)).toBe(true);
    expect(reconnect).toContain("return applyStartupLock();");
    // Never by employee id or display name.
    expect(reconnect).not.toContain("employeeId !==");
    expect(reconnect).not.toContain("displayName");
  });

  it("CONTROL: the guard fails if reconnect compares the employee instead", () => {
    const mutated = broken(
      reconnect,
      "    observed.employee.session.employeeSessionId !== state.employee.employeeSessionId",
      "    observed.employee.session.employeeId !== state.employee.employeeId"
    );

    expect(comparesSessionId(mutated)).toBe(false);
  });

  it("18, 32, 45. resuming reuses the same derivation rather than a second path", () => {
    expect(app).toContain('document.addEventListener("visibilitychange", onVisible)');
    expect(app).toContain("void deriveGateState();");
    // A till with nobody signed in has nothing to revalidate.
    expect(app).toContain("if (gateRef.current.employee === null) return;");
  });

  it("58-59. no platform forks the DAILY behaviour", () => {
    // Scoped to the daily machinery deliberately: DeviceApp legitimately knows
    // it is running in the Windows shell for update handling, and a guard that
    // forbade the whole file would be testing the wrong thing. What must never
    // fork is who the operator is and which business day it is.
    const dailyRegions = [
      app.slice(app.indexOf("const acquireDaily"), app.indexOf("const deriveGateState")),
      app.slice(app.indexOf("const handleEmployeeCodeLogin"), app.indexOf("const handleEmployeeLogout")),
      app.slice(
        app.indexOf("    if (!gateDerivationAllowed || !gate.establishedOnline || gate.daily === null) {"),
        app.indexOf("document.removeEventListener")
      ),
    ].join("\n");

    for (const forbidden of ["navigator.userAgent", "process.platform", "isAndroid", "isWindowsShell"]) {
      expect(`${forbidden}: ${dailyRegions.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }

    expect(dailyRegions).toContain("acquireDaily");
  });
});

// ===========================================================================
// SALE RECOVERY
// ===========================================================================

describe("a refused sale is never retried for the operator", () => {
  const sale = app.slice(
    app.indexOf("const completeSale: PosRuntimeCompleteSale"),
    app.indexOf("const completeSale: PosRuntimeCompleteSale") +
      app.slice(app.indexOf("const completeSale: PosRuntimeCompleteSale")).indexOf("\n  );") + 4
  );

  const autoRetries = (source: string): boolean =>
    /completeDeviceSaleV5\([\s\S]*completeDeviceSaleV5\(/.test(source);

  it("26, 48, 50. exactly one submission per attempt", () => {
    expect(sale.match(/completeDeviceSaleV5\(/g)).toHaveLength(1);
    expect(autoRetries(sale)).toBe(false);
  });

  it("CONTROL: the guard fails if a stale refusal resubmits the sale", () => {
    const mutated = broken(
      sale,
      "        void deriveGateState(\"observe\");\n\n        return result;",
      "        void deriveGateState(\"observe\");\n\n        return completeDeviceSaleV5({\n          paymentMethod: input.paymentMethod,\n          items: input.items,\n          saleRequestId: input.saleRequestId,\n          expectedEmployeePosSessionId: current.employee.employeeSessionId,\n          expectedRegisterSessionId: current.daily.registerSessionId,\n        });"
    );

    expect(autoRetries(mutated)).toBe(true);
  });

  it("47, 51. recovery re-establishes the DAY, and never through a legacy open", () => {
    const recovery = app.slice(
      app.indexOf("const recoverDailyContext"),
      app.indexOf("const handleEmployeeLogout")
    );

    expect(recovery).toContain("acquireDaily()");
    expect(recovery).toContain("applyExplicitDailyEstablished");
    expect(recovery).not.toContain("openRegisterSession");
  });

  it("17. the adopted register id comes from the COMPLETED sale, never from a guess", () => {
    expect(sale).toContain("shouldAdoptSaleRegisterId(gateRef.current.daily, stored)");
    expect(sale).toContain("result.receipt !== null");
    // Adoption sits AFTER the refusal branch has returned.
    expect(sale.indexOf("classifySaleAttributionFailure")).toBeLessThan(
      sale.indexOf("shouldAdoptSaleRegisterId")
    );
  });
});

// ===========================================================================
// ARCHITECTURE
// ===========================================================================

describe("one DeviceApp, and nothing template-specific", () => {
  it("58. the native entry mounts the shared DeviceApp", () => {
    const native = code(read("native-device/main.tsx"));

    expect(native).toContain("DeviceApp");
  });

  it("59-60. no template carries daily register behaviour", () => {
    const offenders = filesUnder("components/templates").filter((file) =>
      /ensure_daily_register_context|ensureDailyRegisterContext|DailyRegisterContext|applyDailyRefresh/.test(
        read(file)
      )
    );

    expect(offenders).toEqual([]);
  });

  it("60. PosRuntime knows nothing about business days", () => {
    const runtime = code(read("components/runtime/PosRuntime.tsx"));

    for (const forbidden of ["businessDate", "businessTimezone", "ensureDaily", "DailyRegisterContext"]) {
      expect(`${forbidden}: ${runtime.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
  });

  it("61. the owner/browser POS is untouched and stays on v3", () => {
    const owner = code(read("components/runtime/OwnerPosRuntime.tsx"));

    expect(owner).toContain("completeSaleOrderV3");
    for (const forbidden of ["ensureDailyRegisterContext", "DailyRegisterContext", "complete_sale_v5"]) {
      expect(`${forbidden}: ${owner.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
  });

  it("30, 62-65. CP2d added no migration and changed no server contract", () => {
    const migrations = readdirSync(join(repoRoot, "supabase/migrations")).filter((f) => f.endsWith(".sql"));

    // The newest migration is still CP2c's. CP2d is runtime only.
    expect(migrations.sort().at(-1)).toBe("20260922120000_daily_sale_attribution.sql");
  });
});
