import { describe, expect, it } from "vitest";
import { getAdminSupabaseConfig } from "@/lib/supabase/adminConfig";

describe("getAdminSupabaseConfig", () => {
  it("returns both values when present", () => {
    const config = getAdminSupabaseConfig({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "the-secret-key",
    });

    expect(config).toEqual({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "the-secret-key",
    });
  });

  it("throws a fixed, secret-free message when the URL is missing", () => {
    expect(() =>
      getAdminSupabaseConfig({
        NEXT_PUBLIC_SUPABASE_URL: undefined,
        SUPABASE_SERVICE_ROLE_KEY: "the-secret-key",
      })
    ).toThrowError(
      "createAdminClient: required Supabase server configuration is missing."
    );
  });

  it("throws a fixed, secret-free message when the service role key is missing", () => {
    let caught: unknown;

    try {
      getAdminSupabaseConfig({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("the-secret-key");
    expect((caught as Error).message).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
