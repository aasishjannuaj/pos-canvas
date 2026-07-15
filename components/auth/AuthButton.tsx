import type { ButtonHTMLAttributes } from "react";

type AuthButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export default function AuthButton({ children, className, ...props }: AuthButtonProps) {
  return (
    <button
      type="button"
      className={`w-full rounded-full bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
        className ?? ""
      }`}
      {...props}
    >
      {children}
    </button>
  );
}
