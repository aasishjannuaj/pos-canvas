"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import AuthCard from "@/components/auth/AuthCard";
import AuthInput from "@/components/auth/AuthInput";
import AuthButton from "@/components/auth/AuthButton";
import AuthFooter from "@/components/auth/AuthFooter";
import { requestPasswordReset } from "@/lib/supabase/auth";
import { PASSWORD_RESET_REQUEST_RESULT } from "@/lib/authErrors";

// Feature 22 Phase 1 — request a password-recovery email.
//
// NON-ENUMERATION IS THE GOVERNING RULE. This form renders exactly one result
// string whether the address has an account, has no account, or the request
// failed outright. It does not branch on the Supabase response at all — the
// error is deliberately discarded rather than mapped, because any difference in
// output (message, timing branch, or a visible error state) turns this page
// into an oracle for "does this person have a POS Canvas account".
//
// That is also why there is no retry-on-error affordance: from the owner's
// side, a failed send and a nonexistent account look identical, and the remedy
// for both is the same — check the inbox, then request again.

function ForgotPasswordForm() {
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Set by the callback route when a recovery link could not be exchanged.
  const linkFailed = searchParams.get("reason") === "invalid-or-expired";

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    const trimmed = email.trim();

    // The only branch permitted before submission: an empty box is a typo, not
    // a signal about the account. Format is left to the provider.
    if (trimmed === "") {
      setValidationError("Enter the email address you use for POS Canvas.");
      return;
    }

    setValidationError(null);
    setIsSubmitting(true);

    // The result is intentionally ignored. See the non-enumeration note above.
    await requestPasswordReset(trimmed);

    setIsSubmitting(false);
    setSubmitted(true);
  }

  return (
    <AuthCard
      title="Forgot your password?"
      subtitle="Enter the email address you use for POS Canvas."
      footer={
        <AuthFooter
          prompt="Remembered it?"
          linkLabel="Back to sign in"
          href="/login"
        />
      }
    >
      {linkFailed && !submitted && (
        <p
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          That password reset link is invalid or has expired. Request a new one
          below.
        </p>
      )}

      {submitted ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700"
        >
          {PASSWORD_RESET_REQUEST_RESULT}
        </p>
      ) : (
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

          <AuthButton type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Sending…" : "Send reset link"}
          </AuthButton>

          {validationError && (
            <p aria-live="polite" className="text-sm text-red-600">
              {validationError}
            </p>
          )}
        </form>
      )}
    </AuthCard>
  );
}

// useSearchParams requires a Suspense boundary during prerendering.
export default function ForgotPasswordPage() {
  return (
    <Suspense
      fallback={
        <AuthCard
          title="Forgot your password?"
          subtitle="Enter the email address you use for POS Canvas."
        >
          <p className="text-sm text-neutral-500">Loading…</p>
        </AuthCard>
      }
    >
      <ForgotPasswordForm />
    </Suspense>
  );
}
