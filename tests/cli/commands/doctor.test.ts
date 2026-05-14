import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

describe("CLI 'doctor' command", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-doc-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".keep"), "");
    process.env.TEA_RAGS_DATA_DIR = dir;
  });

  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints [OK] for reachable Qdrant + embedding", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const fakeQdrant = {
        url: "http://localhost:6333",
        checkHealth: vi.fn().mockResolvedValue(true),
        listCollections: vi.fn().mockResolvedValue([]),
      };
      const fakeEmbeddings = {
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: () => "ollama",
        getBaseUrl: () => "http://localhost:11434",
      };
      const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runDoctor(
        { json: false, recoverRegistry: false },
        {
          qdrant: fakeQdrant as never,
          embeddings: fakeEmbeddings as never,
        },
      );
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toMatch(/\[OK\].*Qdrant/);
      expect(out).toMatch(/\[OK\].*ollama/);
      expect(out).toContain("http://localhost:6333");
      expect(out).toContain("http://localhost:11434");
    } finally {
      stdout.mockRestore();
    }
  });

  it("prints [FAIL] when Qdrant checkHealth resolves false", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const fakeQdrant = {
        url: "http://localhost:6333",
        checkHealth: vi.fn().mockResolvedValue(false),
        listCollections: vi.fn().mockResolvedValue([]),
      };
      const fakeEmbeddings = {
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: () => "ollama",
      };
      const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runDoctor(
        { json: false, recoverRegistry: false },
        {
          qdrant: fakeQdrant as never,
          embeddings: fakeEmbeddings as never,
        },
      );
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toMatch(/\[FAIL\].*Qdrant/);
    } finally {
      stdout.mockRestore();
    }
  });

  it("reports orphan count and points at --recover-registry when there are orphans", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      // Empty registry — every Qdrant collection is an orphan.
      const fakeQdrant = {
        url: "http://localhost:6333",
        checkHealth: vi.fn().mockResolvedValue(true),
        listCollections: vi.fn().mockResolvedValue(["code_a", "code_b"]),
      };
      const fakeEmbeddings = {
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: () => "ollama",
      };
      const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runDoctor(
        { json: false, recoverRegistry: false },
        {
          qdrant: fakeQdrant as never,
          embeddings: fakeEmbeddings as never,
        },
      );
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toMatch(/\[WARN\].*2.*orphan/i);
      expect(out).toContain("--recover-registry");
    } finally {
      stdout.mockRestore();
    }
  });

  it("treats throwing checkHealth as [FAIL] (safe-wrapper catches)", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const fakeQdrant = {
        url: "http://localhost:6333",
        checkHealth: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        listCollections: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      };
      const fakeEmbeddings = {
        checkHealth: vi.fn().mockRejectedValue(new Error("boom")),
        getProviderName: () => "ollama",
      };
      const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runDoctor(
        { json: false, recoverRegistry: false },
        {
          qdrant: fakeQdrant as never,
          embeddings: fakeEmbeddings as never,
        },
      );
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toMatch(/\[FAIL\].*Qdrant/);
      expect(out).toMatch(/\[FAIL\].*ollama/);
    } finally {
      stdout.mockRestore();
    }
  });

  it("--json emits structured object", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const fakeQdrant = {
        url: "http://localhost:6333",
        checkHealth: vi.fn().mockResolvedValue(true),
        listCollections: vi.fn().mockResolvedValue([]),
      };
      const fakeEmbeddings = {
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: () => "ollama",
      };
      const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runDoctor(
        { json: true, recoverRegistry: false },
        {
          qdrant: fakeQdrant as never,
          embeddings: fakeEmbeddings as never,
        },
      );
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out.trim());
      expect(parsed.qdrant.reachable).toBe(true);
      expect(parsed.embeddings.reachable).toBe(true);
      expect(parsed.registry.projectCount).toBe(0);
      expect(parsed.registry.orphanCount).toBe(0);
    } finally {
      stdout.mockRestore();
    }
  });

  /**
   * Exercise the yargs builder + handler + defaultDeps dynamic-import path
   * end-to-end. Mocks the bootstrap modules so parseAppConfig + resolveQdrantUrl
   * + EmbeddingProviderFactory don't touch the real environment.
   */
  it("doctorCommand yargs handler wires defaultDeps via bootstrap modules", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as (code?: number) => never);

    vi.doMock("../../../src/bootstrap/config/index.js", () => ({
      parseAppConfig: () => ({
        qdrantUrl: "http://stub",
        qdrantApiKey: undefined,
        paths: {
          appData: "/tmp/x",
          models: "/tmp/x/models",
          daemonSocket: "/tmp/x/sock",
          daemonPid: "/tmp/x/pid",
        },
      }),
      getZodConfig: () => ({
        embedding: {
          provider: "ollama",
          model: "stub",
          dimensions: 1,
          baseUrl: "http://stub-ollama",
          tune: { maxRequestsPerMinute: 60, retryAttempts: 1, retryDelayMs: 10 },
          ollamaLegacyApi: false,
          ollamaNumGpu: undefined,
          fallbackBaseUrl: undefined,
        },
      }),
    }));
    vi.doMock("../../../src/core/adapters/qdrant/embedded/daemon.js", () => ({
      resolveQdrantUrl: async () => ({ mode: "external", url: "http://stub" }),
    }));
    vi.doMock("../../../src/core/adapters/qdrant/client.js", () => ({
      QdrantManager: class {
        url = "http://stub";
        checkHealth = vi.fn().mockResolvedValue(true);
        listCollections = vi.fn().mockResolvedValue([]);
      },
    }));
    vi.doMock("../../../src/core/adapters/embeddings/factory.js", () => ({
      EmbeddingProviderFactory: {
        create: () => ({
          checkHealth: vi.fn().mockResolvedValue(true),
          getProviderName: () => "ollama",
          getBaseUrl: () => "http://stub-ollama",
        }),
      },
    }));

    try {
      vi.resetModules();
      const { doctorCommand } = await import("../../../src/cli/commands/doctor.js");
      const cli = yargs([])
        .command(doctorCommand)
        .exitProcess(false)
        .fail((msg, err) => {
          throw err ?? new Error(msg);
        });
      await cli.parseAsync(["doctor"]);
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toMatch(/\[OK\].*Qdrant.*http:\/\/stub/);
      expect(out).toMatch(/\[OK\].*ollama.*http:\/\/stub-ollama/);
    } finally {
      vi.doUnmock("../../../src/bootstrap/config/index.js");
      vi.doUnmock("../../../src/core/adapters/qdrant/embedded/daemon.js");
      vi.doUnmock("../../../src/core/adapters/qdrant/client.js");
      vi.doUnmock("../../../src/core/adapters/embeddings/factory.js");
      vi.resetModules();
      stdout.mockRestore();
      stderr.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("yargs handler passes --recover-registry through (flag accepted, ignored in T5)", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as (code?: number) => never);

    vi.doMock("../../../src/bootstrap/config/index.js", () => ({
      parseAppConfig: () => ({
        qdrantUrl: "http://stub",
        qdrantApiKey: undefined,
        paths: {
          appData: "/tmp/x",
          models: "/tmp/x/models",
          daemonSocket: "/tmp/x/sock",
          daemonPid: "/tmp/x/pid",
        },
      }),
      getZodConfig: () => ({
        embedding: {
          provider: "ollama",
          model: "stub",
          dimensions: 1,
          baseUrl: "http://stub-ollama",
          tune: { maxRequestsPerMinute: 60, retryAttempts: 1, retryDelayMs: 10 },
          ollamaLegacyApi: false,
          ollamaNumGpu: undefined,
          fallbackBaseUrl: undefined,
        },
      }),
    }));
    vi.doMock("../../../src/core/adapters/qdrant/embedded/daemon.js", () => ({
      resolveQdrantUrl: async () => ({ mode: "external", url: "http://stub" }),
    }));
    vi.doMock("../../../src/core/adapters/qdrant/client.js", () => ({
      QdrantManager: class {
        url = "http://stub";
        checkHealth = vi.fn().mockResolvedValue(true);
        listCollections = vi.fn().mockResolvedValue([]);
      },
    }));
    vi.doMock("../../../src/core/adapters/embeddings/factory.js", () => ({
      EmbeddingProviderFactory: {
        create: () => ({
          checkHealth: vi.fn().mockResolvedValue(true),
          getProviderName: () => "ollama",
        }),
      },
    }));

    try {
      vi.resetModules();
      const { doctorCommand } = await import("../../../src/cli/commands/doctor.js");
      const cli = yargs([])
        .command(doctorCommand)
        .exitProcess(false)
        .fail((msg, err) => {
          throw err ?? new Error(msg);
        });
      // --json + --recover-registry: T5 accepts the flag silently.
      await cli.parseAsync(["doctor", "--json", "--recover-registry"]);
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out.trim());
      expect(parsed.qdrant.reachable).toBe(true);
    } finally {
      vi.doUnmock("../../../src/bootstrap/config/index.js");
      vi.doUnmock("../../../src/core/adapters/qdrant/embedded/daemon.js");
      vi.doUnmock("../../../src/core/adapters/qdrant/client.js");
      vi.doUnmock("../../../src/core/adapters/embeddings/factory.js");
      vi.resetModules();
      stdout.mockRestore();
      stderr.mockRestore();
      exitSpy.mockRestore();
    }
  });

  describe("--recover-registry (audit #6, #7)", () => {
    it("calls ProjectRegistryOps.recoverFromQdrant and reports the result", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        // Empty registry; Qdrant has two collections.
        const fakeQdrant = {
          url: "http://localhost:6333",
          checkHealth: vi.fn().mockResolvedValue(true),
          listCollections: vi.fn().mockResolvedValue(["code_a", "code_b"]),
          countPoints: vi.fn().mockResolvedValue(0),
          getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384 }),
          scrollFiltered: vi.fn().mockResolvedValue([]),
        };
        const fakeEmbeddings = {
          checkHealth: vi.fn().mockResolvedValue(true),
          getProviderName: () => "ollama",
        };
        const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
        await runDoctor(
          { json: false, recoverRegistry: true },
          {
            qdrant: fakeQdrant as never,
            embeddings: fakeEmbeddings as never,
          },
        );

        // Verify recovery actually wrote registry entries.
        const reg = new CollectionRegistry(dir);
        const names = reg
          .list()
          .map((e) => e.collectionName)
          .sort();
        expect(names).toEqual(["code_a", "code_b"]);

        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out.toLowerCase()).toContain("recovered");
        expect(out).toContain("re-register");
      } finally {
        stdout.mockRestore();
      }
    });

    it("--json includes a `recovery` block when --recover-registry is set", async () => {
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        const fakeQdrant = {
          url: "http://localhost:6333",
          checkHealth: vi.fn().mockResolvedValue(true),
          listCollections: vi.fn().mockResolvedValue(["code_a"]),
          countPoints: vi.fn().mockResolvedValue(0),
          getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384 }),
          scrollFiltered: vi.fn().mockResolvedValue([]),
        };
        const fakeEmbeddings = {
          checkHealth: vi.fn().mockResolvedValue(true),
          getProviderName: () => "ollama",
        };
        const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
        await runDoctor(
          { json: true, recoverRegistry: true },
          {
            qdrant: fakeQdrant as never,
            embeddings: fakeEmbeddings as never,
          },
        );
        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        const parsed = JSON.parse(out.trim());
        expect(parsed.recovery).toBeDefined();
        expect(parsed.recovery.recovered).toBe(1);
      } finally {
        stdout.mockRestore();
      }
    });
  });
});
