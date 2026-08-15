// Feature 22 Phase 4 — what the dashboard says before an owner has anything.
//
// THE PROBLEM THIS SOLVES: a brand-new account was greeted with "Welcome back",
// a search box that searched nothing, and a bordered box reading "No saved
// projects yet" with no way to act on it. The single most important moment in
// this product — the first one — offered no next step.
//
// WHY THE COPY AND THE STATE LIVE HERE rather than inline in the components:
// this repository has no DOM test environment by design, so branching copy in a
// component is untestable. A pure resolver plus a copy map is the pattern used
// for every other customer-facing label in this codebase (see lib/buildJobs.ts).
//
// THE THIRD STATE IS THE ONE THAT MATTERS. getUserProjects returns an error
// string when the query fails, and the dashboard previously discarded it — so a
// failed load rendered as "you have no projects". That is a lie to an owner who
// has ten, and it would have become a more convincing one the moment the empty
// state grew a "create your first project" headline. `unavailable` exists so
// the empty state means empty, and only empty.

/** What the dashboard actually knows about this owner's projects. */
export type DashboardProjectsState = "ready" | "empty" | "unavailable";

/**
 * The one route that creates a project.
 *
 * Every "create a project" control on the dashboard resolves through this
 * constant, so there is exactly one answer to "where does that button go" and
 * no surface can drift onto a route that does not exist. A project is created
 * by choosing a template — /templates -> /templates/{id} or straight to
 * /editor/{templateId} — which is the existing path, not a new one.
 */
export const CREATE_PROJECT_PATH = "/templates";

/** The first-run label. Names the outcome, not the mechanism. */
export const CREATE_PROJECT_LABEL = "Create Project";

/** The returning-owner label for the same destination. */
export const NEW_PROJECT_LABEL = "New Project";

export type DashboardWelcome = {
  title: string;
  subtitle: string;
  actionLabel: string;
};

const FIRST_RUN_WELCOME: DashboardWelcome = {
  title: "Welcome to POS Canvas",
  subtitle: "Create your first POS project to get started.",
  actionLabel: CREATE_PROJECT_LABEL,
};

const RETURNING_WELCOME: DashboardWelcome = {
  title: "Welcome back",
  subtitle: "Pick up where you left off, or start something new.",
  actionLabel: NEW_PROJECT_LABEL,
};

/**
 * Resolves the dashboard's project state.
 *
 * A load failure is NOT emptiness: `unavailable` deliberately takes precedence
 * over a zero count, because a failed query also returns zero projects.
 */
export function resolveDashboardProjectsState(input: {
  projectCount: number;
  loadFailed: boolean;
}): DashboardProjectsState {
  if (input.loadFailed) {
    return "unavailable";
  }

  return input.projectCount === 0 ? "empty" : "ready";
}

/**
 * The greeting for a given state.
 *
 * "Welcome back" is only ever shown to someone who could plausibly be back. An
 * owner whose projects failed to load is a returning owner, so `unavailable`
 * greets them as one rather than as a first-time visitor.
 */
export function getDashboardWelcome(state: DashboardProjectsState): DashboardWelcome {
  return state === "empty" ? FIRST_RUN_WELCOME : RETURNING_WELCOME;
}
