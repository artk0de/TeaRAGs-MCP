import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tuneCommand } from "../../../src/cli/commands/tune.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock the embedded-daemon resolver so tests never touch the real Qdrant
// binary, port files, or network.
vi.mock("../../../src/core/adapters/qdrant/embedded/daemon.js", () => ({
  resolveQdrantUrl: vi.fn(),
}));

const { resolveQdrantUrl: resolveQdrantUrlMock } =
  (await import("../../../src/core/adapters/qdrant/embedded/daemon.js")) as unknown as {
    resolveQdrantUrl: ReturnType<typeof vi.fn>;
  };

type TuneHandler = (args: Record<string, unknown>) => Promise<void>;

describe("tune command", () => {
  let mockChild: ChildProcess & EventEmitter;
  let spawnMock: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let savedQdrantUrl: string | undefined;

  beforeEach(async () => {
    const { spawn } = await import("node:child_process");
    spawnMock = vi.mocked(spawn);

    mockChild = new EventEmitter() as ChildProcess & EventEmitter;
    spawnMock.mockReturnValue(mockChild);

    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);

    // Isolate from host: clear QDRANT_URL so the resolver doesn't read it.
    savedQdrantUrl = process.env.QDRANT_URL;
    delete process.env.QDRANT_URL;

    // Default: probe found a Qdrant at 6333 (external mode). Tests that
    // exercise the embedded path override this.
    resolveQdrantUrlMock.mockResolvedValue({
      mode: "external",
      url: "http://localhost:6333",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    exitSpy.mockRestore();
    if (savedQdrantUrl === undefined) {
      delete process.env.QDRANT_URL;
    } else {
      process.env.QDRANT_URL = savedQdrantUrl;
    }
  });

  it("has correct command name and description", () => {
    expect(tuneCommand.command).toBe("tune [subcommand]");
    expect(tuneCommand.describe).toContain("Auto-tune");
  });

  it("spawns tune.mjs with no extra args when called with defaults", async () => {
    await (tuneCommand.handler as TuneHandler)({ path: undefined, full: false });

    expect(spawnMock).toHaveBeenCalledOnce();
    const [execPath, args, opts] = spawnMock.mock.calls[0] as [string, string[], SpawnOptions];
    expect(execPath).toBe(process.execPath);
    expect(args[args.length - 1]).toContain("tune.mjs");
    expect(args).not.toContain("--path");
    expect(args).not.toContain("--full");
    expect(opts.stdio).toBe("inherit");
  });

  it("passes --path when provided", async () => {
    await (tuneCommand.handler as TuneHandler)({ path: "/my/project", full: false });

    const [, args] = spawnMock.mock.calls[0] as [string, string[], SpawnOptions];
    expect(args).toContain("--path");
    expect(args).toContain("/my/project");
  });

  it("passes --full when flag is set", async () => {
    await (tuneCommand.handler as TuneHandler)({ path: undefined, full: true });

    const [, args] = spawnMock.mock.calls[0] as [string, string[], SpawnOptions];
    expect(args).toContain("--full");
  });

  it("exits with child process exit code", async () => {
    await (tuneCommand.handler as TuneHandler)({ path: undefined, full: false });

    mockChild.emit("exit", 0);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 when child exits with null code", async () => {
    await (tuneCommand.handler as TuneHandler)({ path: undefined, full: false });

    mockChild.emit("exit", null);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("forwards qdrant-url as QDRANT_URL env var without touching the daemon resolver", async () => {
    await (tuneCommand.handler as TuneHandler)({ "qdrant-url": "http://qdrant:6333", full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.QDRANT_URL).toBe("http://qdrant:6333");
    expect(resolveQdrantUrlMock).not.toHaveBeenCalled();
  });

  it("forwards embedding-url as EMBEDDING_BASE_URL env var", async () => {
    await (tuneCommand.handler as TuneHandler)({ "embedding-url": "http://ollama:11434", full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.EMBEDDING_BASE_URL).toBe("http://ollama:11434");
  });

  it("forwards model as EMBEDDING_MODEL env var", async () => {
    await (tuneCommand.handler as TuneHandler)({ model: "nomic-embed-text", full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.EMBEDDING_MODEL).toBe("nomic-embed-text");
  });

  it("forwards provider as EMBEDDING_PROVIDER env var", async () => {
    await (tuneCommand.handler as TuneHandler)({ provider: "onnx", full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.EMBEDDING_PROVIDER).toBe("onnx");
  });

  it("forwards device as EMBEDDING_DEVICE env var", async () => {
    await (tuneCommand.handler as TuneHandler)({ device: "coreml", full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.EMBEDDING_DEVICE).toBe("coreml");
  });

  it("forwards all optional env vars together", async () => {
    await (tuneCommand.handler as TuneHandler)({
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

  it("uses external Qdrant URL from the daemon resolver when --qdrant-url omitted", async () => {
    resolveQdrantUrlMock.mockResolvedValue({
      mode: "external",
      url: "http://localhost:6333",
    });

    await (tuneCommand.handler as TuneHandler)({ full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.QDRANT_URL).toBe("http://localhost:6333");
  });

  it("spawns embedded daemon URL when 6333 unreachable and releases on child exit", async () => {
    const release = vi.fn();
    resolveQdrantUrlMock.mockResolvedValue({
      mode: "embedded",
      url: "http://127.0.0.1:57321",
      release,
    });

    await (tuneCommand.handler as TuneHandler)({ full: false });

    const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env?.QDRANT_URL).toBe("http://127.0.0.1:57321");
    expect(release).not.toHaveBeenCalled();

    mockChild.emit("exit", 0);
    expect(release).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("dispatches embeddings subcommand to benchmark-embeddings.mjs", async () => {
    await (tuneCommand.handler as TuneHandler)({ subcommand: "embeddings", full: false });

    const [, args] = spawnMock.mock.calls[0] as [string, string[], SpawnOptions];
    expect(args[args.length - 1]).toContain("benchmark-embeddings.mjs");
  });

  describe("--project option", () => {
    let dataDir: string;

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), "tune-proj-"));
      process.env.TEA_RAGS_DATA_DIR = dataDir;
      const registry = new CollectionRegistry(dataDir);
      registry.record({
        collectionName: "code_xyz",
        path: "/repo/x",
        embeddingModel: "model-z",
        embeddingDimensions: 512,
        qdrantUrl: "http://qd:6333",
        indexedAt: "2026-05-13T00:00:00Z",
        teaRagsVersion: "0.1",
        chunksCount: 0,
      });
      registry.setName("code_xyz", "alpha");
    });

    afterEach(() => {
      delete process.env.TEA_RAGS_DATA_DIR;
      rmSync(dataDir, { recursive: true, force: true });
    });

    it("resolves --project to path/qdrant-url/model from registry", async () => {
      await (tuneCommand.handler as TuneHandler)({ project: "alpha", full: false });

      const [, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
      expect(args).toContain("--path");
      expect(args).toContain("/repo/x");
      expect(opts.env?.QDRANT_URL).toBe("http://qd:6333");
      expect(opts.env?.EMBEDDING_MODEL).toBe("model-z");
    });

    it("explicit flags win over registry defaults", async () => {
      await (tuneCommand.handler as TuneHandler)({
        project: "alpha",
        path: "/override",
        model: "override-model",
        full: false,
      });

      const [, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
      expect(args).toContain("/override");
      expect(args).not.toContain("/repo/x");
      expect(opts.env?.EMBEDDING_MODEL).toBe("override-model");
      // qdrant-url falls back to registry
      expect(opts.env?.QDRANT_URL).toBe("http://qd:6333");
    });

    it("unknown project name is caught: writes hint to stderr and exits 1", async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      exitSpy.mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      try {
        await expect((tuneCommand.handler as TuneHandler)({ project: "ghost", full: false })).rejects.toThrow(
          /process\.exit\(1\)/,
        );
        const errOut = stderr.mock.calls.map((c) => String(c[0])).join("");
        expect(errOut).toMatch(/not registered/i);
        expect(errOut.toLowerCase()).toContain("hint");
      } finally {
        stderr.mockRestore();
      }
    });
  });

  describe("tune handler catches applyProjectDefaults typed errors (audit #15 consumer)", () => {
    it("writes message + hint to stderr and exits 1 on ProjectNotRegisteredError", async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      exitSpy.mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const tmp = mkdtempSync(join(tmpdir(), "pr3-tune-"));
      process.env.TEA_RAGS_DATA_DIR = tmp;
      try {
        const { tuneCommand: cmd } = await import("../../../src/cli/commands/tune.js");
        const handler = cmd.handler as (argv: Record<string, unknown>) => Promise<void>;
        await expect(handler({ project: "ghost-alias", _: ["tune"], $0: "tea-rags" } as never)).rejects.toThrow(
          /process\.exit\(1\)/,
        );
        const errOut = stderr.mock.calls.map((c) => String(c[0])).join("");
        expect(errOut).toMatch(/not registered/i);
        expect(errOut.toLowerCase()).toContain("hint");
      } finally {
        stderr.mockRestore();
        rmSync(tmp, { recursive: true, force: true });
        delete process.env.TEA_RAGS_DATA_DIR;
      }
    });

    it("writes path-missing hint to stderr on ProjectPathMissingError", async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      exitSpy.mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const tmp = mkdtempSync(join(tmpdir(), "pr3-tune-"));
      process.env.TEA_RAGS_DATA_DIR = tmp;
      try {
        const reg = new CollectionRegistry(tmp);
        reg.record({
          collectionName: "code_recovered",
          path: "",
          embeddingModel: "",
          embeddingDimensions: 0,
          qdrantUrl: "",
          indexedAt: "",
          teaRagsVersion: "",
          chunksCount: 0,
        });
        reg.setName("code_recovered", "rec");
        const { tuneCommand: cmd } = await import("../../../src/cli/commands/tune.js");
        const handler = cmd.handler as (argv: Record<string, unknown>) => Promise<void>;
        await expect(handler({ project: "rec", _: ["tune"], $0: "tea-rags" } as never)).rejects.toThrow(
          /process\.exit\(1\)/,
        );
        const errOut = stderr.mock.calls.map((c) => String(c[0])).join("");
        expect(errOut.toLowerCase()).toContain("has no path stored");
        expect(errOut).toContain("tea-rags projects register");
      } finally {
        stderr.mockRestore();
        rmSync(tmp, { recursive: true, force: true });
        delete process.env.TEA_RAGS_DATA_DIR;
      }
    });
  });
});
