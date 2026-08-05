import { notFound } from "next/navigation";
import { getProjectById } from "@/lib/projects.server";
import { isProjectConfig } from "@/lib/projectConfig";
import {
  createGeneratedPosConfig,
  isGeneratedPosConfig,
} from "@/lib/generatedPosConfig";
import PosRuntime from "@/components/runtime/PosRuntime";

const PROJECT_ROUTE_PREFIX = "project-";

function RuntimeErrorState({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-6">
      <div className="max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-neutral-900">{title}</h1>
        <p className="mt-2 text-sm text-neutral-500">{message}</p>
      </div>
    </main>
  );
}

// Feature 14.3 — the standalone runtime viewer's entry point, at
// /runtime/project-{id}. Unlike app/editor/[id]/page.tsx, there is no
// "brand-new unsaved template" branch here: a runtime view only ever makes
// sense for an already-saved, real project, so anything else is rejected
// immediately.
export default async function RuntimePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!id.startsWith(PROJECT_ROUTE_PREFIX)) {
    notFound();
  }

  const projectId = id.slice(PROJECT_ROUTE_PREFIX.length);

  // Feature 14.3 — reuses the exact same auth/ownership check the Builder
  // already relies on (signed-in claims + Supabase RLS on the `projects`
  // table, enforced inside getProjectById) — no new authorization
  // mechanism, no public or anonymous access path.
  const { project, error } = await getProjectById(projectId);

  if (error || !project) {
    notFound();
  }

  // Feature 14.3 — the same structural guard app/editor/[id]/page.tsx uses
  // before trusting project.config at all. A runtime handling real
  // persisted sales must never proceed with a fundamentally malformed
  // config by silently substituting a generic default (unlike a brand-new
  // Builder session, there's no "this is just a fresh unsaved template"
  // framing here) — it shows the same explicit unsupported-configuration
  // state instead.
  if (!isProjectConfig(project.config)) {
    return (
      <RuntimeErrorState
        title="Unsupported configuration"
        message="This project's configuration isn't supported by this runtime viewer yet."
      />
    );
  }

  let generatedConfig;

  try {
    // Feature 14.3 — generated server-side, right alongside the same
    // getProjectById call the Builder itself uses. createGeneratedPosConfig
    // has no React/Supabase/browser dependency, so calling it here (a
    // Server Component) is exactly as safe as calling it from
    // EditorShell's client-side handleExport in Feature 14.2.
    generatedConfig = createGeneratedPosConfig({
      projectId: project.id,
      projectName: project.name,
      templateId: project.template_id,
      config: project.config,
    });
  } catch {
    // createGeneratedPosConfig throws only for an empty/whitespace-only
    // identity field (projectId/projectName/templateId) or an
    // unparseable generatedAt override — none of which this call site ever
    // supplies deliberately, but a corrupted project row could still
    // trigger it. Treated the same as any other unsupported-configuration
    // case rather than crashing the page.
    return (
      <RuntimeErrorState
        title="Unsupported configuration"
        message="This project's configuration isn't supported by this runtime viewer yet."
      />
    );
  }

  // Feature 14.3 — validated even though this feature's only producer is
  // already trusted: this is the reusable boundary every future consumer
  // (a downloaded file, an eventual wrapper) will also need. An
  // unsupported/malformed result here is a distinct failure from "you
  // don't have access" — the project genuinely exists and is owned by this
  // user — so it gets this explicit message rather than notFound().
  if (!isGeneratedPosConfig(generatedConfig)) {
    return (
      <RuntimeErrorState
        title="Unsupported configuration"
        message="This project's configuration isn't supported by this runtime viewer yet."
      />
    );
  }

  return (
    <PosRuntime config={generatedConfig} />
  );
}
