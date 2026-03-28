import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tuneCommand } from "../../../src/cli/commands/tune.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

describe("tune command", () => {
  let mockChild: ChildProcess & EventEmitter;
  let spawnMock: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const { spawn } = await import("node:child_process");
    spawnMock = vi.mocked(spawn);

    mockChild = new EventEmitter() as ChildProcess & EventEmitter;
    spawnMock.mockReturnValue(mockChild);

    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
  });

  it("has correct command name and description", () => {
    expect(tuneCommand.command).toBe("tune");
    expect(tuneCommand.describe).toContain("Auto-tune");
  });

  it("spawns tune.mjs with no extra args when called with defaults", () => {
    (tuneCommand.handler as (args: object) => void)({ path: undefined, full: false });

    expect(spawnMock).toHaveBeenCalledOnce();
    const [execPath, args, opts] = spawnMock.mock.calls[0] as [string, string[], SpawnOptions];
    expect(execPath).toBe(process.execPath);
    expect(args[args.length - 1]).toContain("tune.mjs");
    expect(args).not.toContain("--path");
    expect(args).not.toContain("--full");
    expect(opts.stdio).toBe("inherit");
  });

  it("passes --path when provided", () => {
    (tuneCommand.handler as (args: object) => void)({ path: "/my/project", full: false });

    const [, args] = spawnMock.mock.calls[0] as [string, string[], SpawnOptions];
    expect(args).toContain("--path");
    expect(args).toContain("/my/project");
  });

  it("passes --full when flag is set", () => {
    (tuneCommand.handler as (args: object) => void)({ path: undefined, full: true });

    const [, args] = spawnMock.mock.calls[0] as [string, string[], SpawnOptions];
    expect(args).toContain("--full");
  });

  it("exits with child process exit code", () => {
    (tuneCommand.handler as (args: object) => void)({ path: undefined, full: false });

    mockChild.emit("exit", 0);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 when child exits with null code", () => {
    (tuneCommand.handler as (args: object) => void)({ path: undefined, full: false });

    mockChild.emit("exit", null);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
