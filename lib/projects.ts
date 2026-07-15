import { createClient } from "@/lib/supabase/client";
import type { ProjectConfig } from "@/components/editor/EditorShell";

type SaveNewProjectInput = {
  name: string;
  templateId: string;
  config: ProjectConfig;
};

export async function saveNewProject({
  name,
  templateId,
  config,
}: SaveNewProjectInput) {
  const supabase = createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return {
      project: null,
      error: "You must be signed in to save a project.",
    };
  }

  const { data, error } = await supabase
    .from("projects")
    .insert({
      user_id: user.id,
      name,
      template_id: templateId,
      config,
    })
    .select()
    .single();

  if (error) {
    return { project: null, error: error.message };
  }

  return { project: data, error: null };
}
