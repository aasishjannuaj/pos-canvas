// Feature 25.4 — structural guards for the fresh-install startup path.
//
// The defect this feature fixes was not a wrong computation. The classification
// was correct and the branch that needed it simply did not read it. That is a
// WIRING fault, and the assertion that catches a wiring fault is one that reads
// the wiring — vitest runs in the node environment here, with no DOM harness.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const APP = "components/device/DeviceApp.tsx";
const RPC = "lib/device.rpc.ts";
const MODEL = "lib/deviceSession.ts";
const MAP = "lib/deviceStartupError.ts";

/** The cold start, from the no-persisted-user branch to the end of it. */
function freshInstallBranch(): string {
  const app = code(read(APP));
  const start = app.indexOf("if (persistedUserId === null) {");

  expect(start, "the fresh-install branch moved or was renamed").toBeGreaterThan(-1);

  return app.slice(start, app.indexOf("await openOfflineOrFail("));
}

describe("the fresh-install branch consumes the classification", () => {
  it("no longer forces offline for every failure", () => {
    // THE NEGATIVE CONTROL FOR THIS FEATURE. Reintroducing the old line must
    // fail here, whatever else is true of the file.
    expect(freshInstallBranch()).not.toContain('createDeviceError("offline")');
  });

  it("maps the classified failure instead", () => {
    const branch = freshInstallBranch();

    expect(branch).toContain("createDeviceError(classifyStartupFailure(failure))");
  });

  it("reads the failure the classifier actually produced", () => {
    // Scoped to resolveDeviceState: openOfflineOrFail also consumes the mapping
    // and is defined earlier in the file, so a whole-file search would compare
    // the wrong two positions.
    const app = code(read(APP));
    const resolve = app.slice(app.indexOf("const resolveDeviceState = useCallback("));
    const computed = resolve.indexOf("session.failure ?? (existing.ok ? undefined : existing.failure)");
    const consumed = resolve.indexOf("classifyStartupFailure(failure)");

    expect(computed).toBeGreaterThan(-1);
    expect(consumed).toBeGreaterThan(-1);
    // Computed above, consumed below: the value cannot be a different one.
    expect(computed).toBeLessThan(consumed);
  });

  it("keeps the decision in a pure module, not in the component", () => {
    const app = code(read(APP));

    expect(app).toContain('from "@/lib/deviceStartupError"');
    // No inlined re-derivation: one place decides, and a test can execute it.
    expect(app).not.toContain('failure === "transport" ?');
    expect(app).not.toContain('failure === "server_rejected"');
  });
});

describe("only positive transport evidence says No connection", () => {
  it("the mapping tests transport and nothing else", () => {
    const map = code(read(MAP));

    expect(map).toContain('failure === "transport" ? "offline" : "startup_failed"');
  });

  it("the mapping never matches a vendor string or code", () => {
    const map = code(read(MAP)).toLowerCase();

    for (const brittle of [
      "anonymous_provider_disabled",
      "anonymous sign-ins",
      "supabase",
      "postgrest",
      "provider",
      "status ===",
      "422",
      "401",
    ]) {
      expect(`${brittle} must not steer the mapping`).toBe(`${brittle} must not steer the mapping`);
      expect(map).not.toContain(brittle);
    }
  });

  it("the classifier decides, and the UI does not re-decide by string", () => {
    const app = code(read(APP));

    // A title chosen by inspecting the message text would put the classification
    // back in the component, which is how it drifted the first time.
    expect(app).toContain("DEVICE_ERROR_TITLES[state.kind]");
    expect(app).not.toContain('state.kind === "offline" ?');
    expect(app).not.toContain("state.message.includes(");
  });
});

describe("auth failures are classified by the auth predicate", () => {
  it("anonymous sign-in uses classifyAuthFailure, like the session read", () => {
    const rpc = code(read(RPC));
    const start = rpc.indexOf("export async function signInDeviceAnonymously(");
    // To the NEXT export, so the slice is this function and nothing after it.
    const signIn = rpc.slice(start, rpc.indexOf("\nexport ", start + 1));

    expect(start).toBeGreaterThan(-1);

    expect(signIn).toContain("classifyAuthFailure(error)");
    expect(signIn).toContain("classifyAuthFailure(thrown)");
    expect(signIn).not.toContain("classifyDeviceFailure(");
  });

  it("classifyAuthFailure still consults auth-js first", () => {
    expect(code(read(RPC))).toContain(
      'isAuthRetryableFetchError(error) ? "transport" : classifyDeviceFailure(error)'
    );
  });
});

describe("the operator is never shown a mechanism", () => {
  it("no copy names a vendor, a status or an internal", () => {
    const model = code(read(MODEL));
    const copy = model.slice(
      model.indexOf("export const DEVICE_ERROR_TITLES"),
      model.indexOf("export function createDeviceError")
    );

    for (const leak of ["supabase", "postgrest", "provider", "anonymous", "http", "jwt", "token", "401", "422"]) {
      expect(`copy must not name ${leak}`).toBe(`copy must not name ${leak}`);
      expect(copy.toLowerCase()).not.toContain(leak);
    }
  });

  it("the error state carries fixed copy, never a server message", () => {
    const model = code(read(MODEL));

    expect(model).toContain("message: DEVICE_ERROR_MESSAGES[kind]");
    // The only way to build one, so no call site can smuggle text in.
    expect(model).toContain("export function createDeviceError(kind: DeviceErrorKind): DeviceState");
  });

  it("startup_failed does not claim the service was reached", () => {
    const model = code(read(MODEL));

    // Both a refused reply and an unprovable failure land on this copy; only
    // the first of those actually reached anything.
    expect(model).toContain(
      '"POS Canvas couldn\'t start this device. Try again, and contact support if the problem continues."'
    );
  });
});

describe("retry runs the same cold start, once", () => {
  it("the error screen retries by re-resolving", () => {
    const app = code(read(APP));
    const errorCase = app.slice(app.indexOf('case "error":'), app.indexOf('case "reconnect_required":'));

    expect(errorCase).toContain("onRetry={() => void resolveDeviceState()}");
  });

  it("a refused start arms no timer and no backoff", () => {
    const app = code(read(APP));
    const errorCase = app.slice(app.indexOf('case "error":'), app.indexOf('case "reconnect_required":'));

    for (const looping of ["setInterval", "setTimeout", "backoff", "scheduleRetry", "useEffect"]) {
      expect(errorCase).not.toContain(looping);
    }
  });

  it("the cold start is still single-flighted", () => {
    const app = code(read(APP));

    // A held press, or a press during a slow sign-in, must not start a second
    // resolve — that is what would mint anonymous users in a loop.
    expect(app).toContain("if (resolving.current) {");
    expect(app).toContain("resolving.current = true;");
  });
});

/** openOfflineOrFail, the persisted-session gate, on its own. */
function offlineGate(): string {
  const app = code(read(APP));
  const start = app.indexOf("const openOfflineOrFail = useCallback(");

  expect(start, "openOfflineOrFail moved or was renamed").toBeGreaterThan(-1);

  return app.slice(start, app.indexOf("const resolveDeviceState = useCallback("));
}

describe("the persisted-session refusal is classified too", () => {
  it("no longer forces offline as the terminal failure", () => {
    // THE NEGATIVE CONTROL FOR THE PERSISTED PATH. Reintroducing the
    // unconditional terminal error must fail here.
    expect(offlineGate()).not.toContain('createDeviceError("offline")');
  });

  it("maps the classified failure instead", () => {
    expect(offlineGate()).toContain("createDeviceError(classifyStartupFailure(failure))");
  });

  it("uses the SAME authority as fresh install, not a second one", () => {
    const app = code(read(APP));
    const calls = app.match(/classifyStartupFailure\(/g) ?? [];

    // Exactly two call sites — the two terminal failures — and one import.
    expect(calls).toHaveLength(2);
    expect(app).toContain('from "@/lib/deviceStartupError"');
    // No parallel mapping anywhere in the component.
    expect(app).not.toContain('=== "server_rejected" ? ');
    expect(app).not.toContain("classifyPersistedStartFailure");
  });
});

describe("the persisted-session paths are untouched", () => {
  it("a cached start is still gated on transport alone", () => {
    const offlineOrFail = offlineGate();

    // 24.5A's rule, unchanged: anything that ANSWERED cannot unlock the cache.
    // The copy decision sits AFTER this gate and cannot widen it.
    expect(offlineOrFail).toContain("!permitsOfflineFallback(failure)");
    expect(offlineOrFail).toContain('setState({ status: "reconnect_required", reason: fallback.reason })');
  });

  it("the validator still runs, and still decides the cached start", () => {
    const offlineOrFail = offlineGate();

    // Every lease, digest and identity check lives behind loadOfflineFallback.
    expect(offlineOrFail).toContain("await loadOfflineFallback({");
    expect(offlineOrFail).toContain("now: Date.now()");
    expect(offlineOrFail).toContain("sessionUserId,");
    expect(offlineOrFail).toContain('status: "ready"');
    expect(offlineOrFail).toContain("offline: fallback.offline");
    // Nothing about the copy change may short-circuit the validator.
    expect(offlineOrFail.indexOf("createDeviceError(classifyStartupFailure(failure))")).toBeLessThan(
      offlineOrFail.indexOf("await loadOfflineFallback({")
    );
  });

  it("the refusal happens before the cache is read, exactly as before", () => {
    const offlineOrFail = offlineGate();
    const gate = offlineOrFail.indexOf("if (failure === undefined || !permitsOfflineFallback(failure)) {");

    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(offlineOrFail.indexOf("await loadOfflineFallback({"));
  });

  it("reconnect_required, revoked and unpaired still have their own states", () => {
    const app = code(read(APP));

    expect(app).toContain('case "reconnect_required":');
    expect(app).toContain('case "revoked":');
    expect(app).toContain('case "unpaired":');
    // None of them was folded into the new error kind.
    expect(app).not.toContain('createDeviceError("startup_failed")');
  });

  it("an unreadable pairing reply still maps to unavailable", () => {
    expect(code(read(MODEL))).toContain('return createDeviceError("unavailable");');
  });
});
