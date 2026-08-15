// Feature 22 Phase 4 — the dashboard's three states and their copy.
import { describe, expect, it } from "vitest";
import {
  CREATE_PROJECT_LABEL,
  CREATE_PROJECT_PATH,
  NEW_PROJECT_LABEL,
  getDashboardWelcome,
  resolveDashboardProjectsState,
} from "@/lib/dashboardState";

describe("resolveDashboardProjectsState", () => {
  it("is empty for a brand-new account", () => {
    expect(
      resolveDashboardProjectsState({ projectCount: 0, loadFailed: false })
    ).toBe("empty");
  });

  it("is ready once a project exists", () => {
    expect(
      resolveDashboardProjectsState({ projectCount: 1, loadFailed: false })
    ).toBe("ready");
  });

  it("treats a failed load as unavailable, never as empty", () => {
    // THE BUG THIS EXISTS FOR: a failed query also returns zero projects, so a
    // count-only rule would greet an owner with ten projects as a new signup
    // and invite them to create their first one.
    expect(
      resolveDashboardProjectsState({ projectCount: 0, loadFailed: true })
    ).toBe("unavailable");
  });

  it("prefers unavailable even when projects came back", () => {
    expect(
      resolveDashboardProjectsState({ projectCount: 3, loadFailed: true })
    ).toBe("unavailable");
  });
});

describe("getDashboardWelcome", () => {
  it("greets a first-time owner with a first-time instruction", () => {
    const welcome = getDashboardWelcome("empty");

    expect(welcome.title).toBe("Welcome to POS Canvas");
    expect(welcome.subtitle).toBe("Create your first POS project to get started.");
    expect(welcome.actionLabel).toBe(CREATE_PROJECT_LABEL);
  });

  it("welcomes a returning owner back", () => {
    const welcome = getDashboardWelcome("ready");

    expect(welcome.title).toBe("Welcome back");
    expect(welcome.actionLabel).toBe(NEW_PROJECT_LABEL);
  });

  it("does not call a failed load a first visit", () => {
    // "Welcome to POS Canvas — create your first project" is the wrong thing to
    // say to someone whose projects merely failed to load.
    expect(getDashboardWelcome("unavailable")).toEqual(getDashboardWelcome("ready"));
  });

  it("always offers an action label", () => {
    for (const state of ["empty", "ready", "unavailable"] as const) {
      expect(getDashboardWelcome(state).actionLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("the create-project destination", () => {
  it("is the existing template gallery, not a new wizard route", () => {
    expect(CREATE_PROJECT_PATH).toBe("/templates");
  });

  it("is an internal path", () => {
    expect(CREATE_PROJECT_PATH.startsWith("/")).toBe(true);
    expect(CREATE_PROJECT_PATH).not.toContain("://");
  });

  it("uses the locked product vocabulary", () => {
    for (const label of [CREATE_PROJECT_LABEL, NEW_PROJECT_LABEL]) {
      const lower = label.toLowerCase();
      for (const banned of ["build", "app", "apk", "download", "publish"]) {
        expect(lower).not.toContain(banned);
      }
    }
  });
});
