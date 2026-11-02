import EventEmitter from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientUpdateStateStore } from "../../../src/cli/client-update/state-store.js";
import { runClientAutoUpdateToggle, runUpdateCommand } from "../../../src/cli/commands/update.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { upToDate } from "../../../src/cli/update-check/types.js";

let dataDir: string;
const stdoutMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "update-auto-"));
  stdoutMock.mockReset();
  process.stdout.write = stdoutMock;
});
afterEach(() => {
  process.stdout.write = stdoutOriginal;
  rmSync(dataDir, { recursive: true, force: true });
});

function printed(): string {
  return stdoutMock.mock.calls.map((c) => String(c[0])).join("");
}

describe("tea-rags update --auto on|off", () => {
  it("turns automatic updates off in settings.json, prints the new state and exits 0 without installing", () => {
    const exit = vi.fn();
    runClientAutoUpdateToggle("off", { dataDir, env: {}, exit });
    expect(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"))).toEqual({ clientAutoUpdate: false });
    expect(printed()).toContain("Automatic updates: off — turn on with `tea-rags update --auto on`");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("turns them back on", () => {
    runClientAutoUpdateToggle("off", { dataDir, env: {}, exit: vi.fn() });
    runClientAutoUpdateToggle("on", { dataDir, env: {}, exit: vi.fn() });
    expect(printed()).toContain("Automatic updates: on — turn off with `tea-rags update --auto off`");
  });

  it("names the env override when TEA_RAGS_AUTO_UPDATE still decides", () => {
    runClientAutoUpdateToggle("on", { dataDir, env: { TEA_RAGS_AUTO_UPDATE: "0" }, exit: vi.fn() });
    expect(printed()).toContain("TEA_RAGS_AUTO_UPDATE");
  });
});

describe("tea-rags update — closing state line", () => {
  async function upToDateRun(env: NodeJS.ProcessEnv): Promise<void> {
    return runUpdateCommand({
      service: { checkForUpdate: vi.fn().mockResolvedValue(upToDate("1.23.1")) } as unknown as Pick<
        UpdateCheckService,
        "checkForUpdate"
      >,
      spawn: vi.fn(() => new EventEmitter()) as never,
      runClaude: vi.fn(async () => ({ code: null, stdout: "", missing: true })),
      runCodex: vi.fn(async () => ({ code: null, stdout: "", missing: true })),
      homedir: "/nonexistent-home-for-update-auto-test",
      codexHome: "/nonexistent-home-for-update-auto-test/.codex",
      packageRoot: "/nonexistent-package-root",
      clientVersion: () => "1.23.1",
      dataDir,
      env,
      exit: vi.fn(),
    });
  }

  it("ends with the automatic-update state and how to toggle it", async () => {
    await upToDateRun({});
    expect(printed().trimEnd().split("\n").at(-1)).toBe(
      "Automatic updates: on — turn off with `tea-rags update --auto off`",
    );
  });

  it("clears the manual-update hint a background run left once the manual update succeeded", async () => {
    const store = new ClientUpdateStateStore(join(dataDir, "client-update-state.json"));
    store.update({ manualUpdateHint: "run `tea-rags update` by hand" });
    await upToDateRun({});
    expect(store.read().manualUpdateHint).toBeUndefined();
  });
});
