import PageContainer from "@/components/common/PageContainer";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import SearchBar from "@/components/dashboard/SearchBar";
import RecentProjects from "@/components/dashboard/RecentProjects";
import TrendingTemplates from "@/components/dashboard/TrendingTemplates";
import CategorySection from "@/components/dashboard/CategorySection";
import AndroidAppCard from "@/components/dashboard/AndroidAppCard";
import { getUserProjects } from "@/lib/projects.server";

export default async function DashboardHome() {
  const { projects } = await getUserProjects();

  return (
    <main className="min-h-screen bg-neutral-50">
      <PageContainer>
        <div className="flex flex-col gap-14">
          <DashboardHeader />
          <SearchBar />
          <RecentProjects projects={projects} />
          {/* Feature 21 — the UNIVERSAL Android app, at account level rather
              than inside any project: one binary serves every customer, and a
              project's own build artifact is a different thing entirely. */}
          <AndroidAppCard />
          <TrendingTemplates />
          <CategorySection />
        </div>
      </PageContainer>
    </main>
  );
}
