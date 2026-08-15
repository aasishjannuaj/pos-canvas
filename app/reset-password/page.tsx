"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AuthCard from "@/components/auth/AuthCard";
import AuthInput from "@/components/auth/AuthInput";
import AuthButton from "@/components/auth/AuthButton";
import {
  MIN_PASSWORD_LENGTH,
  getAuthErrorMessage,
  validateNewPassword,
} from "@/lib/authErrors";
import { getCurrentSession, updatePassword } from "@/lib/supabase/auth";

// Feature 22 Phase 1 — choose a new password.
//
// Reached only from app/auth/callback/route.ts, which has already exchanged the
// one-time recovery code for a session. This page therefore does not read the
// code, the token, or anything from the URL: it asks whether a session exists
// and renders one of three states from that answer.
//
// WHY THE SESSION IS CHECKED BEFORE RENDERING THE FORM: a recovery link that
// has expired or already been used produces no session, and showing a password
// form that is guaranteed to fail on submit is worse than saying so up front.
// The expired state offers the one action that actually helps — request a new
// link — rather than leaving a dead form on screen.

type SessionState = "checking" | "ready" | "expired";

export default function ResetPasswordPage() {
  const router = useRouter();

  const [sessionState, setSessionState] = useState<SessionState>("checking");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  useEffect(() => {
    let active = true;

    async function checkSession() {
      const { session } = await getCurrentSession();

      if (!active) {
        return;
      }

      setSessionState(session ? "ready" : "expired");
    }

    checkSession();

    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    // Client-side check first, so an obviously invalid pair costs no round trip.
    // The server remains the authority and rejects independently.
    const validationError = validateNewPassword(password, confirmation);

    if (validationError !== null) {
      setError(validationError);
      return;
    }

    setError(null);
    setIsSubmitting(true);

    const { error: updateError } = await updatePassword(password);

    setIsSubmitting(false);

    if (updateError) {
      setError(getAuthErrorMessage(updateError, "update_password"));
      return;
    }

    // The recovery session is a real signed-in session, so the owner is already
    // authenticated once the password changes — no second sign-in needed.
    setSucceeded(true);
    router.push("/dashboard");
  }

  if (sessionState === "checking") {
    return (
      <AuthCard title="Create a new password">
        <p className="text-sm text-neutral-500">Checking your reset link…</p>
      </AuthCard>
    );
  }

  if (sessionState === "expired") {
    return (
      <AuthCard title="Reset link expired">
        <p
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          This password reset link has expired or has already been used.
        </p>

        <Link
          href="/forgot-password"
          className="w-full rounded-full bg-blue-600 px-4 py-2.5 text-center text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Request a new link
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create a new password"
      subtitle={`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
        <AuthInput
          label="New password"
          type="password"
          name="new-password"
          placeholder="••••••••"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        <AuthInput
          label="Confirm new password"
          type="password"
          name="confirm-password"
          placeholder="••••••••"
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />

        <AuthButton type="submit" disabled={isSubmitting || succeeded}>
          {isSubmitting ? "Updating…" : "Update password"}
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
