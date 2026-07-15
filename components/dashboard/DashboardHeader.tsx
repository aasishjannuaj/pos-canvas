"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/supabase/auth";

export default function DashboardHeader() {
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
          Welcome back
        </h1>
        <p className="text-base text-neutral-600">
          Pick up where you left off, or start something new.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <button
          type="button"
          className="rounded-full bg-blue-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          New Project
        </button>

        <button
          type="button"
          onClick={handleSignOut}
          className="rounded-full border border-neutral-200 px-6 py-3 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Sign Out
        </button>

        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-200 text-sm font-semibold text-neutral-700">
          PC
        </div>
      </div>
    </div>
  );
}
