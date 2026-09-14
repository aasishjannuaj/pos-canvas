import type { Metadata } from "next";
import { NOINDEX_ROBOTS } from "@/lib/seo";

// Lane 3 Task 3 — a password-recovery screen in a search index is worse
// than useless — it is a page a person should only ever reach from their own
// deliberate action.
//
// A LAYOUT RATHER THAN THE PAGE, because the page is a Client Component, and a
// Client Component cannot export `metadata` at all. The layout is a Server
// Component wrapping it, which is where the directive can live without
// converting the page or duplicating its logic.
//
// `noindex` is a search directive and nothing more. It is not what keeps this
// route private — lib/siteOrigin.ts governs where a recovery link
// may actually return to, and that is the control that matters.
export const metadata: Metadata = {
  robots: NOINDEX_ROBOTS,
};

export default function ForgotPasswordLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
