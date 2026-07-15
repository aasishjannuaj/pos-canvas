"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AuthCard from "@/components/auth/AuthCard";
import AuthInput from "@/components/auth/AuthInput";
import AuthButton from "@/components/auth/AuthButton";
import AuthFooter from "@/components/auth/AuthFooter";
import { signUp } from "@/lib/supabase/auth";

export default function SignupPage() {
  const router = useRouter();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsLoading(true);

    const { error: signUpError } = await signUp(email, password);

    setIsLoading(false);

    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    router.push("/dashboard");
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

      <AuthButton onClick={handleContinue} disabled={isLoading}>
        {isLoading ? "Creating account..." : "Continue"}
      </AuthButton>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </AuthCard>
  );
}
