import type { ReactNode } from "react";

type AuthCardProps = {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
};

export default function AuthCard({ title, subtitle, children, footer }: AuthCardProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-12">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm sm:p-10">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-2 text-sm text-neutral-600">{subtitle}</p>
          )}
        </div>

        <div className="flex flex-col gap-5">{children}</div>

        {footer && <div className="mt-8 text-center">{footer}</div>}
      </div>
    </div>
  );
}
