// Feature 24.5G / 24.5F — the device runtime's own build, ONE SOURCE FOR BOTH
// NATIVE SHELLS.
//
// Android loads the output from https://localhost (Capacitor's asset loader) and
// Windows serves the same output from app://poscanvas (an Electron privileged
// scheme). Only the OUTPUT DIRECTORY differs; the entry, the modules and every
// byte of financial logic are identical, which is the entire point — there is no
// android copy and no windows copy of the POS.
//
// WHY VITE RATHER THAN next build --output export, which was the obvious first
// idea: `output: "export"` is an APPLICATION-WIDE setting. This repo has three
// dynamic routes with no generateStaticParams (app/editor/[id],
// app/runtime/[id], app/templates/[id]) and a middleware (proxy.ts) that static
// export does not support. Turning it on would mean rewriting owner-facing
// routing to ship a till — enormous blast radius, for a bundle that needs none
// of those routes.
//
// Vite is already present in this repository (vitest depends on it), so this
// target costs no new production dependency and no new runtime. It consumes the
// SAME modules the hosted app does, through the same "@/" alias, so there is
// one device implementation with two entry points rather than two apps.
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/**
 * Where the built runtime goes. The one thing that differs per shell.
 *
 * Defaults to the Android shell's webDir so `npm run android:runtime` needs no
 * environment at all; the Windows script sets it to the Electron package's own
 * runtime directory. A path outside the repository is refused rather than
 * written to — a mistyped variable should fail, not scatter a POS across the
 * filesystem.
 */
function readOutDir(): string {
  const requested = process.env.POS_CANVAS_DEVICE_OUT_DIR;

  if (!requested || requested.trim() === "") {
    return resolve(repoRoot, "android-shell/www");
  }

  const absolute = resolve(repoRoot, requested);

  if (!absolute.startsWith(`${repoRoot}/`)) {
    throw new Error(
      `POS_CANVAS_DEVICE_OUT_DIR must resolve inside the repository. Got: ${absolute}`
    );
  }

  return absolute;
}

/**
 * Reads the two PUBLIC Supabase values, exactly the pair Next.js inlines into
 * its own browser bundle today.
 *
 * ONLY NEXT_PUBLIC_* IS EVER READ. A service-role key is a server credential
 * and would be catastrophic inside an APK that any customer can unzip; nothing
 * here can reach one, and lib/androidDeviceRuntime.guards.test.ts asserts the
 * built bundle is free of it.
 */
function readPublicEnv(): { url: string; anonKey: string } {
  const fromProcess = {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };

  if (fromProcess.url && fromProcess.anonKey) {
    return { url: fromProcess.url, anonKey: fromProcess.anonKey };
  }

  // Same file Next reads, parsed minimally rather than adding a dotenv dep.
  let raw = "";

  try {
    raw = readFileSync(resolve(repoRoot, ".env.local"), "utf-8");
  } catch {
    raw = "";
  }

  const read = (key: string): string | undefined => {
    const line = raw.split("\n").find((entry) => entry.startsWith(`${key}=`));

    return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
  };

  const url = fromProcess.url ?? read("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = fromProcess.anonKey ?? read("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  if (!url || !anonKey) {
    throw new Error(
      "The Android device runtime needs NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY. Set them in the environment or in " +
        ".env.local before running `npm run android:runtime`.\n\n" +
        "These are the same PUBLIC values the hosted app already sends to every " +
        "browser. Never provide a service-role key here."
    );
  }

  return { url, anonKey };
}

const publicEnv = readPublicEnv();

export default defineConfig({
  root: here,
  // Relative asset URLs. The runtime is served from the root of
  // https://localhost by Capacitor's asset loader, but relative paths keep the
  // bundle independent of where it is mounted and make it trivially servable
  // from a static directory for verification.
  base: "./",
  resolve: {
    // AN ARRAY WITH ANCHORED PATTERNS, not the obvious `{ "@": repoRoot }`.
    //
    // A bare "@" key is a PREFIX match, so it also captures every scoped npm
    // package: `@supabase/supabase-js` resolves to `<repoRoot>/supabase/
    // supabase-js`, which happens to look plausible here because this repo has
    // a supabase/ directory. The first version of this file did exactly that
    // and produced a bundle that built cleanly, weighed 397 kB, and contained
    // no POS at all — React and some stray editor modules, with the entire
    // device tree silently dropped. Anchoring on "@/" is what makes the alias
    // mean "this repository" rather than "anything scoped".
    alias: [
      { find: /^@\//, replacement: `${repoRoot}/` },
      // next/link is imported by PosRuntime for the owner runtime's exit link.
      // A device passes homeLink={null}, so it is NEVER RENDERED here — but the
      // import would still drag Next's client router into an app that has no
      // Next.js. The shim is an <a>: inert for this target, and identical in
      // behaviour if a future host ever does pass a link.
      { find: /^next\/link$/, replacement: resolve(here, "nextLinkShim.tsx") },
    ],
  },
  esbuild: {
    // tsconfig.json sets "jsx": "react-jsx", which esbuild honours; stated
    // explicitly so this build cannot be changed by an unrelated tsconfig edit.
    jsx: "automatic",
  },
  define: {
    // The same two values, inlined the same way Next inlines them.
    "process.env.NEXT_PUBLIC_SUPABASE_URL": JSON.stringify(publicEnv.url),
    "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": JSON.stringify(publicEnv.anonKey),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: readOutDir(),
    emptyOutDir: true,
    // Deterministic and inspectable. No sourcemaps: they would ship the entire
    // readable source of the POS inside a customer-installable APK.
    sourcemap: false,
    target: "es2020",
    rollupOptions: {
      output: {
        // Stable, hashed names so an app update cannot serve a half-old bundle
        // out of the WebView's HTTP cache.
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
