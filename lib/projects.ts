import { createClient } from "@/lib/supabase/client";
import type { ProjectConfig } from "@/components/editor/EditorShell";

type SaveNewProjectInput = {
  name: string;
  templateId: string;
  config: ProjectConfig;
  /**
   * v1.3 Task 5A — the IANA business timezone, when the owner chose one before
   * the project's first save.
   *
   * OMITTED MEANS "leave it unset", exactly as UpdateProjectInput's omission
   * means "leave it alone". Nothing infers a value here: a project created
   * without a deliberate choice is created with no timezone, and
   * projects_validate_business_timezone validates this on INSERT as well as on
   * UPDATE (the trigger is `before insert or update of business_timezone`), so
   * an invalid identifier is refused by the database rather than by a client
   * rule that could drift from it.
   */
  businessTimezone?: string | null;
};

export async function saveNewProject({
  name,
  templateId,
  config,
  businessTimezone,
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
      // Spread for the same reason as updateProject below: an omitted timezone
      // must leave the column at its default null, not write an invented one.
      ...(businessTimezone !== undefined ? { business_timezone: businessTimezone } : {}),
    })
    .select()
    .single();

  if (error) {
    return { project: null, error: describeProjectUpdateError(error.message) };
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
  /**
   * Batch A (Inventory foundations) — the catalog version the editor's copy was
   * loaded at. The database refuses a STRUCTURAL change (an item added or
   * removed) whose base is not the current version, so a stale tab can neither
   * delete an item added elsewhere nor resurrect one deleted elsewhere. Live
   * stock and tracking in the payload are ignored by the database (they change
   * only through the audited stock actions), so they cannot be overwritten.
   * Omitted means "no base": structural changes are then refused.
   */
  baseCatalogVersion?: number | null;
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

  if (message.includes("catalog_conflict")) {
    return CATALOG_CONFLICT_MESSAGE;
  }

  if (message.includes("item_id_retired")) {
    return ITEM_ID_RETIRED_MESSAGE;
  }

  if (message.includes("invalid_opening_stock")) {
    return INVALID_OPENING_STOCK_MESSAGE;
  }

  return message;
}

export const CATALOG_CONFLICT_MESSAGE =
  "Items were added or removed in another window since this page was loaded. Reload before saving; nothing was changed.";

export const ITEM_ID_RETIRED_MESSAGE =
  "A deleted item cannot be brought back. Add it as a new item instead; nothing was changed.";

export const INVALID_OPENING_STOCK_MESSAGE =
  "Opening stock must be a whole number from 0 to 1,000,000,000.";

export async function updateProject({
  projectId,
  name,
  config,
  businessTimezone,
  baseCatalogVersion,
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
      // Batch A — checked and cleared by the database on every save.
      base_catalog_version: baseCatalogVersion ?? null,
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
  /**
   * v1.3 Task 5A — the project's authoritative business timezone, or null when
   * the owner has not configured one yet. Null is a real, displayable state.
   */
  business_timezone: string | null;
  /** Batch A — structural catalog version (items added/removed, tracking changed). */
  catalog_version?: number;
  created_at: string;
  updated_at: string;
};
