// Feature 19 — behavioral tests for every pure logo rule.
//
// The header parsers matter most here: they are the only thing standing between
// a caller-supplied file and what the app believes about it, and they were
// written by hand rather than taken from a dependency. Every fixture below is
// built byte-by-byte so a test failure names a specific structural assumption
// rather than "the image library changed".
import { describe, expect, it } from "vitest";
import {
  ALLOWED_LOGO_MIME_TYPES,
  LOGO_ACCEPT_ATTRIBUTE,
  LOGO_BUCKET,
  LOGO_EXTENSION_BY_MIME,
  MAX_LOGO_BYTES,
  MAX_LOGO_DIMENSION,
  checkLogoFileBeforeUpload,
  cloneBrandingLogo,
  createLogoObjectPath,
  createLogoPublicUrl,
  detectImageMimeType,
  isAllowedLogoMimeType,
  isValidLogoChecksum,
  isValidLogoPath,
  isValidLogoProjectId,
  normalizeBrandingLogo,
  readChecksumFromLogoPath,
  readImageDimensions,
} from "@/lib/logoUpload";
import type { BrandingLogo } from "@/lib/logoUpload";

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CHECKSUM = "a".repeat(64);

const VALID_LOGO: BrandingLogo = {
  path: `${PROJECT_ID}/${CHECKSUM}.png`,
  mimeType: "image/png",
  width: 240,
  height: 80,
  checksum: CHECKSUM,
};

// ---------------------------------------------------------------------------
// Fixtures — real header bytes, constructed rather than loaded
// ---------------------------------------------------------------------------

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return bytes;
}

/** A JPEG with a leading APP0 segment, so the parser must actually walk. */
function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8], 0); // SOI
  bytes.set([0xff, 0xe0], 2); // APP0
  view.setUint16(4, 8, false); // segment length (skipped)
  bytes.set([0xff, 0xc0], 12); // SOF0
  view.setUint16(14, 11, false); // segment length
  bytes[16] = 8; // precision
  view.setUint16(17, height, false);
  view.setUint16(19, width, false);
  return bytes;
}

function webpLossyBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  bytes.set([0x9d, 0x01, 0x2a], 23); // sync code
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

function webpLosslessBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(25);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // "VP8L"
  bytes[20] = 0x2f; // signature
  const bits = (width - 1) | ((height - 1) << 14);
  bytes[21] = bits & 0xff;
  bytes[22] = (bits >> 8) & 0xff;
  bytes[23] = (bits >> 16) & 0xff;
  bytes[24] = (bits >> 24) & 0xff;
  return bytes;
}

function webpExtendedBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return bytes;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("locked constants", () => {
  it("allows exactly PNG, JPEG and WebP", () => {
    expect(ALLOWED_LOGO_MIME_TYPES).toEqual(["image/png", "image/jpeg", "image/webp"]);
  });

  it("does not allow SVG", () => {
    // Executable content on a public origin with no CSP. Deliberately out.
    expect(isAllowedLogoMimeType("image/svg+xml")).toBe(false);
    expect(LOGO_ACCEPT_ATTRIBUTE).not.toContain("svg");
  });

  it("caps at 512 KB and 2048 px", () => {
    expect(MAX_LOGO_BYTES).toBe(524288);
    expect(MAX_LOGO_DIMENSION).toBe(2048);
  });

  it("names the bucket the migration creates", () => {
    expect(LOGO_BUCKET).toBe("project-logos");
  });

  it("maps jpeg to ONE canonical extension", () => {
    // Two spellings would let identical bytes land at two paths and defeat the
    // deduplication that makes a repeat upload idempotent.
    expect(LOGO_EXTENSION_BY_MIME["image/jpeg"]).toBe("jpg");
    expect(LOGO_EXTENSION_BY_MIME).toEqual({
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
    });
  });
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe("content-addressed object paths", () => {
  it("builds {projectId}/{sha256}.{ext}", () => {
    expect(
      createLogoObjectPath({ projectId: PROJECT_ID, checksum: CHECKSUM, mimeType: "image/png" })
    ).toBe(`${PROJECT_ID}/${CHECKSUM}.png`);
  });

  it("uses the canonical jpg extension for jpeg", () => {
    expect(
      createLogoObjectPath({ projectId: PROJECT_ID, checksum: CHECKSUM, mimeType: "image/jpeg" })
    ).toMatch(/\.jpg$/);
  });

  it("is deterministic: identical content yields an identical path", () => {
    const a = createLogoObjectPath({ projectId: PROJECT_ID, checksum: CHECKSUM, mimeType: "image/png" });
    const b = createLogoObjectPath({ projectId: PROJECT_ID, checksum: CHECKSUM, mimeType: "image/png" });
    expect(a).toBe(b);
  });

  it("different content yields a different path — the immutability property", () => {
    const a = createLogoObjectPath({ projectId: PROJECT_ID, checksum: "a".repeat(64), mimeType: "image/png" });
    const b = createLogoObjectPath({ projectId: PROJECT_ID, checksum: "b".repeat(64), mimeType: "image/png" });
    expect(a).not.toBe(b);
  });

  it("scopes by project, so two projects never collide", () => {
    const other = "11111111-2222-3333-4444-555555555555";
    expect(
      createLogoObjectPath({ projectId: other, checksum: CHECKSUM, mimeType: "image/png" })
    ).toContain(other);
  });

  it("throws on a non-UUID project id rather than coercing", () => {
    for (const bad of ["", "  ", "../../etc", "not-a-uuid", `${PROJECT_ID}/x`]) {
      expect(() =>
        createLogoObjectPath({ projectId: bad, checksum: CHECKSUM, mimeType: "image/png" })
      ).toThrow();
    }
  });

  it("throws on a non-sha256 checksum", () => {
    for (const bad of ["", "abc", "A".repeat(64), "g".repeat(64), `${CHECKSUM}0`]) {
      expect(() =>
        createLogoObjectPath({ projectId: PROJECT_ID, checksum: bad, mimeType: "image/png" })
      ).toThrow();
    }
  });
});

describe("the path validator is the URL security boundary", () => {
  it("accepts a well-formed path for every extension", () => {
    for (const ext of ["png", "jpg", "webp"]) {
      expect(isValidLogoPath(`${PROJECT_ID}/${CHECKSUM}.${ext}`)).toBe(true);
    }
  });

  it("rejects traversal, absolute paths, schemes and hosts", () => {
    for (const bad of [
      `../${PROJECT_ID}/${CHECKSUM}.png`,
      `/${PROJECT_ID}/${CHECKSUM}.png`,
      `${PROJECT_ID}/../${CHECKSUM}.png`,
      `${PROJECT_ID}/${CHECKSUM}.png/../../secret`,
      "https://evil.example/x.png",
      "//evil.example/x.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
    ]) {
      expect(isValidLogoPath(bad)).toBe(false);
    }
  });

  it("rejects a wrong extension, including svg and jpeg", () => {
    for (const ext of ["svg", "jpeg", "gif", "exe", "PNG"]) {
      expect(isValidLogoPath(`${PROJECT_ID}/${CHECKSUM}.${ext}`)).toBe(false);
    }
  });

  it("rejects a malformed digest or project segment", () => {
    expect(isValidLogoPath(`${PROJECT_ID}/${"a".repeat(63)}.png`)).toBe(false);
    expect(isValidLogoPath(`${PROJECT_ID}/${"A".repeat(64)}.png`)).toBe(false);
    expect(isValidLogoPath(`not-a-uuid/${CHECKSUM}.png`)).toBe(false);
    expect(isValidLogoPath(`${CHECKSUM}.png`)).toBe(false);
  });

  it("rejects non-strings", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(isValidLogoPath(bad)).toBe(false);
    }
  });

  it("reads back the digest segment", () => {
    expect(readChecksumFromLogoPath(`${PROJECT_ID}/${CHECKSUM}.png`)).toBe(CHECKSUM);
    expect(readChecksumFromLogoPath("nonsense")).toBeNull();
  });

  it("validates project ids independently", () => {
    expect(isValidLogoProjectId(PROJECT_ID)).toBe(true);
    expect(isValidLogoProjectId(PROJECT_ID.toUpperCase())).toBe(true);
    expect(isValidLogoProjectId("nope")).toBe(false);
    expect(isValidLogoProjectId(null)).toBe(false);
  });

  it("accepts a sha-256 digest only in lowercase hex", () => {
    expect(isValidLogoChecksum(CHECKSUM)).toBe(true);
    expect(isValidLogoChecksum("A".repeat(64))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// URL composition
// ---------------------------------------------------------------------------

describe("createLogoPublicUrl", () => {
  const BASE = "https://abc.supabase.co";

  it("composes the public object URL", () => {
    expect(createLogoPublicUrl(VALID_LOGO.path, BASE)).toBe(
      `${BASE}/storage/v1/object/public/project-logos/${VALID_LOGO.path}`
    );
  });

  it("tolerates a trailing slash on the origin", () => {
    expect(createLogoPublicUrl(VALID_LOGO.path, `${BASE}/`)).toBe(
      createLogoPublicUrl(VALID_LOGO.path, BASE)
    );
  });

  it("returns null for any invalid path, so no image renders", () => {
    for (const bad of ["https://evil.example/x.png", "../x.png", "", null]) {
      expect(createLogoPublicUrl(bad, BASE)).toBeNull();
    }
  });

  it("returns null for a missing or non-http origin", () => {
    // An environment value must never become an arbitrary scheme.
    for (const bad of [undefined, "", "   ", "javascript:alert(1)", "ftp://x", "//evil.example"]) {
      expect(createLogoPublicUrl(VALID_LOGO.path, bad)).toBeNull();
    }
  });

  it("cannot be turned into an arbitrary URL source", () => {
    // The one property that matters: no input pair produces a host other than
    // the supplied origin.
    const url = createLogoPublicUrl(VALID_LOGO.path, BASE);
    expect(url?.startsWith(`${BASE}/`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe("normalizeBrandingLogo", () => {
  it("passes a valid logo through field-by-field", () => {
    expect(normalizeBrandingLogo(VALID_LOGO)).toEqual(VALID_LOGO);
  });

  it("drops unknown keys rather than carrying them forward", () => {
    const withExtra = { ...VALID_LOGO, url: "https://evil.example/x.png", nope: 1 };
    expect(normalizeBrandingLogo(withExtra)).toEqual(VALID_LOGO);
    expect(normalizeBrandingLogo(withExtra)).not.toHaveProperty("url");
  });

  it("treats an absent logo as no logo", () => {
    for (const absent of [undefined, null, "", 0, [], "logo"]) {
      expect(normalizeBrandingLogo(absent)).toBeNull();
    }
  });

  it("drops a logo with an invalid path", () => {
    expect(normalizeBrandingLogo({ ...VALID_LOGO, path: "https://evil.example/x.png" })).toBeNull();
    expect(normalizeBrandingLogo({ ...VALID_LOGO, path: `${PROJECT_ID}/${CHECKSUM}.svg` })).toBeNull();
  });

  it("drops a logo whose checksum disagrees with its path", () => {
    // The two were assembled from different uploads; picking one would render
    // an image nobody uploaded.
    expect(normalizeBrandingLogo({ ...VALID_LOGO, checksum: "b".repeat(64) })).toBeNull();
  });

  it("drops a logo with a disallowed or missing mime type", () => {
    for (const mimeType of ["image/svg+xml", "image/gif", "", undefined]) {
      expect(normalizeBrandingLogo({ ...VALID_LOGO, mimeType })).toBeNull();
    }
  });

  it("drops non-positive, non-integer or oversized dimensions", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, MAX_LOGO_DIMENSION + 1, "240"]) {
      expect(normalizeBrandingLogo({ ...VALID_LOGO, width: bad })).toBeNull();
      expect(normalizeBrandingLogo({ ...VALID_LOGO, height: bad })).toBeNull();
    }
  });

  it("accepts exactly the maximum dimension", () => {
    const atMax = { ...VALID_LOGO, width: MAX_LOGO_DIMENSION, height: MAX_LOGO_DIMENSION };
    expect(normalizeBrandingLogo(atMax)).toEqual(atMax);
  });

  it("clones independently", () => {
    const copy = cloneBrandingLogo(VALID_LOGO);
    expect(copy).toEqual(VALID_LOGO);
    expect(copy).not.toBe(VALID_LOGO);
  });
});

// ---------------------------------------------------------------------------
// Magic bytes
// ---------------------------------------------------------------------------

describe("detectImageMimeType reads the real format", () => {
  it("detects each supported format", () => {
    expect(detectImageMimeType(pngBytes(10, 10))).toBe("image/png");
    expect(detectImageMimeType(jpegBytes(10, 10))).toBe("image/jpeg");
    expect(detectImageMimeType(webpLossyBytes(10, 10))).toBe("image/webp");
    expect(detectImageMimeType(webpLosslessBytes(10, 10))).toBe("image/webp");
    expect(detectImageMimeType(webpExtendedBytes(10, 10))).toBe("image/webp");
  });

  it("rejects an SVG however it is labelled", () => {
    // The forged-upload case: evil.svg renamed to logo.png. The bytes decide.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(detectImageMimeType(svg)).toBeNull();
  });

  it("rejects HTML, GIF, a ZIP/APK and random bytes", () => {
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0]);
    const noise = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    for (const bytes of [html, gif, zip, noise]) {
      expect(detectImageMimeType(bytes)).toBeNull();
    }
  });

  it("rejects an empty or truncated signature", () => {
    expect(detectImageMimeType(new Uint8Array(0))).toBeNull();
    expect(detectImageMimeType(new Uint8Array([0x89, 0x50]))).toBeNull();
    // "RIFF" without "WEBP" is some other RIFF container (e.g. a WAV).
    const riffOnly = new Uint8Array(12);
    riffOnly.set([0x52, 0x49, 0x46, 0x46], 0);
    expect(detectImageMimeType(riffOnly)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

describe("readImageDimensions", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(readImageDimensions(pngBytes(1920, 1080), "image/png")).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it("walks JPEG segments to the first SOF", () => {
    expect(readImageDimensions(jpegBytes(640, 480), "image/jpeg")).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("reads all three WebP container variants", () => {
    expect(readImageDimensions(webpLossyBytes(300, 200), "image/webp")).toEqual({
      width: 300,
      height: 200,
    });
    expect(readImageDimensions(webpLosslessBytes(300, 200), "image/webp")).toEqual({
      width: 300,
      height: 200,
    });
    expect(readImageDimensions(webpExtendedBytes(300, 200), "image/webp")).toEqual({
      width: 300,
      height: 200,
    });
  });

  it("returns null for a truncated header rather than throwing", () => {
    // The corrupt-file case. Every read is bounds-checked, so this must not
    // throw or read past the end.
    for (let length = 0; length < 32; length += 1) {
      expect(() => readImageDimensions(pngBytes(10, 10).slice(0, length), "image/png")).not.toThrow();
      expect(() => readImageDimensions(jpegBytes(10, 10).slice(0, length), "image/jpeg")).not.toThrow();
      expect(() => readImageDimensions(webpLossyBytes(10, 10).slice(0, length), "image/webp")).not.toThrow();
    }

    expect(readImageDimensions(pngBytes(10, 10).slice(0, 18), "image/png")).toBeNull();
  });

  it("returns null when the PNG signature is not followed by IHDR", () => {
    const bytes = pngBytes(10, 10);
    bytes.set([0x49, 0x44, 0x41, 0x54], 12); // "IDAT" where IHDR must be
    expect(readImageDimensions(bytes, "image/png")).toBeNull();
  });

  it("returns null for a JPEG with no SOF segment", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    expect(readImageDimensions(bytes, "image/jpeg")).toBeNull();
  });

  it("returns null for a WebP whose sync code is wrong", () => {
    const bytes = webpLossyBytes(10, 10);
    bytes[23] = 0x00;
    expect(readImageDimensions(bytes, "image/webp")).toBeNull();
  });

  it("rejects a zero dimension", () => {
    // No real image has one, and it would slip past a naive "> 0 ?" downstream.
    expect(readImageDimensions(pngBytes(0, 100), "image/png")).toBeNull();
    expect(readImageDimensions(pngBytes(100, 0), "image/png")).toBeNull();
  });

  it("reads a dimension above the cap, leaving the decision to the caller", () => {
    // Parsing and policy are separate: the server rejects, the parser reports.
    expect(readImageDimensions(pngBytes(4000, 4000), "image/png")).toEqual({
      width: 4000,
      height: 4000,
    });
  });
});

// ---------------------------------------------------------------------------
// Client pre-check
// ---------------------------------------------------------------------------

describe("checkLogoFileBeforeUpload", () => {
  it("accepts a supported file within the size cap", () => {
    expect(checkLogoFileBeforeUpload({ type: "image/png", size: 1024 })).toBeNull();
    expect(checkLogoFileBeforeUpload({ type: "image/webp", size: MAX_LOGO_BYTES })).toBeNull();
  });

  it("rejects an unsupported type", () => {
    for (const type of ["image/svg+xml", "image/gif", "application/pdf", ""]) {
      expect(checkLogoFileBeforeUpload({ type, size: 1024 })).toBe("unsupported_type");
    }
  });

  it("rejects an oversized file", () => {
    expect(checkLogoFileBeforeUpload({ type: "image/png", size: MAX_LOGO_BYTES + 1 })).toBe(
      "too_large"
    );
  });

  it("rejects an empty or nonsensical size", () => {
    for (const size of [0, -1, NaN, Infinity]) {
      expect(checkLogoFileBeforeUpload({ type: "image/png", size })).toBe("unreadable");
    }
  });
});
