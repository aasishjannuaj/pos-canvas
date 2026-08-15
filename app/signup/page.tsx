"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AuthCard from "@/components/auth/AuthCard";
import AuthInput from "@/components/auth/AuthInput";
import AuthButton from "@/components/auth/AuthButton";
import AuthFooter from "@/components/auth/AuthFooter";
import { signUp } from "@/lib/supabase/auth";
import { getAuthErrorMessage } from "@/lib/authErrors";

export default function SignupPage() {
  const router = useRouter();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Feature 22 Phase 1 — set only in the defensive branch below, never on the
  // normal production path.
  const [confirmationRequired, setConfirmationRequired] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isLoading) {
      return;
    }

    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsLoading(true);

    const { data, error: signUpError } = await signUp(email, password);

    setIsLoading(false);

    if (signUpError) {
      setError(getAuthErrorMessage(signUpError, "sign_up"));
      return;
    }

    // Feature 22 Phase 1 — DEFENSIVE, not the expected path.
    //
    // "Confirm email" is OFF in production, so signUp returns a live session
    // and the owner goes straight to the dashboard. But the previous code
    // navigated unconditionally, which meant that if confirmation were ever
    // switched on — or Supabase returned no session for any other reason — the
    // owner was pushed to /dashboard with no session, silently bounced back to
    // /login by the proxy, and left with no idea what had happened or whether
    // their account had been created.
    //
    // Checking for the session costs nothing and turns that dead end into an
    // accurate instruction. No email-confirmation callback infrastructure is
    // added: this branch only explains, and the recovery callback route already
    // covers the one link type this product actually sends.
    if (!data.session) {
      setConfirmationRequired(true);
      return;
    }

    router.push("/dashboard");
  }

  if (confirmationRequired) {
    return (
      <AuthCard
        title="Check your email"
        subtitle="One more step to finish creating your account."
        footer={
          <AuthFooter
            prompt="Already confirmed?"
            linkLabel="Sign in"
            href="/login"
          />
        }
      >
        <p
          role="status"
          className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700"
        >
          Check your email to finish creating your account, then sign in.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      subtitle="Set up a POS Canvas account to save your projects."
      footer={
        <AuthFooter
          prompt="Already have an account?"
          linkLabel="Sign in"
          href="/login"
        />
      }
    >
      {/* Feature 22 Phase 1 — a real <form>, so Enter submits and password
          managers can offer to save the new credentials. */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <AuthInput
            label="First Name"
            type="text"
            name="firstName"
            placeholder="Jamie"
            autoComplete="given-name"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
          />

          <AuthInput
            label="Last Name"
            type="text"
            name="lastName"
            placeholder="Rivera"
            autoComplete="family-name"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
          />
        </div>

        <AuthInput
          label="Email"
          type="email"
          name="email"
          placeholder="you@example.com"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />

        <AuthInput
          label="Password"
          type="password"
          name="password"
          placeholder="••••••••"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <AuthInput
          label="Confirm Password"
          type="password"
          name="confirmPassword"
          placeholder="••••••••"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />

        <AuthButton type="submit" disabled={isLoading}>
          {isLoading ? "Creating account..." : "Continue"}
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
