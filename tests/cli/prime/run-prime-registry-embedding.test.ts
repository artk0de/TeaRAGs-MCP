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
  // Default the mock to the REAL existsSync so registry/internal fs probes
  // work transparently. Individual tests override for the runPrime path
  // check (`existsSync(path)` on the project dir) via mockReturnValue.
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

describe("runPrime — registry-first embedding endpoint override", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "run-prime-emb-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_FALLBACK_URL;
    writeMock.mockClear();
    pingMock.mockReset();
    createAppContextMock.mockReset();
    parseAppConfigMock.mockReset();
    process.stdout.write = writeMock as unknown as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = stdoutOriginal;
    delete process.env.TEA_RAGS_DATA_DIR;
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_FALLBACK_URL;
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

  it("sets EMBEDDING_BASE_URL + EMBEDDING_FALLBACK_URL env BEFORE parseAppConfig fires (so cached zodConfig sees them)", async () => {
    // Registry-first symmetry: prime sets env from the registered URLs
    // BEFORE parseAppConfig runs, so parseAppConfigZod picks them up and
    // caches into _lastZodConfig. createAppContext reads embedding URLs
    // from getZodConfig() (NOT from the AppConfig returned by parseAppConfig),
    // so the env channel is the only mutation site that actually
    // propagates downstream to EmbeddingProviderFactory. Without this,
    // EMBEDDING_BASE_URL set at index time is lost when prime runs in a
    // fresh shell, and the digest falsely reports localhost:11434 (the
    // 2026-05-28 symptom).
    const realPath = mkdtempSync(join(tmpdir(), "rp-proj-"));
    try {
      const registry = new CollectionRegistry(dataDir);
      registry.record({
        collectionName: "code_tracked",
        path: realPath,
        embeddingModel: "jina",
        embeddingDimensions: 384,
        qdrantUrl: "http://qdrant:6333",
        embeddingBaseUrl: "http://gpu-server:11434",
        embeddingFallbackUrl: "http://127.0.0.1:11434",
        indexedAt: "2026-05-01T00:00:00Z",
        teaRagsVersion: "1.0.0",
        chunksCount: 5,
      });
      registry.setName("code_tracked", "tracked");

      // Capture process.env state AT parseAppConfig invocation time — this
      // is the ordering invariant we care about.
      let envAtParseTime: { base: string | undefined; fallback: string | undefined } | undefined;
      parseAppConfigMock.mockImplementation(() => {
        envAtParseTime = {
          base: process.env.EMBEDDING_BASE_URL,
          fallback: process.env.EMBEDDING_FALLBACK_URL,
        };
        return { embedding: {} };
      });
      wireApp();

      await runPrime({ project: "tracked" });

      expect(envAtParseTime).toBeDefined();
      expect(envAtParseTime?.base).toBe("http://gpu-server:11434");
      expect(envAtParseTime?.fallback).toBe("http://127.0.0.1:11434");
    } finally {
      rmSync(realPath, { recursive: true, force: true });
    }
  });

  it("leaves EMBEDDING_BASE_URL untouched when the registry entry has no embeddingBaseUrl (legacy entry)", async () => {
    // Pre-fix entries had no embedding URL fields. runPrime must NOT
    // overwrite process.env in that case — it falls back to whatever the
    // current shell already exposed (or undefined, letting factory default
    // apply).
    const realPath = mkdtempSync(join(tmpdir(), "rp-leg-"));
    try {
      // Simulate the operator's shell having ITS OWN EMBEDDING_BASE_URL.
      process.env.EMBEDDING_BASE_URL = "http://from-env:11434";

      const registry = new CollectionRegistry(dataDir);
      registry.record({
        collectionName: "code_legacy",
        path: realPath,
        embeddingModel: "jina",
        embeddingDimensions: 384,
        qdrantUrl: "http://qdrant:6333",
        indexedAt: "2026-05-01T00:00:00Z",
        teaRagsVersion: "1.0.0",
        chunksCount: 5,
      });
      registry.setName("code_legacy", "legacy");

      let envAtParseTime: { base: string | undefined; fallback: string | undefined } | undefined;
      parseAppConfigMock.mockImplementation(() => {
        envAtParseTime = {
          base: process.env.EMBEDDING_BASE_URL,
          fallback: process.env.EMBEDDING_FALLBACK_URL,
        };
        return { embedding: { baseUrl: "http://from-env:11434" } };
      });
      wireApp();

      await runPrime({ project: "legacy" });

      // Env preserved — registry entry contributed nothing to override.
      expect(envAtParseTime?.base).toBe("http://from-env:11434");
      expect(envAtParseTime?.fallback).toBeUndefined();
    } finally {
      rmSync(realPath, { recursive: true, force: true });
    }
  });
});
