import { describe, expect, it, vi } from "vitest";

import { syncHarnessPlugins } from "../../../src/cli/plugin-sync/index.js";

const missing = vi.fn(async () => ({ code: null, stdout: "", missing: true }));

describe("syncHarnessPlugins", () => {
  it("reports every harness in claude, codex, cursor order", async () => {
    const report = await syncHarnessPlugins({
      clientVersion: "1.50.0",
      runClaude: missing,
      runCodex: missing,
      homedir: "/nonexistent-home-for-plugin-sync-test",
      codexHome: "/nonexistent-home-for-plugin-sync-test/.codex",
      packageRoot: "/nonexistent-package-root",
    });

    expect(report.harnesses.map((h) => [h.harness, h.report.skipped])).toEqual([
      ["claude", "cli-missing"],
      ["codex", "cli-missing"],
      ["cursor", "none-installed"],
    ]);
  });

  it("turns an adapter that throws into a failed entry instead of aborting the other harnesses", async () => {
    const report = await syncHarnessPlugins({
      clientVersion: "1.50.0",
      runClaude: vi.fn(async () => {
        throw new Error("boom");
      }),
      runCodex: missing,
      homedir: "/nonexistent-home-for-plugin-sync-test",
      codexHome: "/nonexistent-home-for-plugin-sync-test/.codex",
      packageRoot: "/nonexistent-package-root",
    });

    expect(report.harnesses[0]).toEqual({
      harness: "claude",
      report: { updated: [], failed: [{ id: "claude plugins", reason: "boom" }], needsConfirmation: [] },
    });
    expect(report.harnesses[1].report.skipped).toBe("cli-missing");
  });
});
