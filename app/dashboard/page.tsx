import PageContainer from "@/components/common/PageContainer";
import DashboardHeader from "@/components/dashboard/DashboardHeader";
import SearchBar from "@/components/dashboard/SearchBar";
import RecentProjects from "@/components/dashboard/RecentProjects";
import TrendingTemplates from "@/components/dashboard/TrendingTemplates";
import CategorySection from "@/components/dashboard/CategorySection";

export default function DashboardHome() {
  return (
    <main className="min-h-screen bg-neutral-50">
      <PageContainer>
        <div className="flex flex-col gap-14">
          <DashboardHeader />
          <SearchBar />
          <RecentProjects />
          <TrendingTemplates />
          <CategorySection />
        </div>
      </PageContainer>
    </main>
  );
}
