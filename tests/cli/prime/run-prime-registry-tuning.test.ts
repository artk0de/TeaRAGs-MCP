import { mkdtempSync, rmSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrime } from "../../../src/cli/prime/run-prime.js";
import type { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import { unavailable } from "../../../src/cli/update-check/types.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

const { pingMock, createAppContextMock, parseAppConfigMock, realExistsSyncRef } = vi.hoisted(() => ({
  pingMock: vi.fn(),
  createAppContextMock: vi.fn(),
  parseAppConfigMock: vi.fn(),
  realExistsSyncRef: { current: null as ((p: NodeFs.PathLike) => boolean) | null },
}));

function stubUpdateService(): UpdateCheckService {
  return { checkForUpdate: vi.fn().mockResolvedValue(unavailable("timeout")) } as unknown as UpdateCheckService;
}

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof NodeFs>("node:fs");
  realExistsSyncRef.current = actual.existsSync;
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

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

describe("runPrime — registry-first tuning env re-apply", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "run-prime-tune-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    delete process.env.TRAJECTORY_GIT_CHUNK_CONCURRENCY;
    delete process.env.INGEST_TUNE_FILE_CONCURRENCY;
    writeMock.mockClear();
    pingMock.mockReset();
    createAppContextMock.mockReset();
    parseAppConfigMock.mockReset();
    process.stdout.write = writeMock as unknown as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = stdoutOriginal;
    delete process.env.TEA_RAGS_DATA_DIR;
    delete process.env.TRAJECTORY_GIT_CHUNK_CONCURRENCY;
    delete process.env.INGEST_TUNE_FILE_CONCURRENCY;
    rmSync(dataDir, { recursive: true, force: true });
  });

  function wireApp(): void {
    pingMock.mockResolvedValue(true);
    createAppContextMock.mockResolvedValue({
      app: {
        getIndexStatus: vi.fn().mockResolvedValue({ status: "indexed", collectionName: "code_x", chunksCount: 1 }),
        getIndexMetrics: vi.fn().mockResolvedValue({
          collection: "code_x",
          totalChunks: 1,
          totalFiles: 1,
          distributions: {},
          signals: {},
        }),
        checkSchemaDrift: vi.fn().mockResolvedValue(null),
      },
      cleanup: vi.fn(),
      updateService: stubUpdateService(),
    });
  }

  function recordEntry(registry: CollectionRegistry, path: string, tuning?: Record<string, string>): void {
    registry.record({
      collectionName: "code_tune",
      path,
      embeddingModel: "jina",
      embeddingDimensions: 384,
      qdrantUrl: "http://qdrant:6333",
      ...(tuning !== undefined ? { tuning } : {}),
      indexedAt: "2026-05-01T00:00:00Z",
      teaRagsVersion: "1.0.0",
      chunksCount: 5,
    });
    registry.setName("code_tune", "tune");
  }

  it("seeds tuning env vars BEFORE parseAppConfig fires when the shell does not set them", async () => {
    // Same seam as CODEGRAPH_ENABLED: the MCP server indexed WITH tuning vars
    // in its env block; prime runs in a fresh shell without them. Registry-first
    // re-apply keeps the composition on the index-time tuning instead of code
    // defaults (env > registry > default).
    const realPath = mkdtempSync(join(tmpdir(), "rp-tune-proj-"));
    try {
      recordEntry(new CollectionRegistry(dataDir), realPath, {
        TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5",
        INGEST_TUNE_FILE_CONCURRENCY: "25",
      });

      let envAtParseTime: Record<string, string | undefined> = {};
      parseAppConfigMock.mockImplementation(() => {
        envAtParseTime = {
          TRAJECTORY_GIT_CHUNK_CONCURRENCY: process.env.TRAJECTORY_GIT_CHUNK_CONCURRENCY,
          INGEST_TUNE_FILE_CONCURRENCY: process.env.INGEST_TUNE_FILE_CONCURRENCY,
        };
        return {};
      });
      wireApp();

      await runPrime({ project: "tune" });

      expect(envAtParseTime).toEqual({
        TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5",
        INGEST_TUNE_FILE_CONCURRENCY: "25",
      });
    } finally {
      rmSync(realPath, { recursive: true, force: true });
    }
  });

  it("does NOT override an explicitly set shell env var (env wins over registry)", async () => {
    const realPath = mkdtempSync(join(tmpdir(), "rp-tune-env-"));
    try {
      recordEntry(new CollectionRegistry(dataDir), realPath, { TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5" });
      process.env.TRAJECTORY_GIT_CHUNK_CONCURRENCY = "7";

      let envAtParseTime: string | undefined;
      parseAppConfigMock.mockImplementation(() => {
        envAtParseTime = process.env.TRAJECTORY_GIT_CHUNK_CONCURRENCY;
        return {};
      });
      wireApp();

      await runPrime({ project: "tune" });

      expect(envAtParseTime).toBe("7");
    } finally {
      rmSync(realPath, { recursive: true, force: true });
    }
  });

  it("leaves the env untouched for a legacy entry without a tuning snapshot", async () => {
    const realPath = mkdtempSync(join(tmpdir(), "rp-tune-leg-"));
    try {
      recordEntry(new CollectionRegistry(dataDir), realPath);

      let envAtParseTime: string | undefined;
      parseAppConfigMock.mockImplementation(() => {
        envAtParseTime = process.env.TRAJECTORY_GIT_CHUNK_CONCURRENCY;
        return {};
      });
      wireApp();

      await runPrime({ project: "tune" });

      expect(envAtParseTime).toBeUndefined();
    } finally {
      rmSync(realPath, { recursive: true, force: true });
    }
  });
});
