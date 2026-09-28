// v1.3 Task 5A — the owner-facing business timezone: the selection model, and
// what the owner project-update path actually sends.
//
// TWO HALVES, BOTH BEHAVIOURAL. The first is the pure option/display model. The
// second mocks only lib/supabase/client, because the claims worth proving are
// claims about a REQUEST: that a chosen zone reaches `projects.business_timezone`
// through the ordinary RLS update, that an untouched zone is not sent at all,
// and that a database refusal is never dressed up as a save.
//
// WHAT THIS FILE DELIBERATELY DOES NOT RE-TEST. Whether a timezone identifier is
// valid, and whether a change is safe while a register day is open, are database
// decisions owned by projects_validate_business_timezone and proven by
// supabase/migrations/20260920120000_project_business_timezone.db.test.ts and
// 20260928120000_owner_reporting_contracts.db.test.ts. Re-asserting them here
// would create a second, weaker copy of the rule that could drift from it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUSINESS_TIMEZONE_UNSET_LABEL,
  FALLBACK_BUSINESS_TIMEZONES,
  businessTimezoneUpdate,
  describeBusinessTimezone,
  listBusinessTimezoneOptions,
  runtimeSupportedTimezones,
} from "@/lib/businessTimezone";

// ---------------------------------------------------------------------------
// The options are a menu, not a choice
// ---------------------------------------------------------------------------

describe("the timezone options offered to an owner", () => {
  it("uses the runtime's own IANA list when it has one", () => {
    const options = listBusinessTimezoneOptions(
      ["America/New_York", "Europe/London"],
      null
    );

    expect(options).toEqual(["America/New_York", "Europe/London"]);
  });

  it("falls back to a small list of valid identifiers when the runtime cannot enumerate", () => {
    for (const empty of [null, undefined, []]) {
      const options = listBusinessTimezoneOptions(empty, null);

      expect(`fallback for ${JSON.stringify(empty)}`).toBe(
        `fallback for ${JSON.stringify(empty)}`
      );
      expect(options).toEqual([...FALLBACK_BUSINESS_TIMEZONES].sort((a, b) => a.localeCompare(b)));
      expect(options).toContain("America/New_York");
      expect(options).toContain("America/Chicago");
      expect(options).toContain("America/Denver");
      expect(options).toContain("America/Los_Angeles");
    }
  });

  it("is not limited to the four example zones", () => {
    // The brief names four; the product must not be hard-coded to them.
    expect(FALLBACK_BUSINESS_TIMEZONES.length).toBeGreaterThan(4);
  });

  it("always includes the configured zone, even one this runtime cannot name", () => {
    // An owner must be able to SEE what their project is set to. A select that
    // dropped an unrecognised value would show some other zone as selected.
    const options = listBusinessTimezoneOptions(["America/New_York"], "Pacific/Chatham");

    expect(options).toContain("Pacific/Chatham");
    expect(options).toContain("America/New_York");
  });

  it("de-duplicates, drops blanks and sorts deterministically", () => {
    const options = listBusinessTimezoneOptions(
      ["Europe/London", "America/New_York", "Europe/London", "", "   "],
      "America/New_York"
    );

    expect(options).toEqual(["America/New_York", "Europe/London"]);
  });

  it("adds nothing of its own to the list", () => {
    // Every option came from the arguments. In particular the machine's own
    // timezone is not slipped in when it was neither supported-listed nor
    // configured — the list is offered, never seeded from this device.
    const supported = ["America/New_York", "Europe/London"];

    expect(listBusinessTimezoneOptions(supported, null)).toEqual([...supported].sort());

    const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const options = listBusinessTimezoneOptions(["Europe/London"], null);

    expect(options).toEqual(["Europe/London"]);
    if (machineZone !== "Europe/London") expect(options).not.toContain(machineZone);
  });

  it("reads the runtime capability without throwing on a runtime that lacks it", () => {
    // Node 24 has supportedValuesOf; the guard exists for runtimes that do not.
    const zones = runtimeSupportedTimezones();

    expect(zones === null || Array.isArray(zones)).toBe(true);
    if (zones) expect(zones).toContain("America/New_York");
  });
});

// ---------------------------------------------------------------------------
// Unset stays unset
// ---------------------------------------------------------------------------

describe("a project with no configured timezone", () => {
  it("displays as unset rather than as a plausible zone", () => {
    expect(describeBusinessTimezone(null)).toBe(BUSINESS_TIMEZONE_UNSET_LABEL);
    expect(describeBusinessTimezone(undefined)).toBe(BUSINESS_TIMEZONE_UNSET_LABEL);
    expect(describeBusinessTimezone("   ")).toBe(BUSINESS_TIMEZONE_UNSET_LABEL);
    expect(BUSINESS_TIMEZONE_UNSET_LABEL).toBe("Not set");
  });

  it("displays a configured zone exactly as stored", () => {
    expect(describeBusinessTimezone("America/Chicago")).toBe("America/Chicago");
  });

  it("is not filled in from the machine's own timezone", () => {
    // The strongest form of the rule: whatever this machine thinks it is, an
    // unconfigured project still reads "Not set".
    const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    expect(typeof machineZone).toBe("string");
    expect(describeBusinessTimezone(null)).not.toBe(machineZone);
    expect(businessTimezoneUpdate(null, null)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// What a save carries
// ---------------------------------------------------------------------------

describe("whether a save carries business_timezone at all", () => {
  it("omits it when the owner did not change it", () => {
    expect(businessTimezoneUpdate("America/New_York", "America/New_York")).toEqual({});
    expect(businessTimezoneUpdate(null, null)).toEqual({});
  });

  it("sends it when the owner chose a different zone", () => {
    expect(businessTimezoneUpdate(null, "America/Denver")).toEqual({
      businessTimezone: "America/Denver",
    });
    expect(businessTimezoneUpdate("America/Denver", "America/Chicago")).toEqual({
      businessTimezone: "America/Chicago",
    });
  });
});

// ---------------------------------------------------------------------------
// The owner update path, observed
// ---------------------------------------------------------------------------

// Typed rather than bare vi.fn(): the assertions below read
// `update.mock.calls[0][0]`, and an untyped mock makes that an empty tuple —
// which type-checks as an error rather than as the payload this file is about.
type QueryResult = { data: unknown; error: { message: string } | null };
type Payload = Record<string, unknown>;

const single = vi.fn<() => Promise<QueryResult>>(async () => ({
  data: { id: "project-1" },
  error: null,
}));
const select = vi.fn(() => ({ single }));
const eq = vi.fn<(column: string, value: string) => { select: typeof select }>(() => ({
  select,
}));
const update = vi.fn<(payload: Payload) => { eq: typeof eq }>(() => ({ eq }));
const insert = vi.fn<(payload: Payload) => { select: typeof select }>(() => ({ select }));
const from = vi.fn<
  (table: string) => { update: typeof update; insert: typeof insert }
>(() => ({ update, insert }));
const getUser = vi.fn<
  () => Promise<{
    data: { user: { id: string } | null };
    error: { message: string } | null;
  }>
>(async () => ({ data: { user: { id: "owner-1" } }, error: null }));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ from, auth: { getUser } }),
}));

const { saveNewProject, updateProject, BUSINESS_TIMEZONE_BLOCKED_MESSAGE, BUSINESS_TIMEZONE_INVALID_MESSAGE } =
  await import("@/lib/projects");

const CONFIG = { menuItems: [], branding: { accentColor: "#000000" } } as never;

beforeEach(() => {
  for (const spy of [single, select, eq, update, insert, from, getUser]) spy.mockClear();
  getUser.mockResolvedValue({ data: { user: { id: "owner-1" } }, error: null });
  single.mockResolvedValue({ data: { id: "project-1" }, error: null });
});

describe("saving a business timezone through the owner project path", () => {
  it("writes the chosen IANA zone to projects.business_timezone", async () => {
    const result = await updateProject({
      projectId: "project-1",
      name: "Cafe",
      config: CONFIG,
      businessTimezone: "America/Chicago",
    });

    expect(result.error).toBeNull();
    expect(from).toHaveBeenCalledWith("projects");
    expect(update.mock.calls[0][0]).toMatchObject({
      business_timezone: "America/Chicago",
    });
    // The ordinary owner update, scoped by id and constrained by RLS — no RPC,
    // no service role, no second write path.
    expect(eq).toHaveBeenCalledWith("id", "project-1");
  });

  it("does not touch the column on a save that did not change it", async () => {
    await updateProject({ projectId: "project-1", name: "Cafe", config: CONFIG });

    expect(Object.keys(update.mock.calls[0][0])).not.toContain("business_timezone");
  });

  it("carries a first-save choice through the create path", async () => {
    await saveNewProject({
      name: "Cafe",
      templateId: "cafe",
      config: CONFIG,
      businessTimezone: "America/Denver",
    });

    expect(insert.mock.calls[0][0]).toMatchObject({ business_timezone: "America/Denver" });
  });

  it("creates a project with no timezone when the owner chose none", async () => {
    await saveNewProject({ name: "Cafe", templateId: "cafe", config: CONFIG });

    expect(Object.keys(insert.mock.calls[0][0])).not.toContain("business_timezone");
  });

  it("never sends the machine's timezone on the owner's behalf", async () => {
    const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    await updateProject({ projectId: "project-1", name: "Cafe", config: CONFIG });
    await saveNewProject({ name: "Cafe", templateId: "cafe", config: CONFIG });

    expect(JSON.stringify(update.mock.calls[0][0])).not.toContain(machineZone);
    expect(JSON.stringify(insert.mock.calls[0][0])).not.toContain(machineZone);
    expect(JSON.stringify(update.mock.calls[0][0])).not.toContain("UTC");
  });
});

describe("when the database refuses the timezone", () => {
  it("reports an invalid identifier as unsaved, in words an owner can act on", async () => {
    single.mockResolvedValue({
      data: null,
      error: { message: 'Invalid business timezone: "Mars/Olympus"' },
    });

    const result = await updateProject({
      projectId: "project-1",
      name: "Cafe",
      config: CONFIG,
      businessTimezone: "Mars/Olympus",
    });

    // NOT SAVED: no project comes back, and the message is the refusal.
    expect(result.project).toBeNull();
    expect(result.error).toBe(BUSINESS_TIMEZONE_INVALID_MESSAGE);
  });

  it("translates business_timezone_change_blocked_open_register truthfully", async () => {
    single.mockResolvedValue({
      data: null,
      error: {
        message:
          'business_timezone_change_blocked_open_register: register day 2026-09-28 is open',
      },
    });

    const result = await updateProject({
      projectId: "project-1",
      name: "Cafe",
      config: CONFIG,
      businessTimezone: "America/Chicago",
    });

    expect(result.project).toBeNull();
    expect(result.error).toBe(BUSINESS_TIMEZONE_BLOCKED_MESSAGE);
    // Says what happened and what to do, without naming the trigger.
    expect(result.error).toContain("register");
    expect(result.error).not.toContain("business_timezone_change_blocked_open_register");
  });

  it("surfaces a refusal from the create path too", async () => {
    single.mockResolvedValue({
      data: null,
      error: { message: 'Invalid business timezone: ""' },
    });

    const result = await saveNewProject({
      name: "Cafe",
      templateId: "cafe",
      config: CONFIG,
      businessTimezone: "",
    });

    expect(result.project).toBeNull();
    expect(result.error).toBe(BUSINESS_TIMEZONE_INVALID_MESSAGE);
  });
});
