import { afterEach, describe, expect, it } from "vitest";
import { createAdminClient } from "@/lib/supabase/admin";

// Feature 15.3 correction — these tests validate only the configuration
// guard (missing/present env vars), never a real service-role key value —
// no real credential is embedded anywhere in this file. Restores the
// original environment after each test so this suite can never leak state
// into any other test file.
const ORIGINAL_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ORIGINAL_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

describe("createAdminClient", () => {
  afterEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_SERVICE_ROLE_KEY;
  });

  it("throws a concise error when the service role key is missing", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => createAdminClient()).toThrow(
      "createAdminClient: required Supabase server configuration is missing."
    );
  });

  it("throws a concise error when the Supabase URL is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-placeholder-not-a-real-key";

    expect(() => createAdminClient()).toThrow(
      "createAdminClient: required Supabase server configuration is missing."
    );
  });

  it("throws when both required variables are missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => createAdminClient()).toThrow();
  });

  it("does not throw when both required variables are present", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-placeholder-not-a-real-key";

    expect(() => createAdminClient()).not.toThrow();
  });

  it("never includes the configured key value or its env var name in the thrown message", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    try {
      createAdminClient();
      throw new Error("expected createAdminClient to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(message.toLowerCase()).not.toContain("service_role");
    }
  });
});
