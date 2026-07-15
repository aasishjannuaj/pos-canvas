import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { SavedProject } from "./projects";

export async function getUserProjects(): Promise<{
  projects: SavedProject[];
  error: string | null;
}> {
  const supabase = await createClient();

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  const claims = claimsData?.claims ?? null;

  if (claimsError || !claims) {
    return {
      projects: [],
      error: "You must be signed in to view your projects.",
    };
  }

  const { data, error } = await supabase
    .from("projects")
    .select("id, name, template_id, config, created_at, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    return { projects: [], error: error.message };
  }

  return { projects: data ?? [], error: null };
}

export type { SavedProject };
