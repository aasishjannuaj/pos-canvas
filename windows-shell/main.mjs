// Feature 23.1 — the universal POS Canvas Windows shell.
// Feature 23.2 — hardened: one instance, one origin, no permissions, no
// downloads, no DevTools in release.
//
// WHAT THIS PROCESS IS: a window and a security boundary. It is NOT a POS. It
// contains no menu, no prices, no configuration, no project id and no
// credentials, and it is byte-identical for every business. A till becomes a
// specific business's till by PAIRING at runtime, against the hosted /device
// runtime this window loads — exactly as the Android shell does.
//
// THE POSTURE, STATED ONCE: everything is denied unless this file allows it.
// Navigation is refused unless the origin is on a list built in code; new
// windows are refused unconditionally; every permission request is refused;
// every download is cancelled. A till has no legitimate need for any of them,
// and a policy of "deny unless listed" is the only version that stays correct
// when the hosted page changes without this file changing.
//
// TLS IS DELIBERATELY UNTOUCHED. There is no certificate-error handler here, on
// purpose: Electron's default is to reject a bad certificate, and the only
// reason to add a handler would be to override that. Adding one that "correctly"
// rejects would still put the override one edit away from existing.
//
// DELIBERATELY NOT HERE — the desktop identity bridge for DevicePlatform is
// Feature 23.3, and installer/packaging work is 23.4.
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { readDesktopServerUrl } from "./serverUrl.mjs";
import { createNavigationPolicy } from "./navigationPolicy.mjs";

const shellDirectory = fileURLToPath(new URL(".", import.meta.url));
const PRELOAD_SCRIPT = fileURLToPath(new URL("./preload.js", import.meta.url));
const OFFLINE_PAGE = fileURLToPath(new URL("./offline.html", import.meta.url));

/** The channel the offline page uses to ask for another attempt. Carries nothing. */
const RETRY_CHANNEL = "pos-canvas-shell:retry";

/**
 * The application name, set before anything reads it.
 *
 * THIS STRING IS PERMANENT. Electron derives app.getPath("userData") from it —
 * %APPDATA%\POS Canvas on Windows — and that directory is where the WebView's
 * localStorage lives. The paired device session is a localStorage entry
 * (pos-canvas-device-auth, see lib/supabase/deviceClient.ts), so renaming this
 * would move the storage directory and silently unpair every installed till.
 *
 * Stability here is a necessary condition for pairing to survive a restart or an
 * upgrade. It is NOT sufficient on its own — installer upgrade behaviour has to
 * preserve that directory too, which is why 23.5 proves it on real Windows
 * rather than assuming it here.
 */
app.setName("POS Canvas");

/**
 * Feature 23.2 — one instance, and only one.
 *
 * NOT a tidiness feature. The paired device session is a single localStorage
 * entry holding a refresh token, and lib/supabase/deviceClient.ts caches its
 * Supabase client precisely because "a second GoTrueClient on the same storage
 * key would race the first over token refresh". Two shell windows are two
 * renderers on the same profile, which reintroduces exactly that race from
 * outside the page's control — and a lost refresh race on a till means an
 * unexplained sign-out mid-shift.
 *
 * The second process quits immediately and hands its launch to the first, which
 * un-minimises and focuses the window the operator was already looking for.
 */
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

/** Resolved once, at startup, and never re-read. */
let resolvedServer = null;

/** Built once from the resolved URL. */
let navigationPolicy = null;

/** Till-friendly, resizable, and emphatically not kiosk mode. */
const WINDOW_DEFAULTS = {
  width: 1280,
  height: 800,
  minWidth: 1024,
  minHeight: 640,
  resizable: true,
  fullscreen: false,
  kiosk: false,
  backgroundColor: "#fafafa",
  title: "POS Canvas",
  show: false,
};

function focusExistingWindow() {
  const [existing] = BrowserWindow.getAllWindows();

  if (existing === undefined) {
    return;
  }

  if (existing.isMinimized()) {
    existing.restore();
  }

  existing.show();
  existing.focus();
}

/**
 * Refuses any navigation the policy does not allow.
 *
 * Attached to both will-navigate and will-redirect. The redirect case is the one
 * that is easy to miss: a 302 from the trusted origin to somewhere else never
 * emits will-navigate again, so a handler on will-navigate alone would let the
 * window be walked off-origin by the server it trusts.
 *
 * NEITHER EVENT FIRES FOR MAIN-PROCESS LOADS. loadURL and loadFile are not
 * page-initiated, so this policy governs what the PAGE can do while leaving the
 * shell free to show its own offline fallback — which is why blocking file://
 * here does not break the fallback architecture, and why the fallback needed no
 * exception carved out of this list.
 */
function blockDisallowedNavigation(event, url) {
  if (navigationPolicy.isAllowedNavigation(url)) {
    return;
  }

  event.preventDefault();
  console.warn(`[pos-canvas] blocked navigation to ${url}`);
}

function createWindow() {
  const window = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    webPreferences: {
      // Feature 23 locked security defaults. Present since 23.1.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // webSecurity is left at its secure default and must never be disabled;
      // a guard asserts it is never set to false anywhere in this shell.

      // Feature 23.2 — DevTools exist for development and are absent from a
      // release build. On a live till they would expose the paired device's
      // stored session to anyone standing at the counter. This mirrors the
      // Android shell, where webContentsDebuggingEnabled is tied to the same
      // release flag.
      devTools: !resolvedServer.isRelease,

      preload: PRELOAD_SCRIPT,
    },
  });

  // Shown only once there is something to look at, so a slow first load is a
  // brief delay rather than a white rectangle.
  window.once("ready-to-show", () => {
    window.show();
  });

  applySecurityPolicy(window);

  // -------------------------------------------------------------------------
  // Load failure -> the local fallback page.
  // -------------------------------------------------------------------------
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED, which Chromium reports for ordinary superseded
    // navigations. Treating it as a failure would flash the offline page during
    // normal use.
    if (!isMainFrame || errorCode === -3) {
      return;
    }

    console.error(
      `[pos-canvas] load failed (${errorCode} ${errorDescription}) for ${validatedUrl}`
    );

    window.loadFile(OFFLINE_PAGE);
  });

  loadDeviceRuntime(window);

  return window;
}

/** Every deny-by-default control, applied to one window and its session. */
function applySecurityPolicy(window) {
  const { webContents } = window;
  const { session } = webContents;

  // ---- Navigation -----------------------------------------------------
  webContents.on("will-navigate", blockDisallowedNavigation);
  webContents.on("will-redirect", blockDisallowedNavigation);

  // ---- New windows ----------------------------------------------------
  // Denied outright. Nothing on /device opens a window, and a shell that
  // will open one on request is a browser.
  webContents.setWindowOpenHandler(({ url }) => {
    console.warn(`[pos-canvas] blocked window.open for ${url}`);
    return navigationPolicy.decideWindowOpen(url);
  });

  // ---- Permissions ----------------------------------------------------
  // Camera, microphone, geolocation, notifications, MIDI, clipboard-read,
  // sensors: all refused. The POS takes payments; it asks the operating
  // system for nothing. Both handlers are set because they answer different
  // questions — one the request, one the synchronous check a page makes
  // through navigator.permissions — and leaving either at its default would
  // make the answer depend on which path the page took.
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    console.warn(`[pos-canvas] denied permission request: ${permission}`);
    callback(false);
  });

  session.setPermissionCheckHandler((_webContents, permission) => {
    console.warn(`[pos-canvas] denied permission check: ${permission}`);
    return false;
  });

  // ---- Downloads ------------------------------------------------------
  // A paired till never downloads anything. Configuration download belongs to
  // the OWNER web editor, on a different surface, behind owner auth.
  session.on("will-download", (event, item) => {
    console.warn(`[pos-canvas] cancelled download: ${item.getFilename()}`);
    event.preventDefault();
  });

  // ---- DevTools shortcuts --------------------------------------------
  // devTools: false already makes openDevTools a no-op; this closes the
  // keyboard path too, so the behaviour does not depend on a single
  // mechanism. Development is left alone.
  if (resolvedServer.isRelease) {
    webContents.on("before-input-event", (event, input) => {
      const key = typeof input.key === "string" ? input.key.toLowerCase() : "";
      const inspect =
        key === "i" && input.shift && (input.control || input.meta || input.alt);

      if (key === "f12" || inspect) {
        event.preventDefault();
      }
    });
  }
}

/** Navigates a window to the resolved runtime URL. The only place that happens. */
function loadDeviceRuntime(window) {
  if (window.isDestroyed()) {
    return;
  }

  window.loadURL(resolvedServer.url);
}

// ---------------------------------------------------------------------------
// Retry
//
// The offline page signals intent and NOTHING else: the channel carries no
// payload, so the destination stays solely in this process and cannot be
// influenced by the page. Feature 23.2 additionally stops the bridge from being
// exposed to the hosted page at all (see preload.js); the sender check below is
// kept as the second of the two independent barriers, because a preload change
// should not be able to silently re-open a main-process action.
// ---------------------------------------------------------------------------
ipcMain.on(RETRY_CHANNEL, (event) => {
  const senderUrl = event.senderFrame?.url ?? "";

  if (!senderUrl.startsWith("file://")) {
    console.warn("[pos-canvas] ignored retry from a non-local frame");
    return;
  }

  const window = BrowserWindow.fromWebContents(event.sender);

  if (window !== null) {
    loadDeviceRuntime(window);
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (hasSingleInstanceLock) {
  // A second launch never becomes a second window: it quits, and this fires here
  // so the operator gets the window they were trying to reach.
  app.on("second-instance", () => {
    focusExistingWindow();
  });

  app.whenReady().then(() => {
    // Resolved after ready so a configuration error surfaces through a normal
    // startup failure rather than during module evaluation.
    resolvedServer = readDesktopServerUrl();
    navigationPolicy = createNavigationPolicy({
      runtimeUrl: resolvedServer.url,
      isRelease: resolvedServer.isRelease,
    });

    console.log(
      `[pos-canvas] shell ${app.getVersion()} — loading ${resolvedServer.url} ` +
        `(${resolvedServer.source})`
    );
    console.log(`[pos-canvas] user data: ${app.getPath("userData")}`);
    console.log(`[pos-canvas] shell directory: ${shellDirectory}`);
    console.log(
      `[pos-canvas] allowed origins: ${navigationPolicy.allowedOrigins.join(", ")}`
    );
    console.log(`[pos-canvas] devtools: ${resolvedServer.isRelease ? "off" : "on"}`);

    createWindow();

    // macOS development convenience: clicking the dock icon with no windows open
    // reopens one. Windows and Linux quit instead (below), so this is macOS-only
    // behaviour and not a till-facing feature.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        focusExistingWindow();
      }
    });
  });
}

// On Windows — the platform this shell exists for — closing the window quits the
// application, which is what an operator expects from a till. macOS keeps the
// process alive by convention, which only affects local development.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
