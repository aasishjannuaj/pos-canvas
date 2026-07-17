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

type UpdateProjectInput = {
  projectId: string;
  name: string;
  config: ProjectConfig;
};

export async function updateProject({
  projectId,
  name,
  config,
}: UpdateProjectInput) {
  const supabase = createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return {
      project: null,
      error: "You must be signed in to update a project.",
    };
  }

  const { data, error } = await supabase
    .from("projects")
    .update({
      name,
      config,
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId)
    .select()
    .single();

  if (error) {
    return { project: null, error: error.message };
  }

  return { project: data, error: null };
}

// Feature 9.3 — read-only reload of the latest database config for a project.
// Used after a completed sale to pull back the inventory numbers the
// complete_sale RPC just computed, without the client ever writing inventory
// itself. Selects only the config column; relies on RLS, no service-role key.
export async function getProjectConfig(projectId: string): Promise<{
  config: ProjectConfig | null;
  error: string | null;
}> {
  const supabase = createClient();

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return {
      config: null,
      error: "You must be signed in to reload this project.",
    };
  }

  const { data, error } = await supabase
    .from("projects")
    .select("config")
    .eq("id", projectId)
    .single();

  if (error) {
    return { config: null, error: error.message };
  }

  return { config: data.config as ProjectConfig, error: null };
}

export type SavedProject = {
  id: string;
  name: string;
  template_id: string;
  config: ProjectConfig;
  created_at: string;
  updated_at: string;
};
