// Feature 25.7 — the release version, in every place that carries one.
//
// WHY THIS FILE EXISTS. A release version is not stored once. It lives in
// build.gradle, in windows-shell/package.json, in the CI artifact name, and —
// after publication — in two release pointers. The 25.6 audit found the CI
// artifact name hardcoded and NOT derived from anything, so bumping the shell's
// package.json alone would have produced POS-Canvas-Windows-v1.1.0.exe inside an
// artifact still called pos-canvas-windows-v1.0.0. Nothing would have failed;
// the names would simply have disagreed.
//
// These guards keep the four in lockstep, and keep the two that must lag
// deliberately behind until the artifacts actually exist.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CURRENT_ANDROID_RELEASE } from "@/lib/androidRelease";
import { CURRENT_WINDOWS_RELEASE } from "@/lib/windowsRelease";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(repoRoot, file), "utf-8");

const GRADLE = "android/app/build.gradle";
const SHELL_PKG = "windows-shell/package.json";
const ROOT_PKG = "package.json";
const WORKFLOW = ".github/workflows/windows-app.yml";

const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Numeric ordering for the plain `x.y.z` versions this file deals with.
 *
 * Deliberately not a general semver implementation: SEMVER above already
 * rejects anything carrying a pre-release or build suffix, so three integers is
 * the whole problem. Returns <0 when `a` is older, 0 when equal, >0 when newer.
 */
function compareSemver(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);

  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }

  return 0;
}

/** versionName from build.gradle — the canonical Android label. */
function androidVersionName(): string {
  const match = read(GRADLE).match(/^\s*versionName\s+"([^"]+)"/m);

  expect(match, "versionName not found in build.gradle").not.toBeNull();

  return match![1];
}

/** versionCode from build.gradle — what Android actually orders releases by. */
function androidVersionCode(): number {
  const match = read(GRADLE).match(/^\s*versionCode\s+(\d+)/m);

  expect(match, "versionCode not found in build.gradle").not.toBeNull();

  return Number(match![1]);
}

const windowsVersion = (): string => JSON.parse(read(SHELL_PKG)).version as string;

/** The upload name in the workflow, which does NOT derive from package.json. */
function workflowArtifactVersion(): string {
  const match = read(WORKFLOW).match(/name:\s*pos-canvas-windows-v(\d+\.\d+\.\d+)/);

  expect(match, "artifact upload name not found in the Windows workflow").not.toBeNull();

  return match![1];
}

describe("the native release version is one value, in four places", () => {
  it("1. Android versionName matches the Windows package version", () => {
    // THE NEGATIVE CONTROL for a half-finished bump.
    expect(androidVersionName()).toBe(windowsVersion());
  });

  it("2. the CI artifact name matches the Windows package version", () => {
    // The installer filename comes from artifactName (${version}); the ARTIFACT
    // name is a separate literal. They must agree or a release ships bytes
    // whose container is labelled with the previous version.
    expect(workflowArtifactVersion()).toBe(windowsVersion());
  });

  it("every one of them is a plain semver", () => {
    for (const value of [androidVersionName(), windowsVersion(), workflowArtifactVersion()]) {
      expect(`${value} is semver`).toBe(`${value} is semver`);
      expect(SEMVER.test(value)).toBe(true);
    }
  });

  it("the installer filename still derives from the package version", () => {
    const shell = JSON.parse(read(SHELL_PKG));

    // If this stopped being a template, the filename would freeze at whatever
    // literal replaced it and guard 2 would be comparing the wrong things.
    expect(shell.build.win.artifactName).toBe("POS-Canvas-Windows-v${version}.${ext}");
  });
});

describe("versionCode only ever moves forward", () => {
  it("3. is never lower than the published Android release", () => {
    // Android refuses to install a lower or equal code over an installed one.
    // While a release is being cut the tree must be strictly ahead; once it is
    // published the pointer catches up and the two are equal. Lower is the only
    // state that is always wrong, and it is the one that breaks upgrades.
    const published = CURRENT_ANDROID_RELEASE?.versionCode ?? 0;

    expect(androidVersionCode()).toBeGreaterThanOrEqual(published);
  });

  it("the published versionCode matches the tree once shipped", () => {
    // STRICT AGAIN. 1.2.0 / code 3 is published and verified from the served
    // APK, so the pointer has caught up and the lag allowance the cut needed
    // is gone. A tree ahead of the pointer now fails here, which is correct
    // everywhere except mid-cut — and mid-cut is a deliberate, temporary edit
    // to this file, not a state it should tolerate by default.
    expect(CURRENT_ANDROID_RELEASE?.versionCode).toBe(androidVersionCode());
  });

  it("is a positive integer", () => {
    expect(Number.isInteger(androidVersionCode())).toBe(true);
    expect(androidVersionCode()).toBeGreaterThan(0);
  });
});

describe("the web version is independent of the native release", () => {
  it("5. build.gradle never derives its version from package.json", () => {
    // Comments stripped: build.gradle's own comment EXPLAINS that the version is
    // deliberately not derived from package.json, and prose must not decide a
    // guard about code. This file keeps re-learning that lesson.
    const gradle = read(GRADLE)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    // The convention this project chose, and the reason: the web app deploys
    // continuously while the APK ships rarely, so coupling them would force
    // meaningless version churn on every web release.
    expect(gradle).not.toContain("package.json");
    expect(gradle).toMatch(/^\s*versionName\s+"/m);
  });

  it("the root package stays private and out of the release path", () => {
    const root = JSON.parse(read(ROOT_PKG));

    expect(root.private).toBe(true);
    // Asserted as a NON-match rather than a fixed value, so a future web bump
    // does not fail this — what matters is that it is not the release source.
    expect(root.version).not.toBe(androidVersionName());
    expect(root.version).not.toBe(windowsVersion());
  });

  it("the root version is not read by any native build", () => {
    for (const file of [GRADLE, WORKFLOW]) {
      const source = read(file);

      expect(`${file} does not read the root package version`).toBe(
        `${file} does not read the root package version`
      );
      expect(source).not.toContain("require('../package.json')");
      expect(source).not.toContain('require("../package.json")');
    }
  });
});

describe("the public download pointers describe what is actually published", () => {
  it("4. they now match the version in the tree, because it shipped", () => {
    // These deliberately LAGGED while 1.2.0 was being cut: lib/*Release.ts is
    // what the download page serves, so moving it before the artifact exists
    // advertises a 404. Both 1.2.0 artifacts are now published and their SERVED
    // bytes verified, so the pointers match again.
    expect(CURRENT_ANDROID_RELEASE?.versionName).toBe(androidVersionName());
    expect(CURRENT_WINDOWS_RELEASE?.versionName).toBe(windowsVersion());
  });

  it("a pointer never advertises a version that was never built", () => {
    // The failure this catches: a pointer ahead of the tree is a 404 on the
    // download page. Kept as an ORDERING check rather than folded into guard 4
    // above, because it is the half that must survive the next release cut —
    // when guard 4 is temporarily relaxed, this is what still forbids a pointer
    // from advertising a version nobody ever built.
    const building = windowsVersion();

    for (const published of [
      CURRENT_ANDROID_RELEASE?.versionName,
      CURRENT_WINDOWS_RELEASE?.versionName,
    ]) {
      if (published === undefined) {
        continue;
      }

      expect(`published ${published} vs building ${building}`).toBe(
        `published ${published} vs building ${building}`
      );
      expect(compareSemver(published, building)).toBeLessThanOrEqual(0);
    }
  });

  it("a published Windows pointer still matches its own filename contract", () => {
    if (!CURRENT_WINDOWS_RELEASE) return;

    expect(CURRENT_WINDOWS_RELEASE.downloadUrl).toContain(
      `POS-Canvas-Windows-v${CURRENT_WINDOWS_RELEASE.versionName}.exe`
    );
  });
});
