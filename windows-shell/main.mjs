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
import { app, BrowserWindow, ipcMain, Menu, net, protocol } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readDesktopServerUrl } from "./serverUrl.mjs";
import { createNavigationPolicy } from "./navigationPolicy.mjs";
import { APP_ORIGIN, APP_SCHEME, resolveAppAssetPath } from "./appProtocol.mjs";

const shellDirectory = fileURLToPath(new URL(".", import.meta.url));
const PRELOAD_SCRIPT = fileURLToPath(new URL("./preload.js", import.meta.url));
const OFFLINE_PAGE = fileURLToPath(new URL("./offline.html", import.meta.url));

/**
 * Feature 24.3 — the branded startup screen, shown from disk while the hosted
 * runtime loads. A DIFFERENT page from OFFLINE_PAGE and deliberately so: this
 * one says the app is starting, that one says it failed. See splash.html.
 */
const SPLASH_PAGE = fileURLToPath(new URL("./splash.html", import.meta.url));

/**
 * Feature 24.5F — the PACKAGED device runtime, built from native-device/ by
 * `npm run windows:runtime` and shipped inside the installer.
 *
 * This directory is what makes a zero-network cold start possible. Until now the
 * shell fetched /device over the network, so a till with no connection could not
 * execute the runtime at all and fell to a static "no internet" page — every
 * offline capability sat behind it, unreachable. Android proved the fix on real
 * hardware; this is the same bundle, byte for byte, served locally.
 */
const RUNTIME_ROOT = fileURLToPath(new URL("./runtime/", import.meta.url));

/** The document the shell opens. Served by the app:// handler below. */
const RUNTIME_ENTRY = `${APP_ORIGIN}/index.html`;

/**
 * Feature 24.5F — how long the branded splash is guaranteed to stay on screen.
 *
 * One full cycle of the 1.4s `slide` animation in splash.html, so the mark is
 * seen rather than glimpsed. Deliberately a floor and not a fixed delay: the
 * splash load and this timer run concurrently, so a slower machine pays no more
 * than a fast one.
 *
 * splash.html honours prefers-reduced-motion by disabling the animation; the
 * hold is unchanged in that case, which is correct — the brand screen is still
 * shown, it simply does not move.
 */
const SPLASH_MINIMUM_VISIBLE_MS = 1400;

/** A promise that resolves after `ms`. The only timer in this file. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Feature 24.5F — the application's own scheme, registered BEFORE app ready.
 *
 * THE NAME IS PLURAL — registerSchemeSAsPrivileged — and the singular does not
 * exist. The first version of this file called `registerSchemeAsPrivileged`,
 * which threw a TypeError during module evaluation, before `app.whenReady()`
 * and before any window was created, so the packaged application could not
 * start at all. A source-string guard had asserted the misspelling and passed,
 * because a string cannot know whether a function exists. lib/
 * windowsStartup.smoke.test.ts now boots Electron for real instead.
 *
 * Electron requires this call to happen before the `ready` event; afterwards the
 * scheme cannot gain privileges. Each privilege is here because something the
 * POS actually does needs it, and nothing broader is enabled:
 *
 *   standard        — makes app://poscanvas a real, comparable ORIGIN in
 *                     Chromium. Without it every app:// URL is opaque, and
 *                     IndexedDB and localStorage — which are origin-scoped —
 *                     would have nowhere stable to live.
 *   secure          — makes it a secure context. lib/deviceOfflineCache.ts
 *                     hashes the pinned config with crypto.subtle, which is
 *                     unavailable outside one; without it digestConfig returns
 *                     null, no cache is ever written, and offline mode silently
 *                     never arms while looking perfectly healthy online.
 *   supportFetchAPI — the runtime is an ES-module bundle and Supabase calls go
 *                     out through fetch.
 *
 * DELIBERATELY NOT ENABLED: `allowServiceWorkers`, `corsEnabled`,
 * `bypassCSP`, `stream`. None is needed, and each widens what a page can do.
 *
 * THE ORIGIN IS PERMANENT. Storage is origin-scoped, so changing the scheme or
 * the host after release would strand a till's pairing, its pinned config and
 * its queued sales.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

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
  // Feature 24.3 — the board's splash ground, matched by splash.html. This is
  // the colour of the very first frame Chromium paints, before any document
  // exists; leaving it at a generic grey put a flash of the wrong colour in
  // front of the brand screen.
  backgroundColor: "#FBFDFD",
  title: "POS Canvas",
  show: false,
    // Feature 24.5F — the second barrier behind setApplicationMenu(null). With
    // no application menu there is nothing to reveal, but this makes the
    // intent explicit and survives a future menu being added for another reason.
    autoHideMenuBar: true,
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

  // Feature 24.3 — with the splash loaded from disk first, "something to look
  // at" now arrives in milliseconds and is the POS Canvas brand screen, so this
  // fires almost immediately instead of waiting on the network.
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

  // Feature 24.3 — SPLASH FIRST, THEN THE RUNTIME, in this one window.
  //
  // WHY NOT A SECOND BrowserWindow, which is the usual Electron splash recipe:
  // a second window is a second surface to secure, and it would have to be
  // created, tracked, focused and destroyed correctly on every path — including
  // second-instance activation, where a stale splash would be an orphan window
  // the operator cannot close. Reusing this window means the splash inherits
  // every Feature 23 webPreference and every deny-by-default handler already
  // applied above, with no second copy that could drift out of agreement.
  //
  // Chromium keeps showing the current document until the next one has something
  // to paint, so the brand screen stays up for the whole remote load and is
  // replaced by the runtime's first frame rather than by a white gap.
  //
  // NEITHER LOAD IS PAGE-INITIATED, so will-navigate and will-redirect do not
  // fire for either — the navigation policy governs what the PAGE may do and is
  // untouched by this.
  //
  // .finally, not .then: if the local splash somehow fails to load, the till
  // must still go to the runtime. A branded screen is never allowed to become
  // the reason a till does not start.
  // Feature 24.5F — HOLD THE SPLASH LONG ENOUGH TO BE SEEN.
  //
  // This used to be `loadFile(SPLASH_PAGE).finally(() => loadDeviceRuntime())`,
  // which replaced the splash the instant the splash itself finished loading.
  // That looked fine while the runtime was a NETWORK fetch taking seconds — the
  // splash covered the whole wait. Now the runtime is local and resolves in
  // milliseconds, so the brand animation was replaced before a single 1.4s cycle
  // could play, and on a fast machine the window was often not even shown yet.
  //
  // Promise.all rather than nested timers: the splash and the minimum hold run
  // CONCURRENTLY, so startup costs max(splashLoad, MIN_HOLD) — not their sum.
  // Nothing here slows a device down beyond one animation cycle.
  Promise.all([
    // .catch, not .finally: a splash that fails to load must not stop the till
    // starting. A branded screen is never allowed to become the reason a till
    // does not open.
    window.loadFile(SPLASH_PAGE).catch(() => undefined),
    delay(SPLASH_MINIMUM_VISIBLE_MS),
  ]).then(() => {
    loadDeviceRuntime(window);
  });

  return window;
}

/**
 * Feature 24.5F — removes Electron's stock application menu.
 *
 * Electron installs a default menu when none is set; on Windows that renders as
 * a File / Edit / View / Window bar inside the window frame. A till is a
 * single-purpose appliance and has no use for New Window, Reload, Toggle
 * DevTools or Zoom — several of which actively work against the deny-by-default
 * posture the rest of this file maintains.
 *
 * setApplicationMenu(null) REMOVES it rather than hiding it, so the Alt key
 * cannot summon one either; autoHideMenuBar on the window is the second,
 * independent barrier. The frame itself is untouched — minimise, maximise and
 * close stay exactly where Windows users expect them, and `frame: false` is
 * deliberately not used.
 *
 * NOTE ON TEXT EDITING: removing the menu also removes its Edit roles, which is
 * where Cut/Copy/Paste accelerators are conventionally declared. In Chromium
 * those shortcuts are handled by the renderer for focused editable fields, so
 * the pairing-code input keeps working — but that is a claim about a real
 * keyboard on real Windows, so it is on the hardware checklist. If it ever
 * proves false, the fix is a menu of edit roles marked `visible: false`, never
 * the stock menu back.
 */
function removeApplicationMenu() {
  Menu.setApplicationMenu(null);
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

/**
 * Feature 24.5F — serves the packaged runtime over app://poscanvas.
 *
 * Every decision about WHICH file a URL names lives in appProtocol.mjs and is
 * unit-tested under plain Node; this function is wiring plus the file read. A
 * null answer means "not ours, or outside the runtime directory" and becomes a
 * 404 either way, so a probe cannot tell the two apart.
 */
function registerRuntimeProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const filePath = resolveAppAssetPath(request.url, RUNTIME_ROOT);

    if (filePath === null) {
      console.warn(`[pos-canvas] refused app request: ${request.url}`);
      return new Response("Not found", { status: 404 });
    }

    try {
      // net.fetch on a file URL gives correct MIME types for the bundle's
      // JavaScript and CSS without this process maintaining its own table.
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (error) {
      console.error(`[pos-canvas] failed to serve ${request.url}: ${error}`);
      return new Response("Not found", { status: 404 });
    }
  });
}

/** Navigates a window to the packaged runtime. The only place that happens. */
function loadDeviceRuntime(window) {
  if (window.isDestroyed()) {
    return;
  }

  // Feature 24.5F — a LOCAL load. There is no network dependency to start, and
  // no hosted URL to fail; resolvedServer is retained only for the dev-mode
  // escape hatch and the release flag that governs DevTools.
  window.loadURL(RUNTIME_ENTRY);
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
    //
    // Feature 23.4 — app.isPackaged is what makes an INSTALLED app a release
    // build. A customer cannot be asked to set an environment variable, and a
    // missing variable is the normal state on their machine, so the packaged
    // flag decides and no environment value can override it. An unpackaged
    // checkout still honours POS_CANVAS_DESKTOP_RELEASE for `npm run
    // start:production`.
    resolvedServer = readDesktopServerUrl(process.env, {
      isPackaged: app.isPackaged,
    });
    navigationPolicy = createNavigationPolicy({
      runtimeUrl: resolvedServer.url,
      isRelease: resolvedServer.isRelease,
    });

    // Feature 24.5F — the runtime must be servable before any window asks for
    // it. Registered here, after ready, as protocol.handle requires.
    registerRuntimeProtocol();

    // Before any BrowserWindow exists, so no window is ever constructed with a
    // menu attached.
    removeApplicationMenu();

    console.log(
      `[pos-canvas] shell ${app.getVersion()} — serving ${RUNTIME_ENTRY} ` +
        `from ${RUNTIME_ROOT}`
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
