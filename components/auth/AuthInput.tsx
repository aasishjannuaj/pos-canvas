import type { InputHTMLAttributes } from "react";

type AuthInputProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
};

export default function AuthInput({ label, id, name, ...props }: AuthInputProps) {
  const inputId = id ?? name;

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={inputId}
        className="text-xs font-medium uppercase tracking-wide text-neutral-500"
      >
        {label}
      </label>
      <input
        id={inputId}
        name={name}
        className="rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-900 transition-colors focus:border-blue-600 focus:outline-none"
        {...props}
      />
    </div>
  );
}
