// Feature 25.6 P0-1 — the device runtime's build launcher, cross-platform.
//
// WHY THIS FILE EXISTS. The scripts used to read:
//
//   POS_CANVAS_DEVICE_OUT_DIR=windows-shell/runtime vite build --config ...
//
// which is POSIX shell syntax. npm runs scripts through cmd.exe on Windows, and
// cmd has no notion of a leading NAME=value assignment — it tries to execute
// "POS_CANVAS_DEVICE_OUT_DIR=windows-shell/runtime" as a program and fails with
// "is not recognized as an internal or external command". The first real
// windows-latest run of the release workflow died on exactly that, before
// packaging, which is what the fail-closed step was built to do.
//
// A Node launcher rather than a cross-env dependency: this repository already
// ships its own small .mjs tooling (serverUrl, appProtocol, navigationPolicy),
// the whole job is to set one variable and call a build, and adding a package to
// a frozen release tree costs a lockfile change in two npm projects for no extra
// capability. Vite's Node API is invoked directly, so no shell is involved on
// any platform and there is nothing left to quote wrongly.
//
// The output directory is an ARGUMENT, not an environment variable, at the one
// call site that needs it. Omitting it leaves the variable unset, which is
// exactly what the Android build wants: vite.config.mts then falls back to
// android-shell/www. The config is unchanged and still refuses any path that
// resolves outside the repository.
import { build } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const requestedOutDir = process.argv[2];

if (requestedOutDir !== undefined && requestedOutDir.trim() !== "") {
  // Read by readOutDir() in vite.config.mts, which resolves it against the
  // repository root and refuses anything outside. Set before the config is
  // loaded, because that file reads process.env at module evaluation.
  process.env.POS_CANVAS_DEVICE_OUT_DIR = requestedOutDir;
}

try {
  await build({ configFile: resolve(here, "vite.config.mts") });
} catch (error) {
  // A non-zero exit is the whole point: a runtime that failed to build must stop
  // the release workflow here rather than be packaged as an empty directory.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
