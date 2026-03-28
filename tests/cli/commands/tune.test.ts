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
    expect(tuneCommand.command).toBe("tune [subcommand]");
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

  it("forwards qdrant-url as QDRANT_URL env var", () => {
    (tuneCommand.handler as (args: object) => void)({ "qdrant-url": "http://qdrant:6333", full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.QDRANT_URL).toBe("http://qdrant:6333");
  });

  it("forwards embedding-url as EMBEDDING_BASE_URL env var", () => {
    (tuneCommand.handler as (args: object) => void)({ "embedding-url": "http://ollama:11434", full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.EMBEDDING_BASE_URL).toBe("http://ollama:11434");
  });

  it("forwards model as EMBEDDING_MODEL env var", () => {
    (tuneCommand.handler as (args: object) => void)({ model: "nomic-embed-text", full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.EMBEDDING_MODEL).toBe("nomic-embed-text");
  });

  it("forwards provider as EMBEDDING_PROVIDER env var", () => {
    (tuneCommand.handler as (args: object) => void)({ provider: "onnx", full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.EMBEDDING_PROVIDER).toBe("onnx");
  });

  it("forwards all optional env vars together", () => {
    (tuneCommand.handler as (args: object) => void)({
      path: "/project",
      "qdrant-url": "http://qdrant:6333",
      "embedding-url": "http://ollama:11434",
      model: "jina",
      provider: "ollama",
      full: true,
    });

    const [, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(args).toContain("--path");
    expect(args).toContain("--full");
    expect(opts.env?.QDRANT_URL).toBe("http://qdrant:6333");
    expect(opts.env?.EMBEDDING_BASE_URL).toBe("http://ollama:11434");
    expect(opts.env?.EMBEDDING_MODEL).toBe("jina");
    expect(opts.env?.EMBEDDING_PROVIDER).toBe("ollama");
  });

  it("does not set env vars when optional args are undefined", () => {
    (tuneCommand.handler as (args: object) => void)({ full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.QDRANT_URL).toBeUndefined();
    expect(opts.env?.EMBEDDING_BASE_URL).toBeUndefined();
    expect(opts.env?.EMBEDDING_MODEL).toBeUndefined();
    expect(opts.env?.EMBEDDING_PROVIDER).toBeUndefined();
  });
});
