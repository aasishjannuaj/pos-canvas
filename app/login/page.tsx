"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import AuthCard from "@/components/auth/AuthCard";
import AuthInput from "@/components/auth/AuthInput";
import AuthButton from "@/components/auth/AuthButton";
import AuthFooter from "@/components/auth/AuthFooter";
import { signIn } from "@/lib/supabase/auth";
import { getAuthErrorMessage } from "@/lib/authErrors";
import { LOGIN_REASON_PARAM, getLoginNotice } from "@/lib/sessionNotice";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Feature 22 Phase 4 — set only when a protected route bounced this visitor
  // here. The URL carries an opaque code and nothing else: the sentence itself
  // lives in lib/sessionNotice.ts, and an unrecognised code renders nothing, so
  // no link can put text of its own choosing on this page.
  const notice = getLoginNotice(searchParams.get(LOGIN_REASON_PARAM));

  // Feature 22 Phase 1 — a real <form> with onSubmit, replacing a button with
  // an onClick handler. Pressing Enter in either field now signs in, which is
  // what every password manager and every keyboard user expects; previously it
  // did nothing at all.
  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isLoading) {
      return;
    }

    setError(null);
    setIsLoading(true);

    const { error: signInError } = await signIn(email, password);

    setIsLoading(false);

    if (signInError) {
      // Mapped, never rendered raw: the provider's own strings vary by version
      // and occasionally carry internals. See lib/authErrors.ts.
      setError(getAuthErrorMessage(signInError, "sign_in"));
      return;
    }

    router.push("/dashboard");
  }

  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to keep building your POS."
      footer={
        <AuthFooter
          prompt="Don't have an account?"
          linkLabel="Create one"
          href="/signup"
        />
      }
    >
      {/* Dropped once the owner has a fresher answer on screen: a sign-in
          failure is about this attempt, and the expired session is history. */}
      {notice && !error && (
        <p
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          {notice}
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
        <AuthInput
          label="Email"
          type="email"
          name="email"
          placeholder="you@example.com"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <div className="flex flex-col gap-1.5">
          <AuthInput
            label="Password"
            type="password"
            name="password"
            placeholder="••••••••"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />

          <Link
            href="/forgot-password"
            className="self-end text-sm font-medium text-blue-600 transition-colors hover:text-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            Forgot password?
          </Link>
        </div>

        <AuthButton type="submit" disabled={isLoading}>
          {isLoading ? "Signing in..." : "Continue"}
        </AuthButton>

        {error && (
          <p aria-live="polite" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </form>
    </AuthCard>
  );
}

// useSearchParams requires a Suspense boundary during prerendering — the same
// pattern the recovery request page already uses.
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <AuthCard title="Welcome back" subtitle="Sign in to keep building your POS.">
          <p className="text-sm text-neutral-500">Loading…</p>
        </AuthCard>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
