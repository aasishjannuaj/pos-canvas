// Feature 19 — the logo contract and every pure rule about it.
//
// WHY THE CONTRACT LIVES HERE RATHER THAN IN lib/projectConfig.ts: normalizing a
// stored logo requires the path/mime/dimension validators below, so
// projectConfig would have to import them. Putting the type there too would
// make the two modules import each other. This mirrors lib/modifiers.ts exactly
// — that module owns ModifierGroup AND normalizeModifierGroups, and
// lib/projectConfig.ts imports both — so the dependency runs one way only.
//
// Dependency-free: no React, no Supabase, no node builtins, no process.env. The
// browser, the server action and Vitest all use the same functions.
//
// WHAT THIS MODULE IS NOT: it is not an image library. It reads just enough of a
// file header to answer two questions the upload path must not guess at — "is
// this really a PNG/JPEG/WebP?" and "how big is it?" — and nothing else. It
// never decodes pixels, re-encodes, resizes or crops.

// ---------------------------------------------------------------------------
// Bounds and formats
// ---------------------------------------------------------------------------

/** The public storage bucket. Read-only to the world; writes are service-role. */
export const LOGO_BUCKET = "project-logos";

/**
 * 512 KB.
 *
 * Chosen to sit under Next's 1 MB default Server Action body limit with room to
 * spare: the limit applies to the RAW request body, so multipart boundaries and
 * part headers (10-20 KB by the framework's own guidance) count against it.
 * Raising this past ~900 KB would require setting
 * experimental.serverActions.bodySizeLimit in next.config.ts.
 */
export const MAX_LOGO_BYTES = 512 * 1024;

/** Rejects an accidental camera-roll upload without needing a resizer. */
export const MAX_LOGO_DIMENSION = 2048;

export type LogoMimeType = "image/png" | "image/jpeg" | "image/webp";

/**
 * SVG is deliberately absent. It is executable content, and this app serves no
 * Content-Security-Policy, so hosting owner-supplied SVG on a public bucket
 * would be a stored-XSS vector. Raster only for the MVP.
 */
export const ALLOWED_LOGO_MIME_TYPES: readonly LogoMimeType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** The `accept` attribute value, derived so the UI cannot drift from the rule. */
export const LOGO_ACCEPT_ATTRIBUTE = ALLOWED_LOGO_MIME_TYPES.join(",");

/**
 * ONE canonical extension per mime type. `image/jpeg` is always "jpg", never
 * "jpeg": the extension is part of the content-addressed object path, so two
 * spellings would let the same bytes land at two different paths and defeat the
 * deduplication that makes re-uploading a logo idempotent.
 *
 * The extension is always derived from the DETECTED mime type, never from the
 * uploaded filename, which a caller controls.
 */
export const LOGO_EXTENSION_BY_MIME: Record<LogoMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Every extension the canonical mapping can produce, for the path validator. */
const LOGO_EXTENSIONS = ["png", "jpg", "webp"] as const;

export function isAllowedLogoMimeType(value: unknown): value is LogoMimeType {
  return (
    typeof value === "string" &&
    (ALLOWED_LOGO_MIME_TYPES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// The stored contract
// ---------------------------------------------------------------------------

/**
 * What a project and a build snapshot record about a logo.
 *
 * A PATH, never a URL. The URL embeds the Supabase project ref, which differs
 * between environments, so a stored URL would not survive a project move and
 * could not be re-pointed. It is also never a signed URL: a build snapshot is
 * read months later, and every signed URL this app issues expires in 60
 * seconds.
 *
 * width/height are stored so the header can reserve space and avoid layout
 * shift without downloading the image first. checksum is the same sha-256 that
 * names the object — kept as its own field so a reader can verify the path
 * rather than parse it.
 */
export type BrandingLogo = {
  path: string;
  mimeType: LogoMimeType;
  width: number;
  height: number;
  checksum: string;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID_LOWER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The full object path, anchored and exact.
 *
 * This is the security boundary for URL construction: createLogoPublicUrl
 * refuses anything this rejects, so a malformed or hostile value that somehow
 * reached projects.config can never be turned into an arbitrary URL. No "..",
 * no leading slash, no scheme, no host, no query — the shape simply does not
 * admit them.
 */
const LOGO_PATH_PATTERN = new RegExp(
  `^${UUID_LOWER.source.slice(1, -1)}/[0-9a-f]{64}\\.(${LOGO_EXTENSIONS.join("|")})$`
);

export function isValidLogoChecksum(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** The project-id shape the object path admits: a lowercase UUID, nothing else. */
export function isValidLogoProjectId(value: unknown): value is string {
  return typeof value === "string" && UUID_LOWER.test(value.trim().toLowerCase());
}

export function isValidLogoPath(value: unknown): value is string {
  return typeof value === "string" && LOGO_PATH_PATTERN.test(value);
}

/**
 * Builds the content-addressed object path.
 *
 * `{projectId}/{sha256}.{ext}` — the name IS the content, which is what makes
 * every stored reference permanently immutable: the same path can only ever
 * hold the same bytes, so an old build snapshot cannot silently change branding
 * when an owner uploads a replacement.
 *
 * Throws rather than returning a fallback: every input here is server-derived
 * (a validated project id, a computed digest, a detected mime type), so a bad
 * value is a caller bug, not data to coerce — the same posture
 * createGeneratedPosConfig takes for its identity fields.
 */
export function createLogoObjectPath(input: {
  projectId: string;
  checksum: string;
  mimeType: LogoMimeType;
}): string {
  const projectId = input.projectId.trim().toLowerCase();

  if (!UUID_LOWER.test(projectId)) {
    throw new Error("createLogoObjectPath: projectId must be a UUID.");
  }

  if (!isValidLogoChecksum(input.checksum)) {
    throw new Error("createLogoObjectPath: checksum must be a sha-256 hex digest.");
  }

  if (!isAllowedLogoMimeType(input.mimeType)) {
    throw new Error("createLogoObjectPath: unsupported mime type.");
  }

  return `${projectId}/${input.checksum}.${LOGO_EXTENSION_BY_MIME[input.mimeType]}`;
}

/**
 * Composes the public URL for rendering. Returns null for anything invalid, so
 * a caller renders no image rather than an attacker-chosen one.
 *
 * The result is never persisted anywhere — it is built at render time from the
 * stored path plus the current environment's Supabase URL.
 */
export function createLogoPublicUrl(
  path: unknown,
  baseUrl: string | undefined
): string | null {
  if (!isValidLogoPath(path)) {
    return null;
  }

  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    return null;
  }

  const base = baseUrl.trim().replace(/\/+$/, "");

  // Only https/http origins. A javascript:, data: or protocol-relative value in
  // the environment must not become an image source.
  if (!/^https?:\/\/[^/]+$/.test(base)) {
    return null;
  }

  return `${base}/storage/v1/object/public/${LOGO_BUCKET}/${path}`;
}

/**
 * The digest segment of a valid path, or null.
 *
 * Only ever called on a path isValidLogoPath has already accepted, so the shape
 * is guaranteed; the null branch is defensive rather than reachable.
 */
export function readChecksumFromLogoPath(path: string): string | null {
  if (!isValidLogoPath(path)) {
    return null;
  }

  const filename = path.slice(path.indexOf("/") + 1);
  return filename.slice(0, filename.lastIndexOf("."));
}

// ---------------------------------------------------------------------------
// Normalization — what survives a load or a save
// ---------------------------------------------------------------------------

function isPositiveIntegerWithinBound(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_LOGO_DIMENSION
  );
}

/**
 * Whatever a stored config carries, resolved to a usable logo or to null.
 *
 * Follows the Feature 18.1 convention in lib/modifiers.ts: a project saved
 * before logos existed has no key at all and must normalize to "no logo" rather
 * than crash or be treated as unknown. A malformed logo is DROPPED rather than
 * repaired — a half-understood reference would render a broken image on a
 * customer-facing till, and there is nothing to recover it from.
 */
export function normalizeBrandingLogo(value: unknown): BrandingLogo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (!isValidLogoPath(candidate.path)) {
    return null;
  }

  if (!isAllowedLogoMimeType(candidate.mimeType)) {
    return null;
  }

  if (!isValidLogoChecksum(candidate.checksum)) {
    return null;
  }

  if (
    !isPositiveIntegerWithinBound(candidate.width) ||
    !isPositiveIntegerWithinBound(candidate.height)
  ) {
    return null;
  }

  // The path is content-addressed, so its digest segment and the checksum field
  // must agree. If they don't, the two were assembled from different uploads —
  // reject rather than pick one and render a logo nobody uploaded.
  if (readChecksumFromLogoPath(candidate.path) !== candidate.checksum) {
    return null;
  }

  // Rebuilt field-by-field, exactly as normalizeBranding and
  // normalizeReceiptSettings do, so no extra key on a stored object (a stale
  // `url`, a hand-added field) is ever carried forward.
  return {
    path: candidate.path,
    mimeType: candidate.mimeType,
    width: candidate.width,
    height: candidate.height,
    checksum: candidate.checksum,
  };
}

/** A safe independent copy, for cloneProjectConfig. */
export function cloneBrandingLogo(logo: BrandingLogo): BrandingLogo {
  return { ...logo };
}

// ---------------------------------------------------------------------------
// Format detection and dimensions
//
// Implemented here rather than with a dependency for three reasons: the upload
// path must sniff magic bytes anyway (a browser-reported File.type is trivially
// forged), reading the dimensions is the same header walk, and the only image
// library actually present in node_modules — sharp — is an undeclared
// transitive of Next, a native binary, and far more than this needs.
//
// Every read below is bounds-checked against the buffer length, so a truncated
// or hostile file returns null instead of throwing or reading past the end.
// ---------------------------------------------------------------------------

export type ImageDimensions = { width: number; height: number };

function hasBytes(bytes: Uint8Array, offset: number, count: number): boolean {
  return offset >= 0 && offset + count <= bytes.length;
}

function matches(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (!hasBytes(bytes, offset, signature.length)) {
    return false;
  }

  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP"

/**
 * The file's ACTUAL format, read from its leading bytes.
 *
 * This is the authority on mime type. A caller's claimed type is only ever
 * checked for agreement with this; it never determines what gets stored.
 */
export function detectImageMimeType(bytes: Uint8Array): LogoMimeType | null {
  if (matches(bytes, 0, PNG_SIGNATURE)) {
    return "image/png";
  }

  if (matches(bytes, 0, JPEG_SIGNATURE)) {
    return "image/jpeg";
  }

  if (matches(bytes, 0, RIFF_SIGNATURE) && matches(bytes, 8, WEBP_SIGNATURE)) {
    return "image/webp";
  }

  return null;
}

function readUint32BE(bytes: Uint8Array, offset: number): number | null {
  if (!hasBytes(bytes, offset, 4)) {
    return null;
  }

  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number | null {
  if (!hasBytes(bytes, offset, 2)) {
    return null;
  }

  return (bytes[offset] << 8) + bytes[offset + 1];
}

function readUint16LE(bytes: Uint8Array, offset: number): number | null {
  if (!hasBytes(bytes, offset, 2)) {
    return null;
  }

  return bytes[offset] + (bytes[offset + 1] << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number | null {
  if (!hasBytes(bytes, offset, 3)) {
    return null;
  }

  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
}

/** PNG: the IHDR chunk is mandatory and always the first one. */
function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  // "IHDR" at offset 12, immediately after the 8-byte signature and the
  // 4-byte chunk length.
  if (!matches(bytes, 12, [0x49, 0x48, 0x44, 0x52])) {
    return null;
  }

  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);

  return width === null || height === null ? null : { width, height };
}

/**
 * JPEG: walk the segment chain to the first Start-Of-Frame marker.
 *
 * There is no fixed offset — a real file carries a variable number of APPn,
 * DQT and COM segments first — so the header must actually be parsed.
 */
function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  // SOF markers carrying frame dimensions. C4 (DHT), C8 (JPG) and CC (DAC) sit
  // in the same numeric range but are NOT frame headers.
  const SOF_MARKERS = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);

  let offset = 2; // past SOI

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return null;
    }

    // Fill bytes: any number of 0xFF may precede a marker.
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= bytes.length) {
      return null;
    }

    const marker = bytes[offset];
    offset += 1;

    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      continue;
    }

    const segmentLength = readUint16BE(bytes, offset);

    // A length under 2 would not even cover its own field — malformed.
    if (segmentLength === null || segmentLength < 2) {
      return null;
    }

    if (SOF_MARKERS.has(marker)) {
      // length(2) precision(1) height(2) width(2)
      const height = readUint16BE(bytes, offset + 3);
      const width = readUint16BE(bytes, offset + 5);

      return width === null || height === null ? null : { width, height };
    }

    offset += segmentLength;
  }

  return null;
}

/** WebP: three container variants, each with its own dimension encoding. */
function readWebpDimensions(bytes: Uint8Array): ImageDimensions | null {
  // Lossy: "VP8 " then a 3-byte frame tag and the 0x9D 0x01 0x2A sync code.
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x20])) {
    if (!matches(bytes, 23, [0x9d, 0x01, 0x2a])) {
      return null;
    }

    const rawWidth = readUint16LE(bytes, 26);
    const rawHeight = readUint16LE(bytes, 28);

    if (rawWidth === null || rawHeight === null) {
      return null;
    }

    // 14 significant bits; the top 2 are the scaling factor.
    return { width: rawWidth & 0x3fff, height: rawHeight & 0x3fff };
  }

  // Lossless: "VP8L", a 0x2F signature byte, then 14+14 bits of (dimension - 1).
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x4c])) {
    if (!matches(bytes, 20, [0x2f]) || !hasBytes(bytes, 21, 4)) {
      return null;
    }

    const bits =
      (bytes[21] + (bytes[22] << 8) + (bytes[23] << 16) + bytes[24] * 0x1000000) >>> 0;

    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  // Extended: "VP8X", 4 flag bytes, then 24-bit (canvas dimension - 1) each.
  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x58])) {
    const rawWidth = readUint24LE(bytes, 24);
    const rawHeight = readUint24LE(bytes, 27);

    if (rawWidth === null || rawHeight === null) {
      return null;
    }

    return { width: rawWidth + 1, height: rawHeight + 1 };
  }

  return null;
}

/**
 * Reads the pixel dimensions for an already-detected format.
 *
 * Returns null for a truncated, corrupt or unrecognized header — which the
 * upload path treats as a rejected file, never as an unknown-but-acceptable
 * one. A zero dimension is also rejected: no real image has one, and it would
 * pass a naive "> 0 ?" check downstream.
 */
export function readImageDimensions(
  bytes: Uint8Array,
  mimeType: LogoMimeType
): ImageDimensions | null {
  const dimensions =
    mimeType === "image/png"
      ? readPngDimensions(bytes)
      : mimeType === "image/jpeg"
        ? readJpegDimensions(bytes)
        : readWebpDimensions(bytes);

  if (dimensions === null) {
    return null;
  }

  if (
    !Number.isInteger(dimensions.width) ||
    !Number.isInteger(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    return null;
  }

  return dimensions;
}

// ---------------------------------------------------------------------------
// Shared rejection reasons
//
// One vocabulary for the client pre-check and the server's authoritative check,
// so the two cannot describe the same rejection differently.
// ---------------------------------------------------------------------------

export type LogoRejectionReason =
  | "unsupported_type"
  | "too_large"
  | "too_many_pixels"
  | "unreadable";

export const LOGO_REJECTION_MESSAGES: Record<LogoRejectionReason, string> = {
  unsupported_type: "Logo must be a PNG, JPEG, or WebP image.",
  too_large: `Logo must be under ${Math.round(MAX_LOGO_BYTES / 1024)} KB.`,
  too_many_pixels: `Logo must be at most ${MAX_LOGO_DIMENSION} × ${MAX_LOGO_DIMENSION} pixels.`,
  unreadable: "That file could not be read as an image.",
};

/**
 * The client-side pre-check: type and size only.
 *
 * Exists purely so an obviously-wrong file is refused instantly instead of
 * after a round trip. It is NOT a security boundary — the server repeats both
 * checks against the actual bytes and additionally verifies the magic bytes and
 * the dimensions, none of which a browser value can influence.
 */
export function checkLogoFileBeforeUpload(file: {
  type: string;
  size: number;
}): LogoRejectionReason | null {
  if (!isAllowedLogoMimeType(file.type)) {
    return "unsupported_type";
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    return "unreadable";
  }

  if (file.size > MAX_LOGO_BYTES) {
    return "too_large";
  }

  return null;
}
