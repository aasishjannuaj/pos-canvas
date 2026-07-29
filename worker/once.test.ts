import { describe, expect, it } from "vitest";
import { parseArgs } from "@/worker/once";

// Feature 15.5 — only parseArgs is tested here: it is the one piece of
// worker/once.ts with no Supabase/I/O dependency, matching this
// repository's existing convention of never mocking the database. main()
// itself is exercised manually (npm run worker:once -- --target ...)
// rather than under a mocked Supabase client.
describe("parseArgs", () => {
  it("parses --target android", () => {
    expect(parseArgs(["--target", "android"])).toEqual({ ok: true, target: "android" });
  });

  it("parses --target=desktop", () => {
    expect(parseArgs(["--target=desktop"])).toEqual({ ok: true, target: "desktop" });
  });

  it("reports missing_target when no --target flag is present", () => {
    expect(parseArgs([])).toEqual({ ok: false, reason: "missing_target" });
  });

  it("reports invalid_target for an unsupported target value", () => {
    expect(parseArgs(["--target", "web"])).toEqual({ ok: false, reason: "invalid_target" });
    expect(parseArgs(["--target=ios"])).toEqual({ ok: false, reason: "invalid_target" });
  });

  it("reports invalid_target when --target has no following value", () => {
    expect(parseArgs(["--target"])).toEqual({ ok: false, reason: "invalid_target" });
  });

  it("reports help_requested for --help or -h, taking priority over other flags", () => {
    expect(parseArgs(["--help"])).toEqual({ ok: false, reason: "help_requested" });
    expect(parseArgs(["-h"])).toEqual({ ok: false, reason: "help_requested" });
    expect(parseArgs(["--target", "android", "--help"])).toEqual({
      ok: false,
      reason: "help_requested",
    });
  });
});
