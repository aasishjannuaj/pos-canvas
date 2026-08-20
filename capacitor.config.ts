// Feature 24.5G — the Android app's own runtime, packaged locally.
//
// WHAT CHANGED, and why it is the whole point of this feature. Until now this
// shell was a WebView pointed at the hosted runtime via `server.url`, bundling
// no POS at all. That worked online and failed completely offline: with no
// network the WebView could not fetch /device, so DeviceApp never executed,
// IndexedDB was never opened, and every offline capability built in 24.5A-F was
// unreachable behind a static "no internet" page. Real hardware QA found
// exactly that, and it was a release blocker.
//
// The runtime is now BUILT INTO THE APP (android-shell/vite.config.mts emits it
// into android-shell/www, which Capacitor copies into the APK). There is no
// `server.url`, so the app has no network dependency to start — it boots from
// its own assets, under Capacitor's stable local origin:
//
//     https://localhost
//
// That origin is PERMANENT and load-bearing in two ways. IndexedDB and
// localStorage are origin-scoped, so changing it later would strand a till's
// pairing, its cached config and — worst of all — its queued sales. And it must
// be a SECURE CONTEXT: lib/deviceOfflineCache.ts hashes the pinned config with
// crypto.subtle, which is unavailable outside one, and without it no cache is
// ever written and offline mode silently never arms. `https://localhost` is
// potentially-trustworthy by specification, which is why it is used rather than
// file://, http://localhost or capacitor://.
//
// STILL BUNDLED HERE: no service-role key, no customer id, no project id, no
// GeneratedPosConfig. The app ships the RUNTIME; the business configuration is
// still fetched and pinned per device at pairing time. One universal binary.
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // Feature 20 — the FINAL production application id, replacing the
  // provisional com.poscanvas.dev.
  //
  // This value is permanent. An Android app is identified by its
  // applicationId together with its signing certificate: once a customer has
  // installed a signed build, changing either one means Android sees a
  // different app, with no upgrade path and no way to carry a paired session
  // across. It must stay in lockstep with `namespace`/`applicationId` in
  // android/app/build.gradle and with the MainActivity package declaration.
  appId: "com.poscanvas.app",

  appName: "POS Canvas",

  // Feature 24.5G — the BUILT device runtime, emitted by
  // `npm run android:runtime` (android-shell/vite.config.mts). These are no
  // longer placeholder pages: this directory holds the real, minified POS
  // Canvas device application, and it is what the app starts from.
  webDir: "android-shell/www",

  // NO `server` BLOCK, deliberately.
  //
  // Its presence is what made the app unable to start offline. Capacitor serves
  // the bundled assets from https://localhost when no server.url is set, which
  // is both the local origin this feature standardises on and a secure context.
  // `androidScheme` is left at Capacitor's default of "https" rather than being
  // restated, so an upgrade cannot find two disagreeing sources of truth — the
  // origin is asserted at runtime by android-shell/device/main.tsx and by
  // lib/androidDeviceRuntime.guards.test.ts.
  //
  // There is also no `errorPath`: it existed to catch a failed REMOTE load, and
  // there is no longer a remote load to fail.
  android: {
    // 24.2 POLISH PASS — the brand ground, behind the WebView.
    //
    // MEASURED, not guessed: with the WebView at its default the startup
    // sequence went cream splash -> WHITE -> POS, because the WebView paints
    // its own background from the moment it is attached until the hosted page
    // has something to draw. On a slow connection that white gap is the
    // longest thing an operator sees, and it undoes the splash it follows.
    // Setting it to the approved ground makes the whole startup one colour.
    //
    // This is Android-scoped by construction (CapacitorConfig.android), and it
    // is a BACKGROUND only: the hosted page paints over it normally the instant
    // it renders, so nothing about the runtime's own appearance changes.
    backgroundColor: "#FBF8F3",

    // Feature 16.2 — keeps the WebView's own scroll/bounce behavior
    // predictable inside the app shell. No kiosk mode, no lock task mode,
    // and no irreversible hiding of system navigation: this is a normal,
    // exitable app, exactly as scoped.
    allowMixedContent: false,

    // Feature 20 — remote WebView debugging, ON for development and OFF for
    // release.
    //
    // This was previously unconditional. On a released till it would expose the
    // full contents of a live POS session — including the paired device's
    // stored auth session — to anyone who can reach the device over adb. It is
    // now tied to the same explicit release flag that pins the production URL,
    // so the two cannot disagree about which kind of build this is.
    // Feature 24.5G — OFF, unconditionally.
    //
    // It was previously tied to the release flag derived from the server URL,
    // and that flag no longer exists because there is no server URL. A till now
    // carries its whole runtime plus a live paired session, so leaving remote
    // debugging reachable over adb would expose both. Anyone debugging the
    // runtime can run it in a browser, where the same bundle is servable.
    webContentsDebuggingEnabled: false,
  },
};

export default config;
