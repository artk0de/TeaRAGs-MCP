import { existsSync } from "node:fs";
import type * as NodeFs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrime } from "../../../src/cli/prime/run-prime.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { available, unavailable, upToDate } from "../../../src/cli/update-check/types.js";

const { pingMock, createAppContextMock } = vi.hoisted(() => ({
  pingMock: vi.fn(),
  createAppContextMock: vi.fn(),
}));

function stubUpdateService(): UpdateCheckService {
  return { checkForUpdate: vi.fn().mockResolvedValue(unavailable("timeout")) } as unknown as UpdateCheckService;
}

const writeMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);
beforeEach(() => {
  writeMock.mockClear();
  pingMock.mockReset();
  createAppContextMock.mockReset();
  process.stdout.write = writeMock as unknown as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = stdoutOriginal;
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("../../../src/cli/prime/qdrant-ping.js", () => ({
  pingQdrant: pingMock,
}));

vi.mock("../../../src/bootstrap/factory.js", () => ({
  createAppContext: createAppContextMock,
}));

vi.mock("../../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: () => ({}),
  getZodConfig: () => ({ deprecations: [] }),
}));

describe("runPrime — happy path", () => {
  it("calls all three App methods and writes formatted digest to stdout", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const cleanupMock = vi.fn();
    const getStatusMock = vi.fn().mockResolvedValue({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
    });
    const getMetricsMock = vi.fn().mockResolvedValue({
      collection: "c",
      totalChunks: 100,
      totalFiles: 10,
      distributions: { language: { typescript: 100 } },
      signals: {},
    });
    const checkDriftMock = vi.fn().mockResolvedValue(null);

    createAppContextMock.mockResolvedValue({
      app: {
        getIndexStatus: getStatusMock,
        getIndexMetrics: getMetricsMock,
        checkSchemaDrift: checkDriftMock,
      },
      cleanup: cleanupMock,
      updateService: stubUpdateService(),
    });

    await runPrime({ path: "/some/project" });

    expect(getStatusMock).toHaveBeenCalledWith("/some/project");
    expect(getMetricsMock).toHaveBeenCalledWith("/some/project");
    expect(checkDriftMock).toHaveBeenCalledWith({ path: "/some/project" });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("# tea-rags prime — /some/project");
    expect(cleanupMock).toHaveBeenCalled();
  });

  it("calls ctx.cleanup in the finally block for best-effort teardown", async () => {
    // The guaranteed process reap lives in the prime command handler
    // (process.exit(0)); cleanup here is best-effort, fire-and-forget by design.
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const cleanupMock = vi.fn();

    createAppContextMock.mockResolvedValue({
      app: {
        getIndexStatus: vi.fn().mockResolvedValue({
          isIndexed: true,
          status: "indexed",
          collectionName: "c",
          chunksCount: 100,
        }),
        getIndexMetrics: vi.fn().mockResolvedValue({
          collection: "c",
          totalChunks: 100,
          totalFiles: 10,
          distributions: { language: { typescript: 100 } },
          signals: {},
        }),
        checkSchemaDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: cleanupMock,
      updateService: stubUpdateService(),
    });

    await runPrime({ path: "/some/project" });

    expect(cleanupMock).toHaveBeenCalledOnce();
  });
});

describe("runPrime — failure paths", () => {
  it("does NOT call createAppContext when path is missing", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    createAppContextMock.mockClear();
    pingMock.mockClear();

    await runPrime({ path: "/missing/dir" });

    expect(createAppContextMock).not.toHaveBeenCalled();
    expect(pingMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("Path not found: /missing/dir");
  });

  it("does NOT call createAppContext when Qdrant ping fails", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(false);
    createAppContextMock.mockClear();

    await runPrime({ path: "/some/project" });

    expect(createAppContextMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("warm-up pending");
  });

  it("emits qdrant-cold placeholder + cleans up when getIndexStatus rejects after bootstrap", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const cleanupMock = vi.fn();
    const getStatusMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    const getMetricsMock = vi.fn().mockResolvedValue({});
    const checkDriftMock = vi.fn().mockResolvedValue(null);

    createAppContextMock.mockResolvedValue({
      app: {
        getIndexStatus: getStatusMock,
        getIndexMetrics: getMetricsMock,
        checkSchemaDrift: checkDriftMock,
      },
      cleanup: cleanupMock,
      updateService: stubUpdateService(),
    });

    await runPrime({ path: "/some/project" });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("warm-up pending");
    expect(cleanupMock).toHaveBeenCalled();
  });
});

describe("runPrime — update-check integration", () => {
  function buildFullCtx(checkForUpdate: ReturnType<typeof vi.fn>) {
    return {
      app: {
        getIndexStatus: vi.fn().mockResolvedValue({
          isIndexed: true,
          status: "indexed",
          collectionName: "c",
          chunksCount: 100,
        }),
        getIndexMetrics: vi.fn().mockResolvedValue({
          collection: "c",
          totalChunks: 100,
          totalFiles: 10,
          distributions: { language: { typescript: 100 } },
          signals: {},
        }),
        checkSchemaDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: vi.fn(),
      updateService: { checkForUpdate } as unknown as UpdateCheckService,
    };
  }

  it("includes the update section in stdout when available", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const ctx = buildFullCtx(vi.fn().mockResolvedValue(available("1.0.0", "1.1.0")));
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime({ path: "/some/project" });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("## tea-rags package");
  });

  it("omits the update section when up-to-date", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const ctx = buildFullCtx(vi.fn().mockResolvedValue(upToDate("1.0.0")));
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime({ path: "/some/project" });

    expect(writeMock.mock.calls[0][0]).not.toContain("## tea-rags package");
  });

  it("does not stall the digest if checkForUpdate rejects (rejections still resolve allSettled)", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const ctx = buildFullCtx(vi.fn().mockRejectedValue(new Error("boom")));
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime({ path: "/some/project" });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("# tea-rags prime");
  });

  it("calls checkForUpdate with allowNetwork=true, timeoutMs=1500, preferCache=true", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(true);
    const checkForUpdateMock = vi.fn().mockResolvedValue(upToDate("1.0.0"));
    const ctx = buildFullCtx(checkForUpdateMock);
    createAppContextMock.mockResolvedValue(ctx);

    await runPrime({ path: "/some/project" });

    expect(checkForUpdateMock).toHaveBeenCalledWith({
      allowNetwork: true,
      timeoutMs: 1500,
      preferCache: true,
    });
  });
});
