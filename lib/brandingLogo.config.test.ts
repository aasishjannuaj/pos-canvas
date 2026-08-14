// Feature 19 — how a logo flows through the config pipeline, and what must not
// change for a project that has never had one.
//
// The backward-compatibility assertions here are the ones with teeth: every
// existing project is a no-logo project, and this feature must be invisible to
// all of them — including at the byte level in the canonical string that
// produces a build's config hash.
import { describe, expect, it } from "vitest";
import {
  cloneProjectConfig,
  defaultProjectConfig,
  isProjectConfig,
  normalizeBranding,
  normalizeProjectConfig,
} from "@/lib/projectConfig";
import type { BrandingSettings, ProjectConfig } from "@/lib/projectConfig";
import {
  createGeneratedPosConfig,
  isGeneratedPosConfig,
} from "@/lib/generatedPosConfig";
import { canonicalizeGeneratedPosConfig } from "@/lib/buildJobs";
import type { BrandingLogo } from "@/lib/logoUpload";

const PROJECT_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CHECKSUM_A = "a".repeat(64);
const CHECKSUM_B = "b".repeat(64);

const LOGO_A: BrandingLogo = {
  path: `${PROJECT_ID}/${CHECKSUM_A}.png`,
  mimeType: "image/png",
  width: 240,
  height: 80,
  checksum: CHECKSUM_A,
};

const LOGO_B: BrandingLogo = {
  path: `${PROJECT_ID}/${CHECKSUM_B}.webp`,
  mimeType: "image/webp",
  width: 300,
  height: 100,
  checksum: CHECKSUM_B,
};

function configWithBranding(branding: BrandingSettings): ProjectConfig {
  return { ...defaultProjectConfig, branding };
}

const GENERATE_INPUT = {
  projectId: PROJECT_ID,
  projectName: "Test Project",
  templateId: "restaurant",
};

// ---------------------------------------------------------------------------
// Backward compatibility — the property every existing project depends on
// ---------------------------------------------------------------------------

describe("a project that never had a logo is unaffected", () => {
  it("the default config ships no logo key at all", () => {
    expect(defaultProjectConfig.branding).toEqual({ accentColor: "#2563EB" });
    expect("logo" in defaultProjectConfig.branding).toBe(false);
  });

  it("normalizeBranding OMITS the key rather than emitting null", () => {
    const normalized = normalizeBranding({ accentColor: "#000000" });
    expect(normalized).toEqual({ accentColor: "#000000" });
    expect("logo" in normalized).toBe(false);
  });

  it("a legacy config with no branding.logo normalizes unchanged", () => {
    const legacy = configWithBranding({ accentColor: "#123456" });
    const normalized = normalizeProjectConfig(legacy);

    expect(normalized.branding).toEqual({ accentColor: "#123456" });
    expect("logo" in normalized.branding).toBe(false);
  });

  it("still passes the structural project guard", () => {
    expect(isProjectConfig(configWithBranding({ accentColor: "#123456" }))).toBe(true);
  });

  it("the generated config omits the key too", () => {
    const generated = createGeneratedPosConfig({
      ...GENERATE_INPUT,
      config: configWithBranding({ accentColor: "#123456" }),
    });

    expect(generated.branding).toEqual({ accentColor: "#123456" });
    expect("logo" in generated.branding).toBe(false);
    expect(isGeneratedPosConfig(generated)).toBe(true);
  });

  it("the canonical string contains no logo key — so no config hash shifts", () => {
    // THE critical backward-compatibility assertion. canonicalizeGeneratedPosConfig
    // feeds the build config hash; emitting `"logo":null` would change the
    // canonical bytes of every existing project purely because the type gained
    // a field.
    const canonical = canonicalizeGeneratedPosConfig(
      createGeneratedPosConfig({
        ...GENERATE_INPUT,
        config: configWithBranding({ accentColor: "#123456" }),
      })
    );

    expect(canonical).toContain('"branding":{"accentColor":"#123456"}');
    expect(canonical).not.toContain("logo");
  });

  it("an old generated config with no branding.logo still validates", () => {
    // A build snapshot frozen before this feature existed. A paired device
    // pinned to it must keep loading, with no rebuild required.
    const old = {
      ...createGeneratedPosConfig({
        ...GENERATE_INPUT,
        config: configWithBranding({ accentColor: "#123456" }),
      }),
    };

    expect(isGeneratedPosConfig(old)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Carrying a logo through
// ---------------------------------------------------------------------------

describe("a logo flows from project config to generated snapshot", () => {
  it("survives normalization intact", () => {
    const normalized = normalizeProjectConfig(
      configWithBranding({ accentColor: "#111111", logo: LOGO_A })
    );

    expect(normalized.branding.logo).toEqual(LOGO_A);
  });

  it("reaches the generated config as a PATH, never a URL", () => {
    const generated = createGeneratedPosConfig({
      ...GENERATE_INPUT,
      config: configWithBranding({ accentColor: "#111111", logo: LOGO_A }),
    });

    expect(generated.branding.logo).toEqual(LOGO_A);

    const serialized = JSON.stringify(generated);
    expect(serialized).not.toContain("http");
    expect(serialized).not.toContain("storage/v1");
    expect(serialized).not.toContain("token");
  });

  it("stores no image bytes anywhere in the snapshot", () => {
    // base64 in a snapshot would be loaded inside complete_sale_v3's locked
    // critical section on every sale.
    const serialized = JSON.stringify(
      createGeneratedPosConfig({
        ...GENERATE_INPUT,
        config: configWithBranding({ accentColor: "#111111", logo: LOGO_A }),
      })
    );

    expect(serialized).not.toContain("base64");
    expect(serialized).not.toContain("data:image");
    expect(serialized.length).toBeLessThan(10_000);
  });

  it("keeps schemaVersion at 1 — the field is additive, not breaking", () => {
    const generated = createGeneratedPosConfig({
      ...GENERATE_INPUT,
      config: configWithBranding({ accentColor: "#111111", logo: LOGO_A }),
    });

    expect(generated.schemaVersion).toBe(1);
    expect(isGeneratedPosConfig(generated)).toBe(true);
  });

  it("a malformed stored logo is dropped, not rendered", () => {
    const broken = configWithBranding({
      accentColor: "#111111",
      logo: { ...LOGO_A, path: "https://evil.example/x.png" } as BrandingLogo,
    });

    const normalized = normalizeProjectConfig(broken);
    expect("logo" in normalized.branding).toBe(false);

    const generated = createGeneratedPosConfig({ ...GENERATE_INPUT, config: broken });
    expect("logo" in generated.branding).toBe(false);
  });

  it("changing the logo changes the canonical string, so a build is a new build", () => {
    const withA = canonicalizeGeneratedPosConfig(
      createGeneratedPosConfig({
        ...GENERATE_INPUT,
        config: configWithBranding({ accentColor: "#111111", logo: LOGO_A }),
      })
    );
    const withB = canonicalizeGeneratedPosConfig(
      createGeneratedPosConfig({
        ...GENERATE_INPUT,
        config: configWithBranding({ accentColor: "#111111", logo: LOGO_B }),
      })
    );

    expect(withA).not.toBe(withB);
    expect(withA).toContain(CHECKSUM_A);
    expect(withB).toContain(CHECKSUM_B);
  });
});

// ---------------------------------------------------------------------------
// The immutability property, at the data level
// ---------------------------------------------------------------------------

describe("an old snapshot keeps its own logo when the project changes", () => {
  it("replacing the logo does not touch a previously generated snapshot", () => {
    // This is the acceptance scenario expressed in data. A build snapshot is a
    // frozen value (build_jobs.config_snapshot, immutable by the D4b trigger);
    // regenerating from a mutated project produces a DIFFERENT value, and the
    // old one still names Logo A's object — which was never overwritten,
    // because a different logo hashes to a different path.
    const project = configWithBranding({ accentColor: "#111111", logo: LOGO_A });

    const buildA = createGeneratedPosConfig({ ...GENERATE_INPUT, config: project });
    const frozenA = JSON.parse(JSON.stringify(buildA));

    // Owner replaces the logo and saves.
    const updated = configWithBranding({ accentColor: "#111111", logo: LOGO_B });
    const buildB = createGeneratedPosConfig({ ...GENERATE_INPUT, config: updated });

    expect(frozenA.branding.logo.path).toBe(LOGO_A.path);
    expect(buildB.branding.logo?.path).toBe(LOGO_B.path);
    expect(frozenA.branding.logo.path).not.toBe(buildB.branding.logo?.path);
  });

  it("removing the logo leaves an older snapshot's logo in place", () => {
    const buildA = JSON.parse(
      JSON.stringify(
        createGeneratedPosConfig({
          ...GENERATE_INPUT,
          config: configWithBranding({ accentColor: "#111111", logo: LOGO_A }),
        })
      )
    );

    const afterRemoval = createGeneratedPosConfig({
      ...GENERATE_INPUT,
      config: configWithBranding({ accentColor: "#111111" }),
    });

    expect(buildA.branding.logo.path).toBe(LOGO_A.path);
    expect("logo" in afterRemoval.branding).toBe(false);
  });

  it("two different logos never share an object path", () => {
    expect(LOGO_A.path).not.toBe(LOGO_B.path);
  });
});

// ---------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------

describe("cloneProjectConfig", () => {
  it("deep-copies the logo so two sessions cannot share one object", () => {
    const source = configWithBranding({ accentColor: "#111111", logo: LOGO_A });
    const copy = cloneProjectConfig(source);

    expect(copy.branding.logo).toEqual(LOGO_A);
    expect(copy.branding.logo).not.toBe(source.branding.logo);
  });

  it("clones a no-logo config without inventing the key", () => {
    const copy = cloneProjectConfig(configWithBranding({ accentColor: "#111111" }));

    expect(copy.branding).toEqual({ accentColor: "#111111" });
    expect("logo" in copy.branding).toBe(false);
  });

  it("mutating the copy's logo does not affect the source", () => {
    const source = configWithBranding({ accentColor: "#111111", logo: LOGO_A });
    const copy = cloneProjectConfig(source);

    if (copy.branding.logo) {
      copy.branding.logo.width = 999;
    }

    expect(source.branding.logo?.width).toBe(240);
  });
});
