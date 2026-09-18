// v1.3 Feature 1B-RUNTIME correction 4 — the cart survives recovery.
//
// THE DEFECT, FOUND ON STAGING, NOT IN A TEST. A real sale was refused with
// "The signed-in employee changed" — which the runtime handled perfectly: one
// v5 call, no order, no retry, no silent adoption of the employee the server
// now reported. Then the employee gate replaced the tree, React unmounted
// PosRuntime, and `const [cart, setCart] = useState([])` went with it. After
// recovering, the operator faced an empty cart and had to re-ring the order
// they had just been told to retry deliberately.
//
// The codebase had already learned this once. Feature 25.3 says so at the
// `overlay` definition: the till screens "used to `return` a different tree,
// which unmounted PosRuntime — and the cart is useState INSIDE PosRuntime, so
// opening a screen threw away whatever the cashier had rung up." The 1B gates
// reintroduced exactly that shape, so the fix is to join that slot rather than
// invent a second one.
//
// WHY THESE ARE SOURCE GUARDS. The property is structural: it is about which
// React subtree survives a state change, and which subtree can be interacted
// with. The house convention has no React DOM testing, and a unit test on pure
// state could not see an unmount if it happened. These read the shipped file
// and assert the shape that makes the unmount impossible.
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
const POS_RUNTIME = "components/runtime/PosRuntime.tsx";

const app = code(read(DEVICE_APP));
const runtime = code(read(POS_RUNTIME));

/** The `case "ready":` arm, where the POS and every covering layer are decided. */
const readyArm = app.slice(app.indexOf('case "ready": {'));

describe("1 + 2. a refusal cannot unmount the runtime", () => {
  it("the gates are a VALUE, not an early return", () => {
    // The defect in one line: `if (...) { return <Gate/> }` replaced the tree.
    expect(app).toContain("const gateOverlay =");
    expect(readyArm).not.toMatch(/if\s*\(!offlineMode\s*&&\s*posGate\s*!==\s*"pos"\)/);
  });

  it("the ready arm returns exactly one tree, and PosRuntime is inside it", () => {
    // One `return (` in the arm means there is no branch that renders a
    // different subtree — so nothing a refusal does can unmount the runtime.
    const returns = readyArm.match(/\n {6}return \(/g) ?? [];

    expect(returns).toHaveLength(1);
    expect(readyArm.slice(readyArm.indexOf("\n      return ("))).toContain("<PosRuntime");
  });

  it("the gates render through the same overlay slot Feature 25.3 established", () => {
    expect(app).toContain("const activeOverlay = gateOverlay ?? overlay;");
    expect(app).toContain('<div className="fixed inset-0 z-30 overflow-y-auto bg-neutral-50">{activeOverlay}</div>');
  });

  it("BOTH recovery kinds go through it — employee and register", () => {
    const gateOverlay = app.slice(app.indexOf("const gateOverlay ="), app.indexOf("const activeOverlay"));

    expect(gateOverlay).toContain("<EmployeeSelector");
    expect(gateOverlay).toContain("<EmployeePinEntry");
    expect(gateOverlay).toContain("<RegisterOpenPanel");
    expect(gateOverlay).toContain('recovery={gate.recovery === "employee"}');
    expect(gateOverlay).toContain('recovery={gate.recovery === "register"}');
  });
});

describe("3. the recovery surface sits over the mounted runtime", () => {
  it("the overlay is rendered as a sibling of the POS, not in its place", () => {
    const tree = readyArm.slice(readyArm.indexOf("\n      return ("));
    const pos = tree.indexOf("<PosRuntime");
    const cover = tree.indexOf("{activeOverlay !== null && (");

    expect(pos).toBeGreaterThan(-1);
    expect(cover).toBeGreaterThan(pos);
  });

  it("it covers the whole viewport and is opaque", () => {
    expect(app).toContain("fixed inset-0 z-30");
    expect(app).toContain("bg-neutral-50");
  });
});

describe("4 + 5 + 6. the covered POS is truly non-interactive", () => {
  const wrapper = '<div className="min-h-0 flex-1" inert={activeOverlay !== null}>';

  it("the POS subtree is made inert whenever anything covers it", () => {
    // AN OPAQUE DIV IS NOT ENOUGH. It stops a mouse. It does not stop Tab
    // reaching the buttons underneath, a control that already has focus
    // keeping it, or a keyboard/wedge event landing on the focused element.
    // `inert` removes the subtree from focus, from pointer events and from the
    // accessibility tree at once.
    expect(app).toContain(wrapper);
  });

  it("the inert wrapper is the one that contains PosRuntime", () => {
    const fromWrapper = app.slice(app.indexOf(wrapper));

    expect(fromWrapper.slice(0, fromWrapper.indexOf("</div>"))).toContain("<PosRuntime");
  });

  it("it is keyed on the SAME value that draws the overlay", () => {
    // If these could disagree, there would be a state in which the POS is
    // covered but still operable, or inert with nothing covering it.
    expect(app).toContain("inert={activeOverlay !== null}");
    expect(app).toContain("{activeOverlay !== null && (");
  });

  it("the runtime has no global listener that could bypass the boundary", () => {
    // The audit behind this guard: the ONLY document/window listener in the
    // runtime tree is `beforeunload`, which warns about losing a cart and
    // cannot mutate one. There is no keyboard handler, no shortcut, no
    // barcode/wedge listener and no focus() call to escape `inert` — and
    // barcode is out of scope for this lane, so none may appear here.
    const listeners = runtime.match(/addEventListener\((["'])(\w+)\1/g) ?? [];

    expect(listeners).toEqual(['addEventListener("beforeunload"']);

    for (const banned of ["keydown", "keypress", "keyup", "document.addEventListener", ".focus()"]) {
      expect(`${POS_RUNTIME}: ${banned}`).toBe(`${POS_RUNTIME}: ${banned}`);
      expect(runtime).not.toContain(banned);
    }
  });

  it("no template introduces one either", () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];

      for (const entry of readdirSync(join(repoRoot, dir))) {
        const child = join(dir, entry);

        if (statSync(join(repoRoot, child)).isDirectory()) out.push(...walk(child));
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(child);
      }

      return out;
    };

    for (const file of [...walk("components/editor/pos-layouts"), ...walk("components/runtime")]) {
      const source = code(read(file));

      for (const banned of ["addEventListener(\"key", "document.addEventListener", "barcode", "wedge"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });
});

describe("7. checkout cannot be submitted while a gate is pending", () => {
  it("the host reports a pending gate as a blocked checkout", () => {
    expect(app).toContain("describePosGateBlock(gate)");
    expect(app).toContain("checkoutBlockedReason={");
  });

  it("that reason is the runtime's FIRST statement in completeSale", () => {
    // The innermost fence, and the one that does not depend on the UI: it is
    // ahead of planSaleSubmission, submitSale and the durable enqueue, so no
    // sale RPC is called, no request id minted and no record written.
    const complete = runtime.slice(runtime.indexOf("async function completeSale()"));
    const guard = complete.indexOf("if (checkoutBlockedReason !== null)");

    expect(guard).toBeGreaterThan(-1);
    expect(complete.slice(0, guard)).not.toContain("submitSale");
    expect(complete.slice(0, guard)).not.toContain("planSaleSubmission");
    expect(complete.slice(0, guard)).not.toContain("queueOfflineSale");
  });

  it("offline, an attribution block is reported as itself", () => {
    // It used to fall through to "storage_unavailable", telling an operator
    // the disk had failed when Policy 1 was what had stopped the sale.
    expect(app).toContain("offlineAttribution.message");
  });
});

describe("12. the recovery UI itself stays usable", () => {
  it("the overlay is outside the inert subtree", () => {
    // Trivially true by placement, and worth pinning: an `inert` that wrapped
    // the overlay too would gate the operator out of their own recovery.
    const wrapperStart = app.indexOf('<div className="min-h-0 flex-1" inert=');
    const wrapperEnd = app.indexOf("{activeOverlay !== null && (");

    expect(wrapperStart).toBeLessThan(wrapperEnd);
    expect(app.slice(wrapperStart, wrapperEnd)).not.toContain("{activeOverlay}");
  });

  it("it can scroll on a short screen", () => {
    expect(app).toContain("overflow-y-auto");
  });
});

describe("13 + 14. the boundary did not leak into the runtime or a template", () => {
  it("PosRuntime knows nothing about gates, recovery or inert", () => {
    for (const banned of ["gateOverlay", "activeOverlay", "posGate", "recovery", "inert"]) {
      expect(`${POS_RUNTIME}: ${banned}`).toBe(`${POS_RUNTIME}: ${banned}`);
      expect(runtime).not.toContain(banned);
    }
  });

  it("PosRuntime still owns its cart, and still takes its sale by injection", () => {
    // The fix deliberately did NOT lift the cart into DeviceApp. Keeping the
    // instance mounted is what preserves it; moving ownership would have been a
    // redesign, and an unnecessary one.
    expect(runtime).toContain("const [cart, setCart] = useState<CartItem[]>([])");
    expect(runtime).toContain("submitSale: PosRuntimeCompleteSale");
    expect(app).not.toContain("setCart(");
  });

  it("no template implements recovery", () => {
    const walk = (dir: string): string[] => {
      const out: string[] = [];

      for (const entry of readdirSync(join(repoRoot, dir))) {
        const child = join(dir, entry);

        if (statSync(join(repoRoot, child)).isDirectory()) out.push(...walk(child));
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(child);
      }

      return out;
    };

    for (const file of walk("components/editor/pos-layouts")) {
      const source = code(read(file));

      for (const banned of ["gateOverlay", "activeOverlay", "recovery", "EmployeeSelector"]) {
        expect(`${file}: ${banned}`).toBe(`${file}: ${banned}`);
        expect(source).not.toContain(banned);
      }
    }
  });
});

describe("11 + 15. the guarantees this correction must not have weakened", () => {
  it("still exactly one sale attempt per refusal — no silent retry", () => {
    const callback = app.slice(app.indexOf("const completeSale"), app.indexOf("const handleSaleRejected"));

    expect(callback.match(/completeDeviceSaleV5\(/g)).toHaveLength(1);
    expect(callback).toContain('deriveGateState("observe")');
  });

  it("offline checkout is still gated by canCheckoutOffline, unchanged", () => {
    expect(app).toContain("canCheckoutOffline(gateRef.current)");
    expect(app).toContain("canCheckoutOffline(gate)");

    // The rule itself still refuses while a recovery is pending.
    expect(code(read("lib/posGate.ts"))).toContain("state.recovery !== null ||");
  });

  it("cart preservation did NOT become authority preservation", () => {
    // The gate state is still in memory only, and the correction touched the
    // rendering, not the rules.
    const gateRegion = app.slice(app.indexOf("const [gate, setGate]"), app.indexOf("const loadRoster"));

    expect(gateRegion).not.toContain("localStorage");
    expect(gateRegion).not.toContain("sessionStorage");
  });
});
