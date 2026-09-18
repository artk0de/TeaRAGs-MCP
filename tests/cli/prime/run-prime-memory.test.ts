import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrime } from "../../../src/cli/prime/run-prime.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { unavailable } from "../../../src/cli/update-check/types.js";
import type { CollectionMemoryMetrics } from "../../../src/core/api/public/index.js";

const { pingMock, createAppContextMock, parseAppConfigMock } = vi.hoisted(() => ({
  pingMock: vi.fn(),
  createAppContextMock: vi.fn(),
  parseAppConfigMock: vi.fn(),
}));

vi.mock("../../../src/cli/prime/qdrant-ping.js", () => ({
  pingQdrant: pingMock,
}));

vi.mock("../../../src/bootstrap/factory.js", () => ({
  createAppContext: createAppContextMock,
}));

vi.mock("../../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: parseAppConfigMock,
  getZodConfig: () => ({ deprecations: [] }),
}));

const writeMock = vi.fn();
const stdoutOriginal = process.stdout.write.bind(process.stdout);

const zero = { apparentDiskBytes: 0, ramBytes: 0, cachedBytes: 0, expectedCacheBytes: 0 };
const memory: CollectionMemoryMetrics = {
  collection: "code_x",
  total: { apparentDiskBytes: 2 * 1024 ** 3, ramBytes: 3 * 1024 ** 2, cachedBytes: 1024 ** 2, expectedCacheBytes: 0 },
  vectors: [],
  sparseVectors: [],
  payload: zero,
  payloadIndexes: { count: 0, total: zero, byField: [] },
  other: zero,
};

function appWith(getCollectionMemory: ReturnType<typeof vi.fn>, status: Record<string, unknown> = {}) {
  return {
    app: {
      getIndexStatus: vi.fn().mockResolvedValue({
        isIndexed: true,
        status: "indexed",
        collectionName: "code_x",
        chunksCount: 1,
        ...status,
      }),
      getIndexMetrics: vi.fn().mockResolvedValue({
        collection: "code_x",
        totalChunks: 1,
        totalFiles: 1,
        distributions: {},
        signals: {},
      }),
      checkIndexDrift: vi.fn().mockResolvedValue(null),
      getCollectionMemory,
    },
    cleanup: vi.fn(),
    updateService: {
      checkForUpdate: vi.fn().mockResolvedValue(unavailable("timeout")),
    } as unknown as UpdateCheckService,
  };
}

describe("runPrime — collection memory report", () => {
  let dataDir: string;
  let projectDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "run-prime-memory-data-"));
    projectDir = mkdtempSync(join(tmpdir(), "run-prime-memory-proj-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    writeMock.mockClear();
    pingMock.mockReset();
    createAppContextMock.mockReset();
    parseAppConfigMock.mockReset();
    process.stdout.write = writeMock as unknown as typeof process.stdout.write;
    pingMock.mockResolvedValue(true);
    parseAppConfigMock.mockReturnValue({ debug: false });
  });

  afterEach(() => {
    process.stdout.write = stdoutOriginal;
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("asks for the report of the collection the status resolved and renders it", async () => {
    const getCollectionMemory = vi.fn().mockResolvedValue(memory);
    createAppContextMock.mockResolvedValue(appWith(getCollectionMemory));

    await runPrime({ path: projectDir });

    expect(getCollectionMemory).toHaveBeenCalledWith("code_x");
    const out = String(writeMock.mock.calls[0][0]);
    expect(out).toContain("## Memory\nRAM 3.0 MB · page cache 1.0 MB\n");
  });

  it("still renders the digest, without the section, when the report read fails", async () => {
    createAppContextMock.mockResolvedValue(appWith(vi.fn().mockRejectedValue(new Error("boom"))));

    await runPrime({ path: projectDir });

    const out = String(writeMock.mock.calls[0][0]);
    expect(out).toContain("## Drift");
    expect(out).not.toContain("## Memory");
  });

  it("does not ask for a report when the project is not indexed", async () => {
    const getCollectionMemory = vi.fn().mockResolvedValue(memory);
    createAppContextMock.mockResolvedValue(
      appWith(getCollectionMemory, { isIndexed: false, status: "not_indexed", collectionName: "code_x" }),
    );

    await runPrime({ path: projectDir });

    expect(getCollectionMemory).not.toHaveBeenCalled();
  });
});
