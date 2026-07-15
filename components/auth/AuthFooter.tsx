import Link from "next/link";

type AuthFooterProps = {
  prompt: string;
  linkLabel: string;
  href: string;
};

export default function AuthFooter({ prompt, linkLabel, href }: AuthFooterProps) {
  return (
    <p className="text-sm text-neutral-600">
      {prompt}{" "}
      <Link
        href={href}
        className="font-medium text-blue-600 transition-colors hover:text-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        {linkLabel}
      </Link>
    </p>
  );
}
