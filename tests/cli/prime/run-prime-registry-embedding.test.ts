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
    writeMock.mockClear();
    pingMock.mockReset();
    createAppContextMock.mockReset();
    parseAppConfigMock.mockReset();
    process.stdout.write = writeMock as unknown as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = stdoutOriginal;
    delete process.env.TEA_RAGS_DATA_DIR;
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

  it("overrides config.embedding.{baseUrl,fallbackBaseUrl} from registry entry when running runPrime by project alias", async () => {
    // Registry-first symmetry: prime must read embedding endpoints from the
    // registry entry that the project was indexed against, not re-derive
    // from the current shell's env. Without this, an EMBEDDING_BASE_URL set
    // at index time is lost when prime runs in a fresh shell, and the
    // digest falsely reports localhost:11434 (the 2026-05-28 symptom).
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

      parseAppConfigMock.mockReturnValue({ embedding: {} });
      wireApp();

      await runPrime({ project: "tracked" });

      expect(createAppContextMock).toHaveBeenCalledTimes(1);
      const passedConfig = createAppContextMock.mock.calls[0][0] as {
        embedding: { baseUrl?: string; fallbackBaseUrl?: string };
      };
      expect(passedConfig.embedding.baseUrl).toBe("http://gpu-server:11434");
      expect(passedConfig.embedding.fallbackBaseUrl).toBe("http://127.0.0.1:11434");
    } finally {
      rmSync(realPath, { recursive: true, force: true });
    }
  });

  it("leaves config.embedding untouched when the registry entry has no embeddingBaseUrl (legacy entry)", async () => {
    // Pre-fix entries had no embedding URL fields. runPrime must NOT
    // overwrite the env-derived config in that case — it falls back to
    // whatever parseAppConfig produced (current shell env).
    const realPath = mkdtempSync(join(tmpdir(), "rp-leg-"));
    try {
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

      // Env-derived config the shell happens to provide.
      parseAppConfigMock.mockReturnValue({
        embedding: { baseUrl: "http://from-env:11434" },
      });
      wireApp();

      await runPrime({ project: "legacy" });

      const passedConfig = createAppContextMock.mock.calls[0][0] as {
        embedding: { baseUrl?: string; fallbackBaseUrl?: string };
      };
      // Unchanged — env value preserved.
      expect(passedConfig.embedding.baseUrl).toBe("http://from-env:11434");
      expect(passedConfig.embedding.fallbackBaseUrl).toBeUndefined();
    } finally {
      rmSync(realPath, { recursive: true, force: true });
    }
  });
});
