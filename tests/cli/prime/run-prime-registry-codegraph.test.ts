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

describe("runPrime — registry-first codegraph enablement override", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "run-prime-cg-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    delete process.env.CODEGRAPH_ENABLED;
    writeMock.mockClear();
    pingMock.mockReset();
    createAppContextMock.mockReset();
    parseAppConfigMock.mockReset();
    process.stdout.write = writeMock as unknown as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = stdoutOriginal;
    delete process.env.TEA_RAGS_DATA_DIR;
    delete process.env.CODEGRAPH_ENABLED;
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

  it("sets CODEGRAPH_ENABLED env BEFORE parseAppConfig fires when the registry entry was indexed with codegraph", async () => {
    // Registry-first symmetry with embeddingBaseUrl: the codegraph trajectory
    // family is gated by CODEGRAPH_ENABLED, read from env at parseAppConfig
    // time. The MCP server indexes WITH codegraph (its mcpServers.env carries
    // the flag), so the index payload holds codegraph signals — but the prime
    // hook runs in a fresh shell WITHOUT the flag, so without this override the
    // composition omits codegraph descriptors and prime falsely reports the
    // codegraph signal fields as "removed" schema drift.
    const realPath = mkdtempSync(join(tmpdir(), "rp-cg-proj-"));
    try {
      const registry = new CollectionRegistry(dataDir);
      registry.record({
        collectionName: "code_cg",
        path: realPath,
        embeddingModel: "jina",
        embeddingDimensions: 384,
        qdrantUrl: "http://qdrant:6333",
        codegraphEnabled: true,
        indexedAt: "2026-05-01T00:00:00Z",
        teaRagsVersion: "1.0.0",
        chunksCount: 5,
      });
      registry.setName("code_cg", "cg");

      let envAtParseTime: string | undefined;
      parseAppConfigMock.mockImplementation(() => {
        envAtParseTime = process.env.CODEGRAPH_ENABLED;
        return {};
      });
      wireApp();

      await runPrime({ project: "cg" });

      expect(envAtParseTime).toBe("true");
    } finally {
      rmSync(realPath, { recursive: true, force: true });
    }
  });

  it("leaves CODEGRAPH_ENABLED untouched when the registry entry has no codegraphEnabled (legacy entry)", async () => {
    // Pre-fix entries had no codegraphEnabled field. runPrime must NOT force
    // the flag on — it falls back to whatever the current shell exposes.
    const realPath = mkdtempSync(join(tmpdir(), "rp-cg-leg-"));
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

      let envAtParseTime: string | undefined;
      parseAppConfigMock.mockImplementation(() => {
        envAtParseTime = process.env.CODEGRAPH_ENABLED;
        return {};
      });
      wireApp();

      await runPrime({ project: "legacy" });

      expect(envAtParseTime).toBeUndefined();
    } finally {
      rmSync(realPath, { recursive: true, force: true });
    }
  });
});
