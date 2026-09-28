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
  /**
   * v1.3 Feature 1F — the project's IANA business timezone, or null to clear it.
   *
   * OMITTED MEANS UNTOUCHED, and that distinction is load-bearing: `undefined`
   * leaves the column alone, while an explicit `null` is a real request to
   * clear it. Sending `null` for every save would silently wipe a configured
   * timezone and stop every till selling.
   *
   * THE COLUMN IS WRITTEN THROUGH THE ORDINARY RLS UPDATE, not an RPC. The
   * "Users can update their own projects" policy is the whole authorization
   * story, and the database validates the value and refuses an unsafe change
   * through projects_validate_business_timezone -- which is why there is no
   * client-side timezone rule here to drift from it.
   */
  businessTimezone?: string | null;
};

/**
 * What the database said when it refused a timezone write, in words.
 *
 * The two refusals mean very different things to an owner: one is "that is not
 * a timezone", the other is "a till is mid-day, come back after it closes". A
 * single generic message would send them to fix the wrong thing.
 */
export const BUSINESS_TIMEZONE_BLOCKED_MESSAGE =
  "A register is open for this business day. Change the timezone once it has closed.";

export const BUSINESS_TIMEZONE_INVALID_MESSAGE =
  "Choose a timezone such as America/New_York.";

export function describeProjectUpdateError(message: string): string {
  if (message.includes("business_timezone_change_blocked_open_register")) {
    return BUSINESS_TIMEZONE_BLOCKED_MESSAGE;
  }

  if (message.includes("Invalid business timezone")) {
    return BUSINESS_TIMEZONE_INVALID_MESSAGE;
  }

  return message;
}

export async function updateProject({
  projectId,
  name,
  config,
  businessTimezone,
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
      // Spread, not a plain key: an omitted businessTimezone must leave the
      // column alone rather than write undefined/null over a real value.
      ...(businessTimezone !== undefined ? { business_timezone: businessTimezone } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId)
    .select()
    .single();

  if (error) {
    return { project: null, error: describeProjectUpdateError(error.message) };
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
