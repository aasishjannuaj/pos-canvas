// Feature 25.6 P0-1 — the Windows release workflow must package a real POS.
//
// THE DEFECT THESE GUARD. windows-shell/runtime/ is gitignored build output, so
// a fresh CI checkout does not contain it. electron-builder's files glob lists
// "runtime/**/*", which matched nothing — and the workflow packaged an Electron
// installer with no POS inside. It installed, launched, failed to fetch
// app://poscanvas/index.html and sat on the offline page forever.
//
// Nothing caught it. The installer-size floor is 40 MB and Electron alone is
// ~95 MB, so an empty build sails past. This is the same shape as the Aug 21
// dead-on-arrival installer, and the same lesson: an artifact that only one
// developer's laptop can produce correctly is not a release process.
//
// These are SOURCE assertions on the workflow file, which is the only thing a
// node test can read — CI itself is what finally proves the build. The
// pre-package assertion inside the workflow is the real fail-closed gate; these
// exist so the step cannot be quietly deleted again.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

const WORKFLOW = ".github/workflows/windows-app.yml";
const ROOT_PKG = "package.json";
const SHELL_PKG = "windows-shell/package.json";
const VITE_CONFIG = "native-device/vite.config.mts";
const LAUNCHER = "native-device/build.mjs";

/** A leading NAME=value, which is POSIX shell syntax cmd.exe cannot run. */
const POSIX_INLINE_ENV = /^\s*[A-Za-z_][A-Za-z0-9_]*=/;

/** The workflow with comment lines stripped, so prose cannot satisfy a guard. */
function steps(): string {
  return read(WORKFLOW)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/**
 * Only the COMMANDS, never the prose around them.
 *
 * The first version of this file matched `npm run windows:runtime` anywhere in
 * the workflow — and the verify step's own error message contains that exact
 * string, so deleting the real step still passed. A negative control caught it.
 * That is the same failure this whole file exists to prevent: an assertion that
 * agrees with the text rather than with what runs.
 */
function commands(): string {
  const lines = read(WORKFLOW).split("\n");
  const out: string[] = [];
  let inRunBlock = false;
  let blockIndent = 0;

  for (const line of lines) {
    if (/^\s*#/.test(line)) continue;

    const inline = line.match(/^(\s*)run:\s*(\S.*)$/);

    if (inline) {
      inRunBlock = false;
      out.push(inline[2].trim());
      continue;
    }

    const block = line.match(/^(\s*)run:\s*[|>][-+]?\s*$/);

    if (block) {
      inRunBlock = true;
      blockIndent = block[1].length;
      continue;
    }

    if (inRunBlock) {
      if (line.trim() !== "" && line.search(/\S/) <= blockIndent) inRunBlock = false;
      else continue; // block-scalar body is script text, not a command name
    }
  }

  return out.join("\n");
}

const at = (needle: string) => steps().indexOf(needle);
const runsAt = (needle: string) => commands().indexOf(needle);

describe("CI builds the device runtime before packaging", () => {
  it("runs the root runtime build as an actual command", () => {
    // THE NEGATIVE CONTROL. Removing the step must fail here — and it is
    // matched against the run: commands, not the whole file.
    expect(commands()).toContain("npm run windows:runtime");
  });

  it("installs the ROOT dependencies, which own that build", () => {
    const source = steps();
    const install = source.indexOf("- name: Install root dependencies");

    // The job defaults to working-directory: windows-shell, so a root step has
    // to say so explicitly or npm ci installs the wrong project entirely.
    expect(install).toBeGreaterThan(-1);
    expect(source.slice(install, install + 200)).toContain("working-directory: .");
    expect(source.slice(install, install + 200)).toContain("npm ci");
    expect(install).toBeLessThan(at("- name: Build the packaged device runtime"));
  });

  it("the runtime step runs from the repository root", () => {
    const source = steps();
    const step = source.indexOf("- name: Build the packaged device runtime");

    expect(step).toBeGreaterThan(-1);
    expect(source.slice(step, step + 200)).toContain("working-directory: .");
  });

  it("builds the runtime BEFORE electron-builder packages it", () => {
    const runtime = runsAt("npm run windows:runtime");
    const packageStep = runsAt("npm run build:windows");

    expect(runtime).toBeGreaterThan(-1);
    expect(packageStep).toBeGreaterThan(-1);
    expect(runtime).toBeLessThan(packageStep);
  });

  it("asserts the runtime exists, and does so before packaging", () => {
    const source = steps();
    const assertion = source.indexOf("windows-shell/runtime/index.html");

    expect(assertion).toBeGreaterThan(-1);
    expect(assertion).toBeLessThan(at("npm run build:windows"));
    // Fails the job rather than warning.
    expect(source.slice(assertion, assertion + 900)).toContain("exit 1");
  });

  it("caches both lockfiles, since two npm projects are installed", () => {
    const source = steps();

    expect(source).toContain("package-lock.json");
    expect(source).toContain("windows-shell/package-lock.json");
  });
});

describe("the runtime build gets what it needs, and nothing more", () => {
  it("supplies both public values the vite config reads", () => {
    const source = steps();

    for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
      expect(`workflow provides ${name}`).toBe(`workflow provides ${name}`);
      expect(source).toContain(name);
    }
  });

  it("reads them from repository configuration, never from a literal", () => {
    const source = steps();

    expect(source).toContain("vars.NEXT_PUBLIC_SUPABASE_URL");
    expect(source).toContain("vars.NEXT_PUBLIC_SUPABASE_ANON_KEY");
    // A JWT or a supabase.co host written into the workflow would be a
    // credential-shaped literal in tracked source.
    expect(source).not.toMatch(/eyJhbGciOi/);
    expect(source).not.toMatch(/[a-z]{20}\.supabase\.co/);
  });

  it("never hands a service-role credential to a client build", () => {
    const source = steps();

    // No env: block anywhere in this job may reference one. The build worker
    // legitimately uses SUPABASE_SERVICE_ROLE_KEY; this job must not.
    for (const line of source.split("\n")) {
      if (/\$\{\{\s*(secrets|vars)\./.test(line)) {
        expect(`workflow input: ${line.trim()}`).not.toContain("SERVICE_ROLE");
      }
    }
  });

  it("checks the built bundle for a forbidden server credential", () => {
    const source = steps();

    expect(source).toContain("service_role");
    expect(source).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});

describe("packaging identity is unchanged by the fix", () => {
  it("appId, productName and installer name are untouched", () => {
    const shell = JSON.parse(read(SHELL_PKG));

    expect(shell.build.appId).toBe("com.poscanvas.app");
    expect(shell.build.productName).toBe("POS Canvas");
    expect(shell.build.win.artifactName).toBe("POS-Canvas-Windows-v${version}.${ext}");
  });

  it("the installer is still unsigned", () => {
    const shell = JSON.parse(read(SHELL_PKG));
    const win = shell.build.win as Record<string, unknown>;

    for (const key of Object.keys(win)) {
      expect(key.toLowerCase()).not.toContain("cert");
      expect(key.toLowerCase()).not.toContain("sign");
    }
  });

  it("the runtime script still writes where electron-builder looks", () => {
    const root = JSON.parse(read(ROOT_PKG));
    const shell = JSON.parse(read(SHELL_PKG));

    expect(root.scripts["windows:runtime"]).toContain("windows-shell/runtime");
    expect(shell.build.files).toContain("runtime/**/*");
  });

  it("the artifact upload still runs, and still fails on no files", () => {
    const source = steps();

    expect(source).toContain("actions/upload-artifact@v4");
    expect(source).toContain("if-no-files-found: error");
  });
});

// ---------------------------------------------------------------------------
// Feature 25.6 P0-1, second failure — the scripts must run on Windows
//
// The first real windows-latest run died before packaging:
//
//   'POS_CANVAS_DEVICE_OUT_DIR' is not recognized as an internal or external
//   command, operable program or batch file.
//
// npm runs scripts through cmd.exe on Windows, and cmd has no leading
// NAME=value assignment — it tries to EXECUTE that token. The fail-closed step
// did its job and stopped the build; these guards stop the syntax coming back.
// ---------------------------------------------------------------------------

describe("the runtime scripts run on Windows as well as macOS", () => {
  it("no root script starts with a POSIX inline env assignment", () => {
    // THE NEGATIVE CONTROL. Reintroducing `NAME=value command` must fail here.
    const root = JSON.parse(read(ROOT_PKG));

    for (const [name, command] of Object.entries(root.scripts as Record<string, string>)) {
      expect(`${name}: ${command}`).toBe(`${name}: ${command}`);
      expect(POSIX_INLINE_ENV.test(command)).toBe(false);
    }
  });

  it("both runtime scripts go through the Node launcher", () => {
    const root = JSON.parse(read(ROOT_PKG));

    // `node <file>` is a program on PATH plus arguments, which cmd.exe and any
    // POSIX shell parse identically. There is nothing left to quote wrongly.
    expect(root.scripts["windows:runtime"]).toBe("node native-device/build.mjs windows-shell/runtime");
    expect(root.scripts["android:runtime"]).toBe("node native-device/build.mjs");
  });

  it("the launcher sets the variable itself, from an argument", () => {
    const launcher = read(LAUNCHER);

    expect(launcher).toContain("process.env.POS_CANVAS_DEVICE_OUT_DIR = requestedOutDir");
    expect(launcher).toContain("process.argv[2]");
    // Vite's Node API, so no shell is spawned on any platform.
    expect(launcher).toContain('import { build } from "vite"');
    expect(launcher).not.toContain("execSync");
    expect(launcher).not.toContain("spawn");
  });

  it("a failed runtime build exits non-zero, so CI stops", () => {
    expect(read(LAUNCHER)).toContain("process.exit(1)");
  });

  it("omitting the argument leaves the Android default intact", () => {
    const launcher = read(LAUNCHER);
    const config = read(VITE_CONFIG);

    // The launcher only sets the variable when given one...
    expect(launcher).toContain("requestedOutDir !== undefined");
    // ...and the config's fallback is still the Android shell's webDir.
    expect(config).toContain('return resolve(repoRoot, "android-shell/www");');
  });

  it("the workflow still calls the npm script, not a shell workaround", () => {
    const runtime = commands();

    expect(runtime).toContain("npm run windows:runtime");
    // A PowerShell-only $env: assignment in the workflow would leave the npm
    // script itself broken for everyone building on Windows locally.
    expect(runtime).not.toContain("$env:POS_CANVAS_DEVICE_OUT_DIR");
  });
});

describe("the out-dir containment check is separator-agnostic", () => {
  it("does not compare against a hardcoded POSIX separator", () => {
    // Comments stripped: the config now DESCRIBES the old expression in prose,
    // and a guard that reads prose is the trap this file keeps re-learning.
    const config = read(VITE_CONFIG)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    // The old check was a POSIX assumption hidden inside a security check: on
    // Windows the resolved path uses backslashes, so it rejected a directory
    // plainly inside the repository.
    expect(config).not.toContain("startsWith(`${repoRoot}/`)");
  });

  it("uses relative()/isAbsolute(), which answer the real question", () => {
    const config = read(VITE_CONFIG);

    expect(config).toContain("const inside = relative(repoRoot, absolute);");
    expect(config).toContain('inside === "" || inside.startsWith("..") || isAbsolute(inside)');
    expect(config).toContain('import { dirname, isAbsolute, relative, resolve } from "node:path";');
  });

  it("still refuses to write outside the repository", () => {
    // The guard exists so a mistyped variable fails instead of scattering a POS
    // across the filesystem. Weakening it must not be how Windows gets fixed.
    expect(read(VITE_CONFIG)).toContain(
      "POS_CANVAS_DEVICE_OUT_DIR must resolve inside the repository"
    );
  });
});
