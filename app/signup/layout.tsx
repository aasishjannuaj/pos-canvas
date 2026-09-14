import type { Metadata } from "next";
import { NOINDEX_ROBOTS } from "@/lib/seo";

// Lane 3 Task 3 — a sign-up form has no content a searcher wants. The
// homepage and the template gallery are the pages meant to be found; this is
// where someone goes after deciding.
//
// A LAYOUT RATHER THAN THE PAGE, because the page is a Client Component, and a
// Client Component cannot export `metadata` at all. The layout is a Server
// Component wrapping it, which is where the directive can live without
// converting the page or duplicating its logic.
//
// `noindex` is a search directive and nothing more. It is not what keeps this
// route private — there is nothing to protect on a blank form.
export const metadata: Metadata = {
  robots: NOINDEX_ROBOTS,
};

export default function SignupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
