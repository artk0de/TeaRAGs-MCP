import { existsSync } from "node:fs";
import type * as NodeFs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrime } from "../../../src/cli/prime/run-prime.js";

const { pingMock, createAppContextMock } = vi.hoisted(() => ({
  pingMock: vi.fn(),
  createAppContextMock: vi.fn(),
}));

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
    });

    await runPrime("/some/project");

    expect(getStatusMock).toHaveBeenCalledWith("/some/project");
    expect(getMetricsMock).toHaveBeenCalledWith("/some/project");
    expect(checkDriftMock).toHaveBeenCalledWith({ path: "/some/project" });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("# tea-rags prime — /some/project");
    expect(cleanupMock).toHaveBeenCalled();
  });
});

describe("runPrime — failure paths", () => {
  it("does NOT call createAppContext when path is missing", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    createAppContextMock.mockClear();
    pingMock.mockClear();

    await runPrime("/missing/dir");

    expect(createAppContextMock).not.toHaveBeenCalled();
    expect(pingMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("Path not found: /missing/dir");
  });

  it("does NOT call createAppContext when Qdrant ping fails", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    pingMock.mockResolvedValue(false);
    createAppContextMock.mockClear();

    await runPrime("/some/project");

    expect(createAppContextMock).not.toHaveBeenCalled();
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toContain("warm-up pending");
  });
});
