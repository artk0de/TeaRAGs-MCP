import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs/yargs";

import { runBackgroundClientUpdate } from "../../../src/cli/client-update/background.js";
import type * as UpdateGuards from "../../../src/cli/client-update/guards.js";
import { isLinkedGlobalInstall, liveIndexWorkers } from "../../../src/cli/client-update/guards.js";
import type * as NpmInstall from "../../../src/cli/client-update/npm-install.js";
import { runNpmGlobalInstall } from "../../../src/cli/client-update/npm-install.js";
import { updateCommand } from "../../../src/cli/commands/update.js";
import type * as PluginSync from "../../../src/cli/plugin-sync/index.js";
import { syncHarnessPlugins } from "../../../src/cli/plugin-sync/index.js";
import { NpmRegistryClient } from "../../../src/cli/update-check/registry-client.js";

vi.mock("../../../src/cli/client-update/background.js", () => ({ runBackgroundClientUpdate: vi.fn() }));
vi.mock("../../../src/cli/client-update/guards.js", async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateGuards>()),
  isLinkedGlobalInstall: vi.fn().mockResolvedValue(false),
  liveIndexWorkers: vi.fn().mockReturnValue([]),
}));
vi.mock("../../../src/cli/client-update/npm-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof NpmInstall>()),
  runNpmGlobalInstall: vi.fn().mockResolvedValue({ exitCode: 0 }),
}));
vi.mock("../../../src/cli/plugin-sync/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSync>()),
  syncHarnessPlugins: vi.fn().mockResolvedValue({ harnesses: [] }),
}));

let dataDir: string;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("tea-rags update --background", () => {
  it("captures installation output, preserves scoped plugins and returns the background result", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "update-background-"));
    vi.stubEnv("TEA_RAGS_DATA_DIR", dataDir);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const timeline = vi
      .spyOn(NpmRegistryClient.prototype, "fetchReleaseTimeline")
      .mockResolvedValue({ latest: "1.51.0", publishedAt: {} });
    vi.mocked(runBackgroundClientUpdate).mockImplementation(async (deps) => {
      await deps.releaseTimeline();
      expect(await deps.isDevInstall()).toBe(false);
      expect(deps.liveWorkers()).toEqual([]);
      await deps.install("1.51.0");
      await deps.syncPlugins("1.51.0");
      expect(deps.clock()).toBeGreaterThan(0);
      deps.out("background result");
      return 1;
    });

    await (updateCommand.handler as (args: { background: boolean }) => Promise<void>)({ background: true });

    expect(timeline).toHaveBeenCalledWith("tea-rags", { timeoutMs: 30_000 });
    expect(isLinkedGlobalInstall).toHaveBeenCalled();
    expect(liveIndexWorkers).toHaveBeenCalled();
    expect(runNpmGlobalInstall).toHaveBeenCalledWith(expect.any(Function), "1.51.0", "1.51.0", { captureOutput: true });
    expect(syncHarnessPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ clientVersion: "1.51.0", repinScopedClaudeInstalls: false }),
    );
    expect(stdout).toHaveBeenCalledWith("background result\n");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("parses the auto and background options without running an installer", async () => {
    const handler = vi.fn();
    const args = await yargs([])
      .exitProcess(false)
      .command({ ...updateCommand, handler })
      .parseAsync(["update", "--auto", "off", "--background"]);
    expect(args.auto).toBe("off");
    expect(args.background).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("turns automatic updates off without starting a background update when both flags are given", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "update-background-toggle-"));
    vi.stubEnv("TEA_RAGS_DATA_DIR", dataDir);
    vi.stubEnv("TEA_RAGS_AUTO_UPDATE", "0");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.mocked(runBackgroundClientUpdate).mockClear();

    await (updateCommand.handler as (args: { auto: "off"; background: boolean }) => Promise<void>)({
      auto: "off",
      background: true,
    });

    expect(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"))).toEqual({ clientAutoUpdate: false });
    expect(runBackgroundClientUpdate).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
