"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import AuthCard from "@/components/auth/AuthCard";
import AuthInput from "@/components/auth/AuthInput";
import AuthButton from "@/components/auth/AuthButton";
import AuthFooter from "@/components/auth/AuthFooter";
import { signIn } from "@/lib/supabase/auth";

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue() {
    setError(null);
    setIsLoading(true);

    const { error: signInError } = await signIn(email, password);

    setIsLoading(false);

    if (signInError) {
      setError(signInError.message);
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
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />

      <AuthButton onClick={handleContinue} disabled={isLoading}>
        {isLoading ? "Signing in..." : "Continue"}
      </AuthButton>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </AuthCard>
  );
}
