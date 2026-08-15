// Feature 23.1 — the universal POS Canvas Windows shell.
//
// WHAT THIS PROCESS IS: a window and, in later phases, a security boundary. It
// is NOT a POS. It contains no menu, no prices, no configuration, no project id
// and no credentials, and it is byte-identical for every business. A till
// becomes a specific business's till by PAIRING at runtime, against the hosted
// /device runtime this window loads — exactly as the Android shell does.
//
// SCOPE OF THIS PHASE (23.1): launch one window at the resolved URL, and show an
// honest local page instead of a white rectangle when that URL cannot be
// reached. The four structural webPreferences below are present from the first
// commit because retrofitting them later means shipping an interim build that
// was never safe.
//
// DELIBERATELY NOT HERE — these belong to 23.2 and are not partially
// implemented, because a half-written navigation policy reads as a finished one:
//   * will-navigate origin lockdown
//   * setWindowOpenHandler policy
//   * permission request handler
//   * download cancellation
//   * certificate-error handling
//   * single-instance lock
//   * production DevTools lockdown
// And the desktop identity bridge for DevicePlatform belongs to 23.3.
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { readDesktopServerUrl } from "./serverUrl.mjs";

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
 * Resolved once, at startup, and never re-read.
 *
 * A single resolution means the window and the retry path cannot disagree about
 * where this shell points, and it means a malformed configuration fails
 * immediately and loudly rather than on some later navigation.
 */
let resolvedServer = null;

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

function createWindow() {
  const window = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    webPreferences: {
      // Feature 23 locked security defaults. Present from day one.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // The hosted page must never see Node. The preload below exposes exactly
      // one zero-argument function and nothing else.
      preload: PRELOAD_SCRIPT,
    },
  });

  // Shown only once there is something to look at, so a slow first load is a
  // brief delay rather than a white rectangle.
  window.once("ready-to-show", () => {
    window.show();
  });

  // -------------------------------------------------------------------------
  // Load failure -> the local fallback page.
  //
  // loadFile is a MAIN-PROCESS navigation, which does not emit will-navigate.
  // That matters for 23.2: the origin lockdown added there governs navigations
  // initiated by page content, so serving this local page cannot require a
  // file:// exception in that policy. The fallback is reachable only because
  // this process chose to show it.
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
// influenced by the page. That is why the fallback page needs no knowledge of
// which URL it is retrying, and why development and release both retry the
// correct target with no value injected into the HTML.
// ---------------------------------------------------------------------------
ipcMain.on(RETRY_CHANNEL, (event) => {
  // The preload is attached to every page in the window, including the hosted
  // runtime. Honouring this channel only from the local fallback keeps the
  // remote page from reaching a main-process action at all. (It gains nothing
  // if it does — a reload is something any page can already do — but the
  // boundary is worth stating in code rather than in a comment alone.)
  const senderUrl = event.senderFrame?.url ?? "";

  if (!senderUrl.startsWith("file://")) {
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

app.whenReady().then(() => {
  // Resolved after ready so a configuration error surfaces through a normal
  // startup failure rather than during module evaluation.
  resolvedServer = readDesktopServerUrl();

  console.log(
    `[pos-canvas] shell ${app.getVersion()} — loading ${resolvedServer.url} ` +
      `(${resolvedServer.source})`
  );
  console.log(`[pos-canvas] user data: ${app.getPath("userData")}`);
  console.log(`[pos-canvas] shell directory: ${shellDirectory}`);

  createWindow();

  // macOS development convenience: clicking the dock icon with no windows open
  // reopens one. Windows and Linux quit instead (below), so this is macOS-only
  // behaviour and not a till-facing feature.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// On Windows — the platform this shell exists for — closing the window quits the
// application, which is what an operator expects from a till. macOS keeps the
// process alive by convention, which only affects local development.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
