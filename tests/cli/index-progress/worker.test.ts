import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerMessage } from "../../../src/cli/index-progress/ipc-protocol.js";
import { deriveEnrichmentOutcome, runIndexWorker } from "../../../src/cli/index-progress/worker.js";
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
});
