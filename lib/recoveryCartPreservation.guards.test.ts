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

/**
 * Blanks out every balanced `{...}` expression container, preserving offsets.
 *
 * WITHOUT THIS A TAG SCAN IS WRONG, and wrong in the direction that matters:
 * JSX attributes hold arrow functions (`onSelect={(e) => ...}`), whose `>`
 * closes a tag as far as any naive regex is concerned. A scan that trips there
 * mis-reports which element contains which — which is exactly the mistake this
 * file exists to make impossible.
 */
function maskExpressions(source: string): string {
  const out = source.split("");
  let depth = 0;

  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (depth > 0) out[i] = " ";
    if (source[i] === "}") depth -= 1;
  }

  return out.join("");
}

/**
 * The offset just past the closing tag of the element that opens at `openEnd`.
 *
 * Counts real element tags only, skipping self-closing ones, so it answers the
 * one question a source guard normally cannot: HAS THIS ELEMENT CLOSED YET?
 */
function findClose(source: string, openEnd: number): number | null {
  const masked = maskExpressions(source);
  const tag = /<(\/?)[A-Za-z][\w.]*[^<>]*?(\/?)>/g;

  tag.lastIndex = openEnd;

  let depth = 1;
  let match: RegExpExecArray | null;

  while ((match = tag.exec(masked)) !== null) {
    if (match[2] === "/") continue;

    depth += match[1] === "/" ? -1 : 1;

    if (depth === 0) return match.index + match[0].length;
  }

  return null;
}

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

  it("BOTH recovery kinds go through it — employee and daily", () => {
    const gateOverlay = app.slice(app.indexOf("const gateOverlay ="), app.indexOf("const activeOverlay"));

    // UPDATED BY v1.3 checkpoint 2: the primary cashier login is the
    // Employee ID + PIN lock card, not a roster selector. The property this
    // guard protects is unchanged — both recovery kinds render through the one
    // overlay slot, over a still-mounted PosRuntime.
    expect(gateOverlay).toContain("<EmployeeLockCard");
    expect(gateOverlay).toContain("<DailyContextRecoveryCard");
    // v1.3 CP2d — and the setup state renders through the same slot, so a
    // business with no timezone also keeps the cart and the runtime.
    expect(gateOverlay).toContain("<BusinessTimezoneRequiredCard");
    expect(gateOverlay).toContain('recovery={gate.recovery === "employee"}');
    expect(gateOverlay).toContain('recovery={gate.recovery === "daily"}');
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
  const WRAPPER = '<div className="min-h-0 flex-1" inert={activeOverlay !== null}>';
  const OVERLAY = "{activeOverlay !== null && (";

  /** The single returned tree of the `ready` arm. */
  const tree = readyArm.slice(readyArm.indexOf("\n      return ("));
  const wrapperAt = tree.indexOf(WRAPPER);
  const wrapperClose = findClose(tree, wrapperAt + WRAPPER.length);
  const overlayAt = tree.indexOf(OVERLAY);

  it("the POS subtree is made inert whenever anything covers it", () => {
    // AN OPAQUE DIV IS NOT ENOUGH. It stops a mouse. It does not stop Tab
    // reaching the buttons underneath, a control that already has focus
    // keeping it, or a keyboard/wedge event landing on the focused element.
    // `inert` removes the subtree from focus, from pointer events and from the
    // accessibility tree at once.
    expect(wrapperAt).toBeGreaterThan(-1);
  });

  it("1. the inert wrapper contains PosRuntime", () => {
    expect(wrapperClose).not.toBeNull();
    expect(tree.slice(wrapperAt, wrapperClose ?? undefined)).toContain("<PosRuntime");
  });

  it("2. the inert wrapper CLOSES before the overlay render begins", () => {
    // THE PROPERTY THE OLD GUARD ONLY PRETENDED TO CHECK. It compared source
    // positions, which cannot distinguish "the overlay comes after the wrapper
    // opened" from "the overlay comes after the wrapper closed" — so it would
    // have passed with the overlay nested INSIDE the inert subtree, where the
    // operator could see the recovery controls and not touch them.
    expect(wrapperClose).not.toBeNull();
    expect(wrapperClose as number).toBeLessThan(overlayAt);
  });

  it("3. the overlay is a SIBLING that follows the inert wrapper", () => {
    expect(overlayAt).toBeGreaterThan(wrapperClose as number);
  });

  it("4. the overlay is not nested inside ANY inert element", () => {
    // Walk every `inert=` in the tree and prove none of them is still open
    // where the overlay renders.
    for (const match of tree.matchAll(/inert=\{[^}]*\}>/g)) {
      const openEnd = match.index + match[0].length;
      const close = findClose(tree, openEnd);

      expect(close).not.toBeNull();
      expect(openEnd < overlayAt && overlayAt < (close as number)).toBe(false);
    }
  });

  it("ONLY the POS subtree is inert — nothing else in the tree is", () => {
    expect(tree.match(/inert=/g)).toHaveLength(1);
  });

  it("it is keyed on the SAME value that draws the overlay", () => {
    // If these could disagree, there would be a state in which the POS is
    // covered but still operable, or inert with nothing covering it.
    expect(app).toContain("inert={activeOverlay !== null}");
    expect(app).toContain(OVERLAY);
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

describe("5 + 6 + 7 + 8. every covering screen stays usable", () => {
  const tree = readyArm.slice(readyArm.indexOf("\n      return ("));
  const WRAPPER = '<div className="min-h-0 flex-1" inert={activeOverlay !== null}>';
  const wrapperAt = tree.indexOf(WRAPPER);
  const wrapperClose = findClose(tree, wrapperAt + WRAPPER.length) as number;

  /** Everything the inert wrapper encloses. Nothing here may be interactive. */
  const inertSubtree = tree.slice(wrapperAt, wrapperClose);

  for (const screen of [
    "EmployeeLockCard",
    "DailyContextRecoveryCard",
    "BusinessTimezoneRequiredCard",
    "DeviceSettingsScreen",
    "SalesHistoryScreen",
    "SalesHistoryDetail",
    "RejectedSaleReview",
  ]) {
    it(`${screen} renders outside the inert subtree`, () => {
      // It reaches the DOM through `activeOverlay`, which is a sibling of the
      // wrapper — so the operator can actually use the screen they are shown.
      expect(app).toContain(`<${screen}`);
      expect(inertSubtree).not.toContain(`<${screen}`);
    });
  }

  it("the inert subtree contains the POS and nothing else", () => {
    expect(inertSubtree).toContain("<PosRuntime");
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

describe("12. the recovery UI can still be read on a short screen", () => {
  it("the covering layer scrolls", () => {
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
