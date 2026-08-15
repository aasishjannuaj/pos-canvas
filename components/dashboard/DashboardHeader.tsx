"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "@/lib/supabase/auth";
import {
  CREATE_PROJECT_PATH,
  getDashboardWelcome,
  type DashboardProjectsState,
} from "@/lib/dashboardState";

type DashboardHeaderProps = {
  state: DashboardProjectsState;
};

export default function DashboardHeader({ state }: DashboardHeaderProps) {
  const router = useRouter();

  // Feature 22 Phase 4 — "Welcome back" was shown to accounts that had never
  // been anywhere. The greeting and the primary action label now come from the
  // project state (see lib/dashboardState.ts), so a first-time owner is told
  // what to do rather than welcomed back to nothing.
  const welcome = getDashboardWelcome(state);

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
          {welcome.title}
        </h1>
        <p className="text-base text-neutral-600">{welcome.subtitle}</p>
      </div>

      <div className="flex items-center gap-4">
        <Link
          href={CREATE_PROJECT_PATH}
          className="rounded-full bg-blue-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          {welcome.actionLabel}
        </Link>

        <button
          type="button"
          onClick={handleSignOut}
          className="rounded-full border border-neutral-200 px-6 py-3 text-sm font-medium text-neutral-700 transition-colors hover:border-blue-600 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}
