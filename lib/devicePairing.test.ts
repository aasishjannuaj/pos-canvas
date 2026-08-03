import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_GENERATION_ATTEMPTS,
  PAIRING_CODE_ENTROPY_BITS,
  PAIRING_CODE_LENGTH,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_TOKEN_TTL_SECONDS,
  createPairingFailure,
  formatPairingCode,
  generatePairingCode,
  getPairingErrorMessage,
  getRedeemErrorMessage,
  hashPairingCode,
  hashPairingCodeForPostgrest,
  isValidPairingCodeShape,
  normalizePairingCode,
} from "@/lib/devicePairing";
import type { RedeemErrorCode } from "@/lib/devicePairing";

describe("pairing code alphabet and parameters", () => {
  it("uses Crockford Base32 — 32 symbols with I, L, O and U excluded", () => {
    expect(PAIRING_CODE_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    expect(PAIRING_CODE_ALPHABET.length).toBe(32);

    for (const excluded of ["I", "L", "O", "U"]) {
      expect(PAIRING_CODE_ALPHABET).not.toContain(excluded);
    }
  });

  it("has no duplicate symbols", () => {
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(PAIRING_CODE_ALPHABET.length);
  });

  it("matches the approved parameters", () => {
    expect(PAIRING_CODE_LENGTH).toBe(8);
    expect(PAIRING_TOKEN_TTL_SECONDS).toBe(600); // 10 minutes
    expect(PAIRING_MAX_ATTEMPTS).toBe(5);
  });

  it("bounds collision retries to a small number", () => {
    expect(PAIRING_CODE_GENERATION_ATTEMPTS).toBe(3);
    expect(PAIRING_CODE_GENERATION_ATTEMPTS).toBeLessThanOrEqual(5);
    expect(PAIRING_CODE_GENERATION_ATTEMPTS).toBeGreaterThan(0);
  });

  it("declares the entropy the length and alphabet actually provide", () => {
    const bits = Math.log2(PAIRING_CODE_ALPHABET.length ** PAIRING_CODE_LENGTH);

    expect(bits).toBe(PAIRING_CODE_ENTROPY_BITS);
    expect(bits).toBe(40);
  });
});

describe("generatePairingCode", () => {
  it("produces a code of the expected length using only alphabet symbols", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generatePairingCode();

      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      for (const char of code) {
        expect(PAIRING_CODE_ALPHABET).toContain(char);
      }
    }
  });

  it("never emits an ambiguous character", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generatePairingCode()).not.toMatch(/[ILOU]/);
    }
  });

  it("does not repeat across many draws", () => {
    const codes = new Set(Array.from({ length: 300 }, () => generatePairingCode()));

    // 32^8 possibilities: 300 draws colliding would indicate a broken RNG.
    expect(codes.size).toBe(300);
  });

  it("is stable under its own normalization (round-trips unchanged)", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generatePairingCode();

      expect(normalizePairingCode(code)).toBe(code);
    }
  });
});

describe("formatPairingCode", () => {
  it("formats as XXXX-XXXX", () => {
    expect(formatPairingCode("ABCD1234")).toBe("ABCD-1234");
  });

  it("is idempotent when given an already formatted code", () => {
    expect(formatPairingCode("ABCD-1234")).toBe("ABCD-1234");
  });
});

describe("normalizePairingCode", () => {
  it("strips hyphens, spaces and punctuation", () => {
    expect(normalizePairingCode("ABCD-1234")).toBe("ABCD1234");
    expect(normalizePairingCode("ABCD 1234")).toBe("ABCD1234");
    expect(normalizePairingCode(" A-B C.D_1/2 3 4 ")).toBe("ABCD1234");
  });

  it("uppercases", () => {
    expect(normalizePairingCode("abcd1234")).toBe("ABCD1234");
  });

  it("folds the Crockford-ambiguous characters, in either case", () => {
    expect(normalizePairingCode("ILO")).toBe("110");
    expect(normalizePairingCode("ilo")).toBe("110");
    // "IL0-O123" has 7 alphanumerics: I L 0 O 1 2 3 -> 1 1 0 0 1 2 3.
    expect(normalizePairingCode("IL0-O123")).toBe("1100123");
  });

  it("treats a typed O as 0 and I/L as 1, so a misread code still works", () => {
    expect(normalizePairingCode("O1LI2345")).toBe(normalizePairingCode("01112345"));
  });
});

// The single most important test in this file: the database hashes the code
// itself, so if TypeScript and SQL normalize differently, a valid code would
// never match its stored hash and pairing would silently be impossible.
describe("SQL/TypeScript hash compatibility", () => {
  // Independently computed:
  //   node -e "console.log(require('crypto').createHash('sha256')
  //            .update('ABCD1234','utf8').digest('hex'))"
  // The SQL side computes sha256(convert_to('ABCD1234','UTF8')) using CORE
  // PostgreSQL functions (not pgcrypto's digest(), which lives in the
  // "extensions" schema and would not resolve under the locked search_path).
  // Both are standard SHA-256 over the same UTF-8 bytes.
  const KNOWN_NORMALIZED = "ABCD1234";
  const KNOWN_SHA256 =
    "1635c8525afbae58c37bede3c9440844e9143727cc7c160bed665ec378d8a262";

  it("matches the pinned digest for the canonical vector", () => {
    expect(hashPairingCode(KNOWN_NORMALIZED).toString("hex")).toBe(KNOWN_SHA256);
  });

  it("produces that same digest for every equivalent user entry", () => {
    for (const variant of ["ABCD-1234", "abcd1234", "ABCD 1234", "a-b-c-d-1-2-3-4"]) {
      expect(hashPairingCode(variant).toString("hex")).toBe(KNOWN_SHA256);
    }
  });

  it("hashes the NORMALIZED form, not the raw input", () => {
    // Proves normalization happens before digesting — hashing the raw string
    // with the hyphen would give a different digest.
    const rawDigest = createHash("sha256").update("ABCD-1234", "utf8").digest("hex");

    expect(rawDigest).not.toBe(KNOWN_SHA256);
    expect(hashPairingCode("ABCD-1234").toString("hex")).toBe(KNOWN_SHA256);
  });

  it("folds ambiguous characters before hashing, matching the SQL translate()", () => {
    // SQL: translate(upper(...), 'ILO', '110')
    expect(hashPairingCode("ILO01234").toString("hex")).toBe(
      hashPairingCode("11001234").toString("hex")
    );
  });

  it("emits exactly 32 bytes, satisfying the bytea length constraint", () => {
    expect(hashPairingCode("ABCD1234")).toHaveLength(32);
  });

  it("formats for PostgREST as a \\x-prefixed hex bytea literal", () => {
    expect(hashPairingCodeForPostgrest(KNOWN_NORMALIZED)).toBe(`\\x${KNOWN_SHA256}`);
  });

  it("never returns the plaintext code in any hashing helper", () => {
    const code = "ABCD1234";

    expect(hashPairingCode(code).toString("hex")).not.toContain(code.toLowerCase());
    expect(hashPairingCodeForPostgrest(code)).not.toContain(code);
  });
});

describe("isValidPairingCodeShape", () => {
  it("accepts a generated code, formatted or raw, in any case", () => {
    const code = generatePairingCode();

    expect(isValidPairingCodeShape(code)).toBe(true);
    expect(isValidPairingCodeShape(formatPairingCode(code))).toBe(true);
    expect(isValidPairingCodeShape(code.toLowerCase())).toBe(true);
  });

  it("rejects wrong lengths", () => {
    expect(isValidPairingCodeShape("ABCD123")).toBe(false);
    expect(isValidPairingCodeShape("ABCD12345")).toBe(false);
    expect(isValidPairingCodeShape("")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidPairingCodeShape(null)).toBe(false);
    expect(isValidPairingCodeShape(undefined)).toBe(false);
    expect(isValidPairingCodeShape(12345678)).toBe(false);
  });

  it("accepts ambiguous characters because normalization folds them", () => {
    expect(isValidPairingCodeShape("ILO01234")).toBe(true);
  });

  it("rejects a code containing a symbol outside the alphabet after folding", () => {
    // U is excluded from Crockford and is not folded to anything.
    expect(isValidPairingCodeShape("UUUU1234")).toBe(false);
  });
});

describe("public error messages", () => {
  it("never leaks whether a code was wrong, expired, used or locked", () => {
    // Every guessable rejection must be indistinguishable.
    expect(getRedeemErrorMessage("invalid_code")).toBe(
      "That pairing code is not valid."
    );
    expect(getRedeemErrorMessage("invalid_code")).not.toMatch(
      /expired|used|consumed|locked|attempt/i
    );
  });

  it("returns a sanitized message for every redeem code", () => {
    const codes: RedeemErrorCode[] = [
      "not_authenticated",
      "not_anonymous",
      "invalid_code",
      "already_paired",
      "unavailable",
    ];

    for (const code of codes) {
      const message = getRedeemErrorMessage(code);

      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/supabase|postgres|pgrst|sql|jwt|token_hash/i);
      expect(message.endsWith(".")).toBe(true);
    }
  });

  it("returns a sanitized message for every pairing-creation code", () => {
    for (const code of [
      "not_authenticated",
      "invalid_request",
      "project_not_found",
      "build_not_ready",
      "unavailable",
    ] as const) {
      const message = getPairingErrorMessage(code);

      expect(message).not.toMatch(/supabase|postgres|pgrst|constraint|relation/i);
      expect(message.endsWith(".")).toBe(true);
    }
  });

  it("createPairingFailure never carries a code or expiry", () => {
    const failure = createPairingFailure("build_not_ready");

    expect(failure).not.toHaveProperty("code");
    expect(failure).not.toHaveProperty("formattedCode");
    expect(failure).not.toHaveProperty("expiresAt");
  });
});
