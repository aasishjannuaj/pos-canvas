import type { Metadata } from "next";
import { NOINDEX_ROBOTS } from "@/lib/seo";

// Lane 3 Task 3 — reached only from a recovery link with a one-time
// code. It has no standalone meaning and must never be a search result.
//
// A LAYOUT RATHER THAN THE PAGE, because the page is a Client Component, and a
// Client Component cannot export `metadata` at all. The layout is a Server
// Component wrapping it, which is where the directive can live without
// converting the page or duplicating its logic.
//
// `noindex` is a search directive and nothing more. It is not what keeps this
// route private — the recovery code is what gates it, not this.
export const metadata: Metadata = {
  robots: NOINDEX_ROBOTS,
};

export default function ResetPasswordLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
