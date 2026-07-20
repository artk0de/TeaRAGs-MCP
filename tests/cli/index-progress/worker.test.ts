import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerMessage } from "../../../src/cli/index-progress/ipc-protocol.js";
import {
  deriveEnrichmentOutcome,
  resolveCodegraphSizeBytes,
  runIndexWorker,
} from "../../../src/cli/index-progress/worker.js";
import type { IndexStatus } from "../../../src/core/api/public/index.js";

// Bootstrap is dynamically imported inside main(); mock it so the worker entry
// is exercised without spinning up real Qdrant / embeddings (mirrors doctor.test.ts).
const mainFakeApp = {
  indexCodebase: vi.fn(async (_p: unknown, _o: unknown, progress?: (u: unknown) => void) => {
    progress?.({ phase: "embedding", current: 1, total: 1, percentage: 100, message: "" });
    return { status: "completed" };
  }),
  getIndexStatus: vi.fn().mockResolvedValue({
    isIndexed: true,
    status: "indexed",
    enrichment: { git: { file: { status: "healthy" }, chunk: { status: "healthy" } } },
  }),
  whenEnrichmentComplete: vi.fn().mockResolvedValue(undefined),
  // Cheap qdrant round-trip used by the readiness gate (2nfdm) before indexing.
  listCollections: vi.fn().mockResolvedValue([]),
};
const mainCleanup = vi.fn();
vi.mock("../../../src/bootstrap/config/index.js", () => ({ parseAppConfig: vi.fn(() => ({})) }));
vi.mock("../../../src/bootstrap/migrate.js", () => ({ migrateHomeDir: vi.fn() }));
vi.mock("../../../src/bootstrap/factory.js", () => ({
  createAppContext: vi.fn(async () => ({ app: mainFakeApp, cleanup: mainCleanup })),
}));

const healthy: IndexStatus = {
  isIndexed: true,
  status: "indexed",
  enrichment: { git: { file: { status: "healthy" }, chunk: { status: "healthy" } } },
};

describe("resolveCodegraphSizeBytes", () => {
  const originalCodegraphEnabled = process.env.CODEGRAPH_ENABLED;
  const originalDataDir = process.env.TEA_RAGS_DATA_DIR;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "worker-codegraph-test-"));
  });

  afterEach(() => {
    if (originalCodegraphEnabled !== undefined) process.env.CODEGRAPH_ENABLED = originalCodegraphEnabled;
    else delete process.env.CODEGRAPH_ENABLED;
    if (originalDataDir !== undefined) process.env.TEA_RAGS_DATA_DIR = originalDataDir;
    else delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when CODEGRAPH_ENABLED is not set", () => {
    delete process.env.CODEGRAPH_ENABLED;
    expect(resolveCodegraphSizeBytes("code_abc")).toBeUndefined();
  });

  it("returns undefined when CODEGRAPH_ENABLED is 'false'", () => {
    process.env.CODEGRAPH_ENABLED = "false";
    expect(resolveCodegraphSizeBytes("code_abc")).toBeUndefined();
  });

  it("returns undefined when collectionName is undefined", () => {
    process.env.CODEGRAPH_ENABLED = "true";
    process.env.TEA_RAGS_DATA_DIR = tmpDir;
    expect(resolveCodegraphSizeBytes(undefined)).toBeUndefined();
  });

  it("returns undefined when no matching .duckdb file exists", () => {
    process.env.CODEGRAPH_ENABLED = "true";
    process.env.TEA_RAGS_DATA_DIR = tmpDir;
    const codegraphDir = join(tmpDir, "codegraph");
    mkdirSync(codegraphDir, { recursive: true });
    // no matching file
    expect(resolveCodegraphSizeBytes("code_abc")).toBeUndefined();
  });

  it("returns size (blocks*512) of the matching .duckdb file", () => {
    process.env.CODEGRAPH_ENABLED = "true";
    process.env.TEA_RAGS_DATA_DIR = tmpDir;
    const codegraphDir = join(tmpDir, "codegraph");
    mkdirSync(codegraphDir, { recursive: true });
    const dbPath = join(codegraphDir, "code_abc_v3.duckdb");
    writeFileSync(dbPath, Buffer.alloc(4096));
    const st = statSync(dbPath);
    const result = resolveCodegraphSizeBytes("code_abc");
    expect(result).toBe(st.blocks * 512);
    expect(result).toBeGreaterThan(0);
  });

  it("includes .duckdb.wal sibling in the size when present", () => {
    process.env.CODEGRAPH_ENABLED = "true";
    process.env.TEA_RAGS_DATA_DIR = tmpDir;
    const codegraphDir = join(tmpDir, "codegraph");
    mkdirSync(codegraphDir, { recursive: true });
    const dbPath = join(codegraphDir, "code_abc_v3.duckdb");
    const walPath = join(codegraphDir, "code_abc_v3.duckdb.wal");
    writeFileSync(dbPath, Buffer.alloc(4096));
    writeFileSync(walPath, Buffer.alloc(512));
    const stDb = statSync(dbPath);
    const stWal = statSync(walPath);
    const result = resolveCodegraphSizeBytes("code_abc");
    expect(result).toBe(stDb.blocks * 512 + stWal.blocks * 512);
  });

  it("picks the highest version (v3 over v2) when multiple versions exist", () => {
    process.env.CODEGRAPH_ENABLED = "true";
    process.env.TEA_RAGS_DATA_DIR = tmpDir;
    const codegraphDir = join(tmpDir, "codegraph");
    mkdirSync(codegraphDir, { recursive: true });
    const v2Path = join(codegraphDir, "code_abc_v2.duckdb");
    const v3Path = join(codegraphDir, "code_abc_v3.duckdb");
    writeFileSync(v2Path, Buffer.alloc(4096));
    writeFileSync(v3Path, Buffer.alloc(8192));
    const stV3 = statSync(v3Path);
    const result = resolveCodegraphSizeBytes("code_abc");
    expect(result).toBe(stV3.blocks * 512);
  });

  it("returns undefined when codegraph dir does not exist", () => {
    process.env.CODEGRAPH_ENABLED = "true";
    process.env.TEA_RAGS_DATA_DIR = tmpDir;
    // no codegraph/ subdir created
    expect(resolveCodegraphSizeBytes("code_abc")).toBeUndefined();
  });
});

describe("deriveEnrichmentOutcome", () => {
  it("reports a provider with a failed level as failed", () => {
    const outcome = deriveEnrichmentOutcome({
      ...healthy,
      enrichment: { git: { file: { status: "healthy" }, chunk: { status: "failed" } } },
    });
    expect(outcome.failed).toEqual(["git"]);
    expect(outcome.degraded).toEqual([]);
  });

  it("reports a degraded provider as degraded (not failed)", () => {
    const outcome = deriveEnrichmentOutcome({
      ...healthy,
      enrichment: { git: { file: { status: "degraded" }, chunk: { status: "healthy" } } },
    });
    expect(outcome.failed).toEqual([]);
    expect(outcome.degraded).toEqual(["git"]);
  });

  it("reports no failures for a fully healthy index", () => {
    expect(deriveEnrichmentOutcome(healthy)).toEqual({ failed: [], degraded: [] });
  });
});

describe("runIndexWorker", () => {
  function fakeApp() {
    return {
      indexCodebase: vi.fn(async (_path, _opts, progress, enrichmentProgress) => {
        progress?.({ phase: "embedding", current: 5, total: 10, percentage: 50, message: "" });
        enrichmentProgress?.({ providerKey: "git", level: "file", applied: 1, total: 2 });
        return { status: "completed" };
      }),
      getIndexStatus: vi.fn().mockResolvedValue(healthy),
      whenEnrichmentComplete: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("runs index, streams progress, awaits enrichment, emits done", async () => {
    const app = fakeApp();
    const sent: WorkerMessage[] = [];

    const outcome = await runIndexWorker(app as never, "/repo", { forceReindex: true }, (m) => sent.push(m));

    expect(app.indexCodebase).toHaveBeenCalledWith(
      "/repo",
      { forceReindex: true },
      expect.any(Function),
      expect.any(Function),
    );
    expect(app.whenEnrichmentComplete).toHaveBeenCalledTimes(1);
    const types = sent.map((m) => m.type);
    expect(types).toContain("embedding");
    expect(types).toContain("enrichment");
    expect(types).toContain("status");
    expect(types).toContain("done");
    expect(outcome).toEqual({ failed: [], degraded: [] });
  });

  it("forwards totalFinal from progress + enrichmentProgress callbacks onto the IPC messages", async () => {
    const app = {
      indexCodebase: vi.fn(async (_path, _opts, progress, enrichmentProgress) => {
        progress?.({ phase: "embedding", current: 1024, total: 1024, percentage: 38, message: "", totalFinal: false });
        enrichmentProgress?.({ providerKey: "git", level: "chunk", applied: 1005, total: 1024, totalFinal: false });
        return { status: "completed" };
      }),
      getIndexStatus: vi.fn().mockResolvedValue(healthy),
      whenEnrichmentComplete: vi.fn().mockResolvedValue(undefined),
    };
    const sent: WorkerMessage[] = [];

    await runIndexWorker(app as never, "/repo", {}, (m) => sent.push(m));

    const embedding = sent.find((m) => m.type === "embedding") as { totalFinal?: boolean } | undefined;
    const enrichment = sent.find((m) => m.type === "enrichment") as { totalFinal?: boolean } | undefined;
    expect(embedding?.totalFinal).toBe(false);
    expect(enrichment?.totalFinal).toBe(false);
  });

  it("emits phase-done for embedding after indexCodebase and for enrichment after whenEnrichmentComplete", async () => {
    const app = fakeApp();
    const sent: WorkerMessage[] = [];
    let t = 0;

    await runIndexWorker(
      app as never,
      "/repo",
      {},
      (m) => sent.push(m),
      () => {
        // Advance clock for each call so elapsed > 0
        t += 100;
        return t;
      },
    );

    const embeddingDone = sent.find((m) => m.type === "phase-done" && m.phase === "embedding");
    const enrichmentDone = sent.find((m) => m.type === "phase-done" && m.phase === "enrichment");
    expect(embeddingDone).toBeDefined();
    expect(enrichmentDone).toBeDefined();
    if (embeddingDone?.type === "phase-done") expect(embeddingDone.elapsedMs).toBeGreaterThan(0);
    if (enrichmentDone?.type === "phase-done") expect(enrichmentDone.elapsedMs).toBeGreaterThan(0);
  });

  it("awaits enrichment only after indexCodebase resolves", async () => {
    const app = fakeApp();
    const order: string[] = [];
    app.indexCodebase = vi.fn(async () => {
      order.push("index");
      return { status: "completed" };
    });
    app.whenEnrichmentComplete = vi.fn(async () => {
      order.push("enrich");
    });

    await runIndexWorker(app as never, "/repo", {}, () => {});

    expect(order).toEqual(["index", "enrich"]);
  });
});

describe("main — bootstrap guard (no TEA_RAGS_INDEX_WORKER env)", () => {
  let originalEnv: string | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalEnv = process.env.TEA_RAGS_INDEX_WORKER;
    delete process.env.TEA_RAGS_INDEX_WORKER;
    // Throw from process.exit so execution stops at the guard (matching real semantics)
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TEA_RAGS_INDEX_WORKER = originalEnv;
    } else {
      delete process.env.TEA_RAGS_INDEX_WORKER;
    }
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("writes an error to stderr and exits with code 1 when TEA_RAGS_INDEX_WORKER is absent", async () => {
    const { main } = await import("../../../src/cli/index-progress/worker.js");
    await expect(main()).rejects.toThrow("process.exit(1)");

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("worker invoked without"));
  });
});

describe("main — bootstrap happy path", () => {
  let originalEnv: string | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const sendSpy = vi.fn(() => true);

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish impls after clear (the setup may reset mock implementations).
    mainFakeApp.indexCodebase.mockImplementation(async (_p: unknown, _o: unknown, progress?: (u: unknown) => void) => {
      progress?.({ phase: "embedding", current: 1, total: 1, percentage: 100, message: "" });
      return { status: "completed" };
    });
    mainFakeApp.getIndexStatus.mockResolvedValue({
      isIndexed: true,
      status: "indexed",
      enrichment: { git: { file: { status: "healthy" }, chunk: { status: "healthy" } } },
    });
    mainFakeApp.whenEnrichmentComplete.mockResolvedValue(undefined);
    originalEnv = process.env.TEA_RAGS_INDEX_WORKER;
    process.env.TEA_RAGS_INDEX_WORKER = JSON.stringify({ path: "/repo", options: { forceReindex: true } });
    // No-op exit: the real process.exit never returns, but the success-path
    // exit(0) sits inside main()'s try — a throwing mock would be caught and
    // re-exit(1). A no-op lets main() resolve; assert the code via the spy.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    // process.send is undefined off a real IPC channel — install a plain mock.
    (process as { send?: unknown }).send = sendSpy;
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.TEA_RAGS_INDEX_WORKER = originalEnv;
    else delete process.env.TEA_RAGS_INDEX_WORKER;
    exitSpy.mockRestore();
    delete (process as { send?: unknown }).send;
  });

  it("bootstraps, indexes, awaits enrichment, and exits 0 on a healthy outcome", async () => {
    const { main } = await import("../../../src/cli/index-progress/worker.js");
    await main();

    expect(mainFakeApp.indexCodebase).toHaveBeenCalledWith(
      "/repo",
      { forceReindex: true },
      expect.any(Function),
      expect.any(Function),
    );
    expect(mainFakeApp.whenEnrichmentComplete).toHaveBeenCalledTimes(1);
    expect(mainCleanup).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("exits 1 and sends an error message when indexing throws", async () => {
    mainFakeApp.indexCodebase.mockRejectedValueOnce(new Error("index boom"));
    const { main } = await import("../../../src/cli/index-progress/worker.js");
    await main();

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "index boom" }));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("wires an onTurboMigration hook that forwards a turbo-migration IPC message", async () => {
    const { createAppContext } = await import("../../../src/bootstrap/factory.js");
    const { main } = await import("../../../src/cli/index-progress/worker.js");
    await main();

    const hooks = vi.mocked(createAppContext).mock.calls.at(-1)?.[1];
    expect(hooks?.onTurboMigration).toBeTypeOf("function");
    hooks?.onTurboMigration?.({ collection: "code_abc", stage: "done", elapsedMs: 4200 });
    expect(sendSpy).toHaveBeenCalledWith({
      type: "turbo-migration",
      collection: "code_abc",
      stage: "done",
      elapsedMs: 4200,
    });
  });

  it("installs the crash guard on the real process (tea-rags-mcp-0ej8v)", async () => {
    const onSpy = vi.spyOn(process, "on");
    try {
      const { main } = await import("../../../src/cli/index-progress/worker.js");
      await main();

      const events = onSpy.mock.calls.map((c) => c[0]);
      expect(events).toContain("uncaughtException");
      expect(events).toContain("unhandledRejection");
    } finally {
      onSpy.mockRestore();
    }
  });
});

describe("installWorkerCrashGuard (tea-rags-mcp-0ej8v)", () => {
  // The taxdome codegraph-finalize crash exited 1 with ZERO diagnostics:
  // stderr is discarded without DEBUG and no IPC error was sent, so the
  // supervisor could only print "worker exited with code 1 before reporting a
  // result". The guard must turn any uncaught throw / unhandled rejection
  // into a visible IPC error before exiting.
  const makeProc = () => {
    const listeners = new Map<string, (reason: unknown) => void>();
    return {
      on: vi.fn((event: string, listener: (reason: unknown) => void) => {
        listeners.set(event, listener);
      }),
      exit: vi.fn(),
      emit: (event: string, reason: unknown) => listeners.get(event)?.(reason),
    };
  };

  it("sends an IPC error and exits 1 on uncaughtException", async () => {
    const { installWorkerCrashGuard } = await import("../../../src/cli/index-progress/worker.js");
    const proc = makeProc();
    const send = vi.fn();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      installWorkerCrashGuard(proc as never, send);
      proc.emit("uncaughtException", new Error("finalize boom"));

      expect(send).toHaveBeenCalledWith({
        type: "error",
        message: expect.stringContaining("finalize boom"),
        code: "WORKER_UNCAUGHT",
      });
      expect(proc.exit).toHaveBeenCalledWith(1);
      // Stack echoed to stderr so a DEBUG run captures it in worker-debug logs.
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("sends an IPC error and exits 1 on unhandledRejection with a non-Error reason", async () => {
    const { installWorkerCrashGuard } = await import("../../../src/cli/index-progress/worker.js");
    const proc = makeProc();
    const send = vi.fn();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      installWorkerCrashGuard(proc as never, send);
      proc.emit("unhandledRejection", "string reason");

      expect(send).toHaveBeenCalledWith({
        type: "error",
        message: expect.stringContaining("string reason"),
        code: "WORKER_UNCAUGHT",
      });
      expect(proc.exit).toHaveBeenCalledWith(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
