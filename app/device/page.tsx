// Feature 16.4A — the paired-device route.
//
// Deliberately a thin shell around a client component:
//
//   * NO owner authentication. It never calls lib/supabase/server.ts, never
//     reads cookies(), and never touches getProjectById or any owner-RLS read.
//   * NO server-side device identity. The device session lives in its own
//     localStorage namespace (see lib/supabase/deviceClient.ts), which the
//     server cannot see by design — that is exactly what keeps it from
//     colliding with an owner's cookie session in the same browser.
//   * NOT reachable through /runtime/[id], which is owner-gated and stays so.
//   * NOT linked from any owner navigation. proxy.ts's matcher already covers
//     only /dashboard, /editor, /runtime, /login and /signup, so this route is
//     excluded from owner session handling with no change to that file
//     (verified — see lib/device.guards.test.ts).
//
// Works identically in a normal browser and in the Capacitor WebView: there is
// no native dependency and no server round-trip for device state.
import DeviceApp from "@/components/device/DeviceApp";

export const metadata = {
  title: "POS Canvas — Device",
};

export default function DevicePage() {
  return <DeviceApp />;
}
