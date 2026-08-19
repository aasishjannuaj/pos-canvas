package com.poscanvas.app;

import android.os.Bundle;
import android.os.SystemClock;

import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

// Feature 20 — moved from com.poscanvas.dev. The package must match the
// applicationId in build.gradle; Android treats a different applicationId as a
// different app entirely, so this pairing is permanent once distributed.
public class MainActivity extends BridgeActivity {

    /**
     * How long the POS Canvas mark stays on screen before the runtime is
     * revealed — a MINIMUM, never a fixed wait.
     *
     * WHY IT EXISTS: on a fast device the system splash was being dismissed the
     * instant the first frame was ready, which the owner reported as the
     * branding "disappearing too quickly" to register. 1300 ms is long enough
     * to read a logo and short enough that nobody waits for it.
     *
     * WHAT IT IS NOT: an artificial pause bolted onto startup. Capacitor begins
     * loading the hosted runtime inside super.onCreate() below, so the whole
     * 1300 ms overlaps work that was happening anyway. On a slow connection the
     * runtime is still loading when this elapses and no time has been added at
     * all; on a fast one, this is the only reason the mark is legible.
     */
    static final long MINIMUM_BRAND_VISIBLE_MS = 1300L;

    /** Monotonic start of the splash, in uptime rather than wall-clock time. */
    private long splashStartedAtUptimeMs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // MUST precede super.onCreate(): androidx installs the splash by
        // swapping the activity's theme and attaching to the content view's
        // pre-draw pass, both of which have to happen before the Activity
        // creates its content.
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);

        // SystemClock.uptimeMillis(), NOT System.currentTimeMillis(): the wall
        // clock can jump backwards or forwards mid-startup (NTP correction, an
        // operator fixing the date, a device that has been off for weeks). A
        // backwards jump against a wall clock would hold the splash on screen
        // until the clock caught up, which on a till is indistinguishable from a
        // hang. Uptime only ever moves forward.
        splashStartedAtUptimeMs = SystemClock.uptimeMillis();

        // NOTHING SLEEPS AND NOTHING BLOCKS. androidx evaluates this predicate
        // on each pre-draw pass of the content view and dismisses the splash on
        // the first frame it returns false. The UI thread stays free the entire
        // time — which is what lets the WebView get on with loading the runtime
        // underneath.
        splashScreen.setKeepOnScreenCondition(
            () -> SystemClock.uptimeMillis() - splashStartedAtUptimeMs < MINIMUM_BRAND_VISIBLE_MS
        );

        super.onCreate(savedInstanceState);
    }
}
