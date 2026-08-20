// Feature 24.5G — next/link, for a target that has no Next.js.
//
// PosRuntime imports Link to render the owner runtime's "back to dashboard"
// affordance. A paired till passes homeLink={null} and therefore never renders
// it — but an unresolved import is a build failure, and resolving it to the
// real next/link would pull Next's client router into an application that has
// no Next.js runtime at all.
//
// This is NOT a reimplementation of anything: an <a> is what next/link renders,
// and this target never even reaches it. Kept in android-shell/ rather than in
// components/ so it can never be mistaken for product code.
import type { AnchorHTMLAttributes, ReactNode } from "react";

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  children?: ReactNode;
};

export default function Link({ href, children, ...rest }: LinkProps) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
