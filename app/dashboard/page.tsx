import PageContainer from "@/components/common/PageContainer";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import RecentProjects from "@/components/dashboard/RecentProjects";
import TrendingTemplates from "@/components/dashboard/TrendingTemplates";
import AndroidAppCard from "@/components/dashboard/AndroidAppCard";
import { getUserProjects } from "@/lib/projects.server";
import { resolveDashboardProjectsState } from "@/lib/dashboardState";

export default async function DashboardHome() {
  const { projects, error } = await getUserProjects();

  // Feature 22 Phase 4 — the load error is no longer discarded. It is turned
  // into a state, never into a message: the provider's own error string never
  // reaches this page's output. See lib/dashboardState.ts.
  const state = resolveDashboardProjectsState({
    projectCount: projects.length,
    loadFailed: error !== null,
  });

  return (
    <main className="min-h-screen bg-neutral-50">
      <PageContainer>
        <div className="flex flex-col gap-14">
          <DashboardHeader state={state} />
          <RecentProjects projects={projects} state={state} />
          {/* Feature 21 — the UNIVERSAL Android app, at account level rather
              than inside any project: one binary serves every customer, and a
              project's own build artifact is a different thing entirely.
              Kept on the zero-project dashboard on purpose — an owner who has
              not built anything yet is exactly who needs to know the app
              exists before they wonder what a published configuration is for. */}
          <AndroidAppCard />
          <TrendingTemplates />
        </div>
      </PageContainer>
    </main>
  );
}
