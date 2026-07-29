import { describe, expect, it } from "vitest";
import { computeGeneratedPosConfigHash } from "@/lib/buildJobs.server";
import { createGeneratedPosConfig } from "@/lib/generatedPosConfig";
import { defaultProjectConfig } from "@/lib/projectConfig";

const BASE_INPUT = {
  projectId: "project-123",
  projectName: "Test Project",
  templateId: "restaurant",
};

function makeConfig(overrides: Parameters<typeof createGeneratedPosConfig>[1] = {}) {
  return createGeneratedPosConfig(
    { ...BASE_INPUT, config: defaultProjectConfig },
    overrides
  );
}

describe("computeGeneratedPosConfigHash", () => {
  it("returns a 64-character lowercase hexadecimal string", () => {
    const hash = computeGeneratedPosConfigHash(makeConfig());

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same hash when only generatedAt differs", () => {
    const hashA = computeGeneratedPosConfigHash(
      makeConfig({ generatedAt: "2026-01-01T00:00:00.000Z" })
    );
    const hashB = computeGeneratedPosConfigHash(
      makeConfig({ generatedAt: "2027-06-15T12:30:00.000Z" })
    );

    expect(hashA).toBe(hashB);
  });

  it("produces a different hash when menu item order differs", () => {
    const config = makeConfig();
    const reordered = { ...config, menuItems: [...config.menuItems].reverse() };

    expect(computeGeneratedPosConfigHash(config)).not.toBe(
      computeGeneratedPosConfigHash(reordered)
    );
  });

  it("produces a different hash when a real config field differs", () => {
    const config = makeConfig();
    const withDifferentTaxRate = {
      ...config,
      tax: { ...config.tax, rate: config.tax.rate + 1 },
    };

    expect(computeGeneratedPosConfigHash(config)).not.toBe(
      computeGeneratedPosConfigHash(withDifferentTaxRate)
    );
  });

  it("does not mutate the input", () => {
    const config = makeConfig();
    const before = JSON.parse(JSON.stringify(config));

    computeGeneratedPosConfigHash(config);

    expect(config).toEqual(before);
  });
});
