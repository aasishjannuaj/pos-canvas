// Feature 24.5G — the Android runtime's entry point.
//
// WHAT THIS FILE IS: a mount, and nothing else. It renders the SAME DeviceApp
// the hosted /device route renders, from the same components and the same
// dependency-free lib modules for financial logic. There is deliberately no POS code here, no pricing,
// no queue and no checkout — a second implementation of any of those is exactly
// what this feature must not create.
//
// WHY IT EXISTS AT ALL: app/device/page.tsx is a Next.js server component that
// supplies route metadata and renders DeviceApp. A locally packaged app has no
// Next.js server, so it needs its own three-line equivalent. That is the whole
// difference between the two targets.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import DeviceApp from "@/components/device/DeviceApp";
import "@/app/globals.css";

/**
 * Feature 24.5G — fail LOUDLY if this build is served from an origin that
 * cannot do offline.
 *
 * WHY THIS CHECK IS WORTH A SCREEN. lib/deviceOfflineCache.ts hashes the pinned
 * configuration with crypto.subtle, and SubtleCrypto is only exposed in a
 * secure context. Without it digestConfig returns null, buildPinnedConfigRecord
 * returns null, and NO CACHE IS EVER WRITTEN — the app would look completely
 * healthy online and then refuse to open offline, with nothing on screen ever
 * explaining why.
 *
 * https://localhost is a potentially-trustworthy origin by specification, so
 * this passes on every correct build. It is here to catch a future
 * misconfiguration — an androidScheme change, a file:// regression — at the
 * first frame instead of during a power cut.
 */
function describeInsecureContext(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (window.isSecureContext !== true) {
    return `This build is running in an insecure context (origin ${window.location.origin}).`;
  }

  if (typeof globalThis.crypto?.subtle?.digest !== "function") {
    return `Web Crypto is unavailable in this build (origin ${window.location.origin}).`;
  }

  return null;
}

const container = document.getElementById("pos-canvas-device");

if (container !== null) {
  const insecure = describeInsecureContext();

  if (insecure !== null) {
    // Deliberately plain DOM, not React: whatever is wrong with this build,
    // rendering the POS would be worse than not rendering it.
    container.textContent =
      `${insecure} POS Canvas cannot store its offline setup safely here and will not start. ` +
      `Reinstall the app from an official POS Canvas download.`;
    container.setAttribute(
      "style",
      "padding:24px;font:14px/1.5 system-ui,sans-serif;color:#171717;text-align:center;"
    );
  } else {
    createRoot(container).render(
      <StrictMode>
        <DeviceApp />
      </StrictMode>
    );
  }
}
