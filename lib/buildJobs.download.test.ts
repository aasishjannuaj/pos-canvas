import { describe, expect, it } from "vitest";
import {
  BUILD_ARTIFACTS_DOWNLOAD_BUCKET,
  DOWNLOAD_SIGNED_URL_SECONDS,
  JSON_CONFIG_DOWNLOAD_ARTIFACT_TYPE,
  UNEXPECTED_DOWNLOAD_ERROR_MESSAGE,
  createDownloadArtifactFailure,
  createUnexpectedDownloadFailure,
  decideBuildArtifactDownloadEligibility,
  getDownloadArtifactErrorMessage,
} from "@/lib/buildJobs.download";
import type {
  DownloadArtifactErrorCode,
  DownloadArtifactResult,
} from "@/lib/buildJobs.download";
import { BUILD_STATUSES } from "@/lib/buildJobs";

const NOW = new Date("2026-07-29T12:00:00.000Z");
const PAST = "2026-07-29T11:59:59.000Z";
const FUTURE = "2026-07-30T12:00:00.000Z";

describe("download constants", () => {
  it("uses a 60-second signed URL lifetime", () => {
    expect(DOWNLOAD_SIGNED_URL_SECONDS).toBe(60);
  });

  it("serves only the json_config artifact type", () => {
    expect(JSON_CONFIG_DOWNLOAD_ARTIFACT_TYPE).toBe("json_config");
  });

  it("targets the private build-artifacts bucket", () => {
    expect(BUILD_ARTIFACTS_DOWNLOAD_BUCKET).toBe("build-artifacts");
  });
});

describe("decideBuildArtifactDownloadEligibility", () => {
  it("is eligible for a succeeded build with no expiration", () => {
    expect(
      decideBuildArtifactDownloadEligibility({
        buildStatus: "succeeded",
        expiresAt: null,
        now: NOW,
      })
    ).toBe("eligible");
  });

  it("is eligible for a succeeded build whose expiration is in the future", () => {
    expect(
      decideBuildArtifactDownloadEligibility({
        buildStatus: "succeeded",
        expiresAt: FUTURE,
        now: NOW,
      })
    ).toBe("eligible");
  });

  it("is not_ready for a queued build", () => {
    expect(
      decideBuildArtifactDownloadEligibility({
        buildStatus: "queued",
        expiresAt: null,
        now: NOW,
      })
    ).toBe("not_ready");
  });

  it("is not_ready for a building build", () => {
    expect(
      decideBuildArtifactDownloadEligibility({
        buildStatus: "building",
        expiresAt: null,
        now: NOW,
      })
    ).toBe("not_ready");
  });

  it("is not_ready for a failed build", () => {
    expect(
      decideBuildArtifactDownloadEligibility({
        buildStatus: "failed",
        expiresAt: null,
        now: NOW,
      })
    ).toBe("not_ready");
  });

  it("is expired for a succeeded build whose expiration has passed", () => {
    expect(
      decideBuildArtifactDownloadEligibility({
        buildStatus: "succeeded",
        expiresAt: PAST,
        now: NOW,
      })
    ).toBe("expired");
  });

  it("treats an expiration exactly at now as expired", () => {
    expect(
      decideBuildArtifactDownloadEligibility({
        buildStatus: "succeeded",
        expiresAt: NOW.toISOString(),
        now: NOW,
      })
    ).toBe("expired");
  });

  it("fails closed (expired) on an unparseable expiration value", () => {
    expect(
      decideBuildArtifactDownloadEligibility({
        buildStatus: "succeeded",
        expiresAt: "not-a-timestamp",
        now: NOW,
      })
    ).toBe("expired");
  });

  it("reports not_ready for every non-succeeded status, even with a valid future expiry", () => {
    for (const status of BUILD_STATUSES) {
      const outcome = decideBuildArtifactDownloadEligibility({
        buildStatus: status,
        expiresAt: FUTURE,
        now: NOW,
      });

      expect(outcome).toBe(status === "succeeded" ? "eligible" : "not_ready");
    }
  });
});

describe("getDownloadArtifactErrorMessage", () => {
  it("returns the exact approved public message for each error code", () => {
    expect(getDownloadArtifactErrorMessage("unauthenticated")).toBe(
      "Please sign in again to download this artifact."
    );
    expect(getDownloadArtifactErrorMessage("not_found")).toBe(
      "This build artifact could not be found."
    );
    expect(getDownloadArtifactErrorMessage("not_ready")).toBe(
      "This build is not ready for download."
    );
    expect(getDownloadArtifactErrorMessage("expired")).toBe(
      "This build artifact has expired."
    );
    expect(getDownloadArtifactErrorMessage("unavailable")).toBe(
      "The build artifact is temporarily unavailable."
    );
  });

  it("never returns a raw internal/database/storage error string for any code", () => {
    const codes: DownloadArtifactErrorCode[] = [
      "unauthenticated",
      "not_found",
      "not_ready",
      "expired",
      "unavailable",
    ];

    for (const code of codes) {
      const message = getDownloadArtifactErrorMessage(code);

      expect(message).not.toMatch(/supabase|postgres|pgrst|storage\.|jwt|token/i);
      expect(message).not.toMatch(/build-artifacts/);
      expect(message).not.toMatch(/\//);
      expect(message).not.toMatch(/at \w+ \(/);
      expect(message.endsWith(".")).toBe(true);
    }
  });
});

describe("createDownloadArtifactFailure", () => {
  it("builds a sanitized failure result carrying the approved message", () => {
    expect(createDownloadArtifactFailure("expired")).toEqual({
      ok: false,
      error: "expired",
      message: "This build artifact has expired.",
    });
  });

  it("never includes a url or filename on a failure result", () => {
    const failure = createDownloadArtifactFailure("not_found");

    expect(failure).not.toHaveProperty("url");
    expect(failure).not.toHaveProperty("filename");
  });
});

describe("createUnexpectedDownloadFailure", () => {
  it("reports the unexpected-error message under the unavailable code", () => {
    expect(createUnexpectedDownloadFailure()).toEqual({
      ok: false,
      error: "unavailable",
      message: UNEXPECTED_DOWNLOAD_ERROR_MESSAGE,
    });
    expect(UNEXPECTED_DOWNLOAD_ERROR_MESSAGE).toBe(
      "The artifact could not be downloaded."
    );
  });

  it("is distinguishable from the storage-unavailable message", () => {
    expect(createUnexpectedDownloadFailure().message).not.toBe(
      getDownloadArtifactErrorMessage("unavailable")
    );
  });
});

// Feature 15.7 — structural guarantees about what the browser can ever
// receive. These assert the *shape* of the success arm, which is what
// keeps storage_path/owner_id/project_id/checksum/bucket details out of
// the client by construction rather than by reviewer vigilance.
describe("DownloadArtifactResult success shape", () => {
  const success: DownloadArtifactResult = {
    ok: true,
    url: "https://example.supabase.co/storage/v1/object/sign/build-artifacts/x?token=y",
    filename: "pos-canvas-test-project-v1.json",
  };

  it("carries exactly url and filename alongside ok", () => {
    expect(Object.keys(success).sort()).toEqual(["filename", "ok", "url"]);
  });

  it("does not carry storage_path", () => {
    expect(success).not.toHaveProperty("storage_path");
    expect(success).not.toHaveProperty("storagePath");
  });

  it("does not carry owner_id, project_id, or checksum", () => {
    expect(success).not.toHaveProperty("owner_id");
    expect(success).not.toHaveProperty("ownerId");
    expect(success).not.toHaveProperty("project_id");
    expect(success).not.toHaveProperty("projectId");
    expect(success).not.toHaveProperty("checksum");
  });

  it("does not carry bucket, artifact id, or artifact type", () => {
    expect(success).not.toHaveProperty("bucket");
    expect(success).not.toHaveProperty("artifactId");
    expect(success).not.toHaveProperty("artifact_id");
    expect(success).not.toHaveProperty("artifactType");
    expect(success).not.toHaveProperty("artifact_type");
  });
});
