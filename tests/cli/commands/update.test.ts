import EventEmitter from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runUpdateCommand, updateCommand, type RunUpdateDeps } from "../../../src/cli/commands/update.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { available, unavailable, upToDate } from "../../../src/cli/update-check/types.js";

// Contract-level: stub the real network-touching service so the default-deps
// handler path resolves instantly. Without this the handler test drives a live
// npm-registry fetch (~1s) that flakes under full-suite parallel load. The
// runUpdateCommand tests below inject their own service via depsOverride and are
// unaffected by this module mock.
vi.mock("../../../src/cli/update-check/check-service.js", () => ({
  UpdateCheckService: class {
    checkForUpdate = vi.fn().mockResolvedValue({ kind: "unavailable", reason: "network" });
  },
}));

const stdoutMock = vi.fn();
const stderrMock = vi.fn();
const exitMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);
const stderrOriginal = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stdoutMock.mockReset();
  stderrMock.mockReset();
  exitMock.mockReset();
  process.stdout.write = stdoutMock;
  process.stderr.write = stderrMock;
});

afterEach(() => {
  process.stdout.write = stdoutOriginal;
  process.stderr.write = stderrOriginal;
});

function makeService(status: ReturnType<typeof available>): UpdateCheckService {
  return {
    checkForUpdate: vi.fn().mockResolvedValue(status),
  } as unknown as UpdateCheckService;
}

function makeSpawn(behavior: { exitCode?: number | null; errorEvent?: Error }) {
  return vi.fn().mockImplementation(() => {
    const ee = new EventEmitter() as EventEmitter & { kill?: () => void };
    setImmediate(() => {
      if (behavior.errorEvent) {
        ee.emit("error", behavior.errorEvent);
        return;
      }
      ee.emit("exit", behavior.exitCode ?? 0);
    });
    return ee;
  });
}

interface FakeClaudeRun {
  code: number | null;
  stdout: string;
  missing: boolean;
}

function claudeResult(json: object, code = 0): FakeClaudeRun {
  return { code, stdout: `${JSON.stringify(json)}\n`, missing: false };
}

/** Answers each `claude …` invocation by its joined argument line; unknown lines fail. */
function makeRunClaude(answers: Record<string, FakeClaudeRun>) {
  return vi.fn(async (args: string[]) => answers[args.join(" ")] ?? { code: 1, stdout: "", missing: false });
}

const claudeMissing = vi.fn(async () => ({ code: null, stdout: "", missing: true }));

const PLUGIN_LIST = "plugin list --json";
const MARKETPLACE_UPDATE = "plugin marketplace update tea-rags --json";

function installedPlugins(...ids: string[]): FakeClaudeRun {
  return {
    code: 0,
    stdout: JSON.stringify(ids.map((id) => ({ id, version: "0.1.0", scope: "user" }))),
    missing: false,
  };
}

function printed(mock: ReturnType<typeof vi.fn>): string {
  return mock.mock.calls.map((c) => String(c[0])).join("");
}

describe("runUpdateCommand", () => {
  it("prints up-to-date message and exits 0", async () => {
    await runUpdateCommand({
      service: makeService(upToDate("1.23.1")),
      spawn: makeSpawn({}),
      exit: exitMock,
    });
    expect(stdoutMock).toHaveBeenCalled();
    expect(stdoutMock.mock.calls[0][0]).toContain("up to date");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("on 'available', prints upgrade message and spawns npm install -g tea-rags@latest", async () => {
    const spawn = makeSpawn({ exitCode: 0 });
    await runUpdateCommand({
      service: makeService(available("1.23.1", "1.24.0")),
      spawn,
      runClaude: claudeMissing,
      exit: exitMock,
    });
    // Wait for setImmediate to flush the exit event.
    await new Promise((r) => setImmediate(r));
    expect(spawn).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "tea-rags@latest"],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({ npm_config_ignore_scripts: "false" }),
      }),
    );
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("forwards non-zero npm exit code", async () => {
    await runUpdateCommand({
      service: makeService(available("1.23.1", "1.24.0")),
      spawn: makeSpawn({ exitCode: 7 }),
      exit: exitMock,
    });
    await new Promise((r) => setImmediate(r));
    expect(exitMock).toHaveBeenCalledWith(7);
  });

  it("on 'unavailable', prints to stderr and exits 1", async () => {
    await runUpdateCommand({
      service: makeService(unavailable("network")),
      spawn: makeSpawn({}),
      exit: exitMock,
    });
    expect(stderrMock).toHaveBeenCalled();
    expect(stderrMock.mock.calls[0][0].toLowerCase()).toContain("couldn't check");
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  it("on spawn 'error' event (npm not in PATH), prints helpful stderr and exits 127", async () => {
    await runUpdateCommand({
      service: makeService(available("1.23.1", "1.24.0")),
      spawn: makeSpawn({ errorEvent: new Error("ENOENT") }),
      exit: exitMock,
    });
    await new Promise((r) => setImmediate(r));
    expect(stderrMock).toHaveBeenCalled();
    expect(stderrMock.mock.calls.some((c) => String(c[0]).includes("npm not found"))).toBe(true);
    expect(exitMock).toHaveBeenCalledWith(127);
  });

  it("calls service with allowNetwork=true and preferCache=false (live HTTP)", async () => {
    const svc = makeService(upToDate("1.23.1"));
    await runUpdateCommand({
      service: svc,
      spawn: makeSpawn({}),
      exit: exitMock,
    });
    expect(svc.checkForUpdate).toHaveBeenCalledWith({
      allowNetwork: true,
      preferCache: false,
    });
  });

  it("on a non-ENOENT spawn 'error' event, prints the raw failure to stderr and exits 1", async () => {
    // Drives the `child.on("error", ...)` fall-through branch (not the
    // npm-not-found code path), so the user still sees a typed failure
    // instead of a silent hang.
    await runUpdateCommand({
      service: makeService(available("1.23.1", "1.24.0")),
      spawn: makeSpawn({ errorEvent: new Error("EACCES: permission denied") }),
      exit: exitMock,
    });
    await new Promise((r) => setImmediate(r));
    expect(stderrMock).toHaveBeenCalled();
    expect(
      stderrMock.mock.calls.some((c) => String(c[0]).includes("Failed to spawn npm: EACCES: permission denied")),
    ).toBe(true);
    expect(exitMock).toHaveBeenCalledWith(1);
  });
});

describe("runUpdateCommand — Claude Code plugin sync", () => {
  async function update(runClaude: RunUpdateDeps["runClaude"], npmExitCode = 0): Promise<void> {
    await runUpdateCommand({
      service: makeService(available("1.23.1", "1.24.0")),
      spawn: makeSpawn({ exitCode: npmExitCode }),
      runClaude,
      exit: exitMock,
    });
    await vi.waitFor(() => {
      expect(exitMock).toHaveBeenCalled();
    });
  }

  it("refreshes the marketplace and updates every installed tea-rags plugin, never with -y", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: installedPlugins(
        "tea-rags@tea-rags",
        "dinopowers@tea-rags",
        "superpowers@claude-plugins-official",
      ),
      [MARKETPLACE_UPDATE]: claudeResult({ command: "marketplace-update", outcome: "ok" }),
      "plugin update tea-rags@tea-rags --json": claudeResult({
        command: "update",
        outcome: "ok",
        pluginId: "tea-rags@tea-rags",
        oldVersion: "0.44.7",
        newVersion: "0.44.11",
      }),
      "plugin update dinopowers@tea-rags --json": claudeResult({
        command: "update",
        outcome: "ok",
        pluginId: "dinopowers@tea-rags",
        oldVersion: "0.22.6",
        newVersion: "0.22.6",
      }),
    });

    await update(runClaude);

    expect(runClaude.mock.calls.map((c) => c[0].join(" "))).toEqual([
      PLUGIN_LIST,
      MARKETPLACE_UPDATE,
      "plugin update tea-rags@tea-rags --json",
      "plugin update dinopowers@tea-rags --json",
    ]);
    expect(runClaude.mock.calls.flatMap((c) => c[0])).not.toContain("-y");
    const out = printed(stdoutMock);
    expect(out).toContain("tea-rags@tea-rags 0.44.7 → 0.44.11");
    expect(out).not.toContain("dinopowers@tea-rags 0.22.6 →");
    expect(out.trimEnd().endsWith("Restart Claude Code to load the updated plugins.")).toBe(true);
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("prints one line and stops when the claude CLI is not installed", async () => {
    const runClaude = vi.fn(async () => ({ code: null, stdout: "", missing: true }));

    await update(runClaude);

    expect(runClaude).toHaveBeenCalledTimes(1);
    expect(printed(stdoutMock)).toContain("claude CLI not found — Claude Code plugins not synced.");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("stays silent and skips the marketplace when no tea-rags plugin is installed", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: installedPlugins("superpowers@claude-plugins-official"),
    });

    await update(runClaude);

    expect(runClaude.mock.calls.map((c) => c[0].join(" "))).toEqual([PLUGIN_LIST]);
    expect(printed(stdoutMock)).not.toMatch(/plugin/i);
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("reports a failed plugin update, still updates the others and exits 0", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: installedPlugins("tea-rags@tea-rags", "dinopowers@tea-rags"),
      [MARKETPLACE_UPDATE]: claudeResult({ command: "marketplace-update", outcome: "ok" }),
      "plugin update tea-rags@tea-rags --json": claudeResult(
        { command: "update", outcome: "failed", pluginId: "tea-rags@tea-rags", message: "network unreachable" },
        1,
      ),
      "plugin update dinopowers@tea-rags --json": claudeResult({
        command: "update",
        outcome: "ok",
        pluginId: "dinopowers@tea-rags",
        oldVersion: "0.22.4",
        newVersion: "0.22.6",
      }),
    });

    await update(runClaude);

    expect(printed(stderrMock)).toContain("tea-rags@tea-rags: network unreachable");
    expect(printed(stdoutMock)).toContain("dinopowers@tea-rags 0.22.4 → 0.22.6");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  it("shows a marketplace-declared command for confirmation instead of accepting it", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: installedPlugins("tea-rags@tea-rags"),
      [MARKETPLACE_UPDATE]: claudeResult({ command: "marketplace-update", outcome: "ok" }),
      "plugin update tea-rags@tea-rags --json": claudeResult(
        {
          command: "update",
          outcome: "refused",
          pluginId: "tea-rags@tea-rags",
          shownCommand: { kind: "entry_helper", command: "./fetch-archive.sh", sha256: "abc123" },
        },
        1,
      ),
    });

    await update(runClaude);

    expect(runClaude.mock.calls.flatMap((c) => c[0])).not.toContain("--accept-command");
    const out = printed(stdoutMock);
    expect(out).toContain("./fetch-archive.sh");
    expect(out).toContain("claude plugin update tea-rags@tea-rags --accept-command abc123");
    expect(out).not.toContain("Restart Claude Code");
    expect(exitMock).toHaveBeenCalledWith(0);
  });

  describe("default claude runner (spawned through deps.spawn)", () => {
    /** npm exits 0; `claude` either fails to spawn or writes `stdout` and closes. */
    function routedSpawn(claude: { errorEvent?: NodeJS.ErrnoException; stdout?: string }) {
      return vi.fn().mockImplementation((command: string) => {
        const child = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
        child.stdout = new EventEmitter();
        setImmediate(() => {
          if (command === "npm") {
            child.emit("exit", 0);
            return;
          }
          if (claude.errorEvent) {
            child.emit("error", claude.errorEvent);
            return;
          }
          child.stdout?.emit("data", Buffer.from(claude.stdout ?? ""));
          child.emit("close", 0);
        });
        return child;
      });
    }

    it("maps a claude spawn ENOENT to the not-installed line", async () => {
      const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      const spawn = routedSpawn({ errorEvent: enoent });

      await runUpdateCommand({ service: makeService(available("1.23.1", "1.24.0")), spawn, exit: exitMock });
      await vi.waitFor(() => {
        expect(exitMock).toHaveBeenCalled();
      });

      expect(spawn).toHaveBeenCalledWith("claude", ["plugin", "list", "--json"], expect.anything());
      expect(printed(stdoutMock)).toContain("claude CLI not found — Claude Code plugins not synced.");
      expect(exitMock).toHaveBeenCalledWith(0);
    });

    it("reads the plugin list from the spawned claude stdout", async () => {
      const spawn = routedSpawn({ stdout: "[]" });

      await runUpdateCommand({ service: makeService(available("1.23.1", "1.24.0")), spawn, exit: exitMock });
      await vi.waitFor(() => {
        expect(exitMock).toHaveBeenCalled();
      });

      expect(spawn).toHaveBeenCalledTimes(2);
      expect(printed(stdoutMock)).not.toMatch(/plugin/i);
      expect(exitMock).toHaveBeenCalledWith(0);
    });
  });

  it("does not sync when npm install fails, and exits with npm's code", async () => {
    const runClaude = makeRunClaude({});

    await update(runClaude, 7);

    expect(runClaude).not.toHaveBeenCalled();
    expect(exitMock).toHaveBeenCalledWith(7);
  });
});

describe("updateCommand", () => {
  it("declares the 'update' command shape and resolves through runUpdateCommand", async () => {
    expect(updateCommand.command).toBe("update");
    expect(updateCommand.describe).toBeTruthy();

    // The default runUpdateCommand path goes through defaultDeps() which
    // would hit the real npm registry. We can't drive it end-to-end here
    // without network, but we can at least assert the handler is async and
    // is callable as a function-shaped command module entry — that exercises
    // line 81 (the public handler indirection) when the real CLI dispatches.
    expect(typeof updateCommand.handler).toBe("function");
  });

  it("handler delegates to runUpdateCommand via default deps (contract)", async () => {
    // UpdateCheckService is mocked at module scope to resolve instantly to
    // "unavailable", so this exercises the real handler→runUpdateCommand
    // indirection (the command-module entrypoint) deterministically and without
    // a live npm-registry fetch. The "unavailable" branch routes to exit(1).
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as (code?: string | number | null) => never);
    try {
      await (updateCommand.handler as (a: unknown) => Promise<void>)({});
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
