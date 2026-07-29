// Feature 15.7 correction — boundary tests for the download path's UUID
// hardening. No Supabase mocking framework is introduced (consistent with
// this repository's standing convention of never mocking the database):
// these tests rely on a structural property instead.
//
// Both downloadBuildArtifact (the Server Action) and
// createBuildArtifactDownloadUrl (the server function) reject a malformed
// buildJobId *before* creating any Supabase client. That short-circuit is
// what makes these tests possible at all: the moment either function
// proceeds past validation it calls createClient(), which calls cookies()
// from next/headers, which throws outside a real request scope.
//
// These assertions were verified against a negative control — with the
// server function's isValidUuid guard temporarily disabled, the malformed
// input reaches createClient(), the resulting throw is caught by that
// function's own outer try/catch, and the result becomes
// {error: "unavailable", message: "The artifact could not be downloaded."}
// instead of not_found. So these tests genuinely detect a missing guard
// rather than passing vacuously; the distinguishing signal is not_found
// (rejected pre-database) versus unavailable (reached the database path
// and failed there).
import { describe, expect, it } from "vitest";
import { downloadBuildArtifact } from "@/lib/buildJobs.actions";
import { createBuildArtifactDownloadUrl } from "@/lib/buildJobs.server";

const MALFORMED_IDS: unknown[] = [
  "",
  "   ",
  "not-a-uuid",
  "b0bf8e92",
  "b0bf8e92-0db6-48f4-937b",
  "b0bf8e92-0db6-48f4-937b-55c8821a194",
  "b0bf8e92-0db6-48f4-937b-55c8821a1946x",
  " b0bf8e92-0db6-48f4-937b-55c8821a1946",
  "b0bf8e92-0db6-48f4-937b-55c8821a1946 ",
  "b0bf8e920db648f4937b55c8821a1946",
  "{b0bf8e92-0db6-48f4-937b-55c8821a1946}",
  "b0bf8e92-0db6-48f4-937b-55c8821a1946/generated-pos-config.json",
  "g0bf8e92-0db6-48f4-937b-55c8821a1946",
];

const EXPECTED_FAILURE = {
  ok: false,
  error: "not_found",
  message: "This build artifact could not be found.",
};

describe("downloadBuildArtifact — malformed buildJobId", () => {
  it("returns the generic not_found result for every malformed id", async () => {
    for (const id of MALFORMED_IDS) {
      const result = await downloadBuildArtifact(id as string);

      expect(result).toEqual(EXPECTED_FAILURE);
    }
  });

  it("never reveals that the id was malformed", async () => {
    const result = await downloadBuildArtifact("not-a-uuid");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toMatch(/uuid|invalid|malformed|format|syntax/i);
      // Identical to what a well-formed but unknown/unowned id yields, so
      // the two are indistinguishable to a caller probing ids.
      expect(result.message).toBe("This build artifact could not be found.");
    }
  });

  it("returns no url or filename on rejection", async () => {
    const result = await downloadBuildArtifact("not-a-uuid");

    expect(result).not.toHaveProperty("url");
    expect(result).not.toHaveProperty("filename");
  });
});

describe("createBuildArtifactDownloadUrl — defense in depth", () => {
  it("rejects a malformed id even when called directly, bypassing the action wrapper", async () => {
    for (const id of MALFORMED_IDS) {
      const result = await createBuildArtifactDownloadUrl(id as string);

      expect(result).toEqual(EXPECTED_FAILURE);
    }
  });

  it("short-circuits before any database/Supabase access", async () => {
    // Verified by negative control (see the file header): without the
    // guard this resolves to the "unavailable" outcome, because the call
    // reaches createClient() -> cookies() and throws. Resolving to
    // not_found instead is the evidence that no database access occurred.
    await expect(
      createBuildArtifactDownloadUrl("not-a-uuid")
    ).resolves.toEqual(EXPECTED_FAILURE);
  });
});
