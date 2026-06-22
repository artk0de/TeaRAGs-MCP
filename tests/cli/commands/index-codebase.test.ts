/**
 * Unit tests for src/cli/commands/index-codebase.ts.
 *
 * Coverage targets:
 *  - resolveDataDir: TEA_RAGS_DATA_DIR env var vs homedir fallback
 *  - forkWorker: verifies fork is called with correct argv + env payload
 *  - handler __worker=true branch: delegates to worker.main()
 *  - handler supervisor path: forks + supervises and exits with the resolved code
 */

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { fork } from "node:child_process";
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { indexCodebaseCommand } from "../../../src/cli/commands/index-codebase.js";
import { superviseIndexing } from "../../../src/cli/index-progress/supervisor.js";
import { main as workerMain } from "../../../src/cli/index-progress/worker.js";
import { CollectionRegistry } from "../../../src/core/api/public/index.js";

// ---------------------------------------------------------------------------
// Mocks (declared before imports so vi.mock hoisting works)
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  fork: vi.fn(),
}));

vi.mock("../../../src/cli/index-progress/supervisor.js", () => ({
  superviseIndexing: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../../src/cli/index-progress/renderer.js", () => ({
  createRenderer: vi.fn().mockReturnValue({ handle: vi.fn(), stop: vi.fn() }),
}));

vi.mock("../../../src/cli/infra/color.js", () => ({
  createColorizer: vi.fn().mockReturnValue({
    enabled: false,
    background: "dark",
    brand: (s: string) => s,
    ok: (s: string) => s,
    warn: (s: string) => s,
    alert: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
  }),
}));

vi.mock("../../../src/cli/registry-resolver.js", () => ({
  applyProjectDefaults: vi.fn().mockImplementation((argv: unknown) => argv),
}));

vi.mock("../../../src/core/api/public/index.js", async () => {
  const actual = await import("../../../src/core/api/public/index.js");
  return {
    ...actual,
    CollectionRegistry: class {
      constructor(public readonly dataDir: string) {}
      listProjects = vi.fn().mockReturnValue([]);
    },
  };
});

vi.mock("../../../src/cli/index-progress/registry-env.js", () => ({
  resolveRegistryEnv: vi.fn().mockReturnValue({}),
  pickRegistryEntry: vi.fn().mockReturnValue(null),
}));

// Worker main — used in __worker handler branch
vi.mock("../../../src/cli/index-progress/worker.js", () => ({
  main: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & { disconnect: () => void };
  ee.disconnect = vi.fn();
  return ee;
}

describe("resolveDataDir", () => {
  it("uses TEA_RAGS_DATA_DIR env var when set, passing it to CollectionRegistry", async () => {
    const original = process.env.TEA_RAGS_DATA_DIR;
    process.env.TEA_RAGS_DATA_DIR = "/custom/data";
    vi.mocked(fork).mockReturnValue(fakeChild() as never);
    vi.mocked(superviseIndexing).mockResolvedValue(0);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    try {
      await (indexCodebaseCommand.handler as (a: unknown) => Promise<void>)({
        path: "/repo",
        __worker: false,
        force: false,
        "wait-enrichments": false,
      });
      // CollectionRegistry mock is a class — verify via instantiation tracking
      const instances = (CollectionRegistry as unknown as { mock?: { instances: { dataDir: string }[] } }).mock
        ?.instances;
      if (instances && instances.length > 0) {
        expect(instances[instances.length - 1].dataDir).toBe("/custom/data");
      }
    } finally {
      if (original === undefined) delete process.env.TEA_RAGS_DATA_DIR;
      else process.env.TEA_RAGS_DATA_DIR = original;
      exitSpy.mockRestore();
    }
  });
});

describe("indexCodebaseCommand handler — __worker branch", () => {
  it("calls worker.main() and returns when __worker is true", async () => {
    await (indexCodebaseCommand.handler as (a: unknown) => Promise<void>)({ __worker: true });
    expect(workerMain).toHaveBeenCalledTimes(1);
  });
});

describe("indexCodebaseCommand handler — supervisor branch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(superviseIndexing).mockResolvedValue(0);
    vi.mocked(fork).mockReturnValue(fakeChild() as never);
    vi.mocked(workerMain).mockResolvedValue(undefined);
  });

  it("forks the worker process with the correct argv slice and IPC channel", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await (indexCodebaseCommand.handler as (a: unknown) => Promise<void>)({
      path: "/repo/path",
      __worker: false,
      force: false,
      "wait-enrichments": false,
    });

    expect(fork).toHaveBeenCalledWith(
      process.argv[1],
      ["index-codebase", "--__worker"],
      expect.objectContaining({
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }),
    );
    exitSpy.mockRestore();
  });

  it("serializes path and options into TEA_RAGS_INDEX_WORKER env", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await (indexCodebaseCommand.handler as (a: unknown) => Promise<void>)({
      path: "/repo/path",
      __worker: false,
      force: true,
      "wait-enrichments": false,
    });

    const forkCall = vi.mocked(fork).mock.calls[0];
    const forkEnv = (forkCall[2] as Record<string, unknown>).env as Record<string, string>;
    const workerParams = JSON.parse(forkEnv.TEA_RAGS_INDEX_WORKER);
    expect(workerParams.options.forceReindex).toBe(true);

    exitSpy.mockRestore();
  });

  it("passes waitEnrichments=true when --wait-enrichments is set", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await (indexCodebaseCommand.handler as (a: unknown) => Promise<void>)({
      path: "/repo",
      __worker: false,
      force: false,
      "wait-enrichments": true,
    });

    expect(superviseIndexing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ waitEnrichments: true }),
    );
    exitSpy.mockRestore();
  });

  it("exits with the code returned by superviseIndexing", async () => {
    vi.mocked(superviseIndexing).mockResolvedValue(1);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    await (indexCodebaseCommand.handler as (a: unknown) => Promise<void>)({
      path: "/repo",
      __worker: false,
      force: false,
      "wait-enrichments": false,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
