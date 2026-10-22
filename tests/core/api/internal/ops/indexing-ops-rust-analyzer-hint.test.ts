/**
 * An index run reports the rust-analyzer install hint once, on its stats, when
 * the freshly written stats cache says the index holds Rust and the injected
 * lookup finds no binary (bd s3i8m.6). The hint is advice about an optional
 * binary: it never fails or alters the run, whatever the lookup does.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RustAnalyzerInstallHintLookup } from "../../../../../src/core/adapters/rust-analyzer/index.js";
import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import { CollectionIndexingLock } from "../../../../../src/core/domains/ingest/infra/collection-indexing-lock.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const HINT = "rust-analyzer not found — install with 'rustup component add rust-analyzer'";

const changeStats: ChangeStats = {
  filesAdded: 1,
  filesModified: 0,
  filesDeleted: 0,
  filesNewlyIgnored: 0,
  filesNewlyUnignored: 0,
  filesRetried: 0,
  chunksAdded: 3,
  chunksDeleted: 0,
  durationMs: 5,
  status: "completed",
};

describe("IndexingOps — rust-analyzer install hint on the run stats", () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), "indexing-ops-ra-hint-"));
  });

  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  function makeDeps(
    languages: Record<string, number> | null,
    rustAnalyzerInstallHint: RustAnalyzerInstallHintLookup | undefined,
  ): IndexingOpsDeps {
    return {
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(true),
        aliases: { listAliases: vi.fn().mockResolvedValue([]) },
        listCollections: vi.fn().mockResolvedValue([]),
        getPoint: vi.fn().mockResolvedValue(null),
        getPointOrThrow: vi.fn().mockResolvedValue(null),
      } as never,
      embeddings: {
        embed: vi.fn().mockResolvedValue([0]),
        resolveModelInfo: vi.fn().mockResolvedValue(undefined),
      } as never,
      config: { chunkSize: 1000, userSetChunkSize: false } as never,
      indexing: { indexCodebase: vi.fn() } as never,
      reindex: { reindexChanges: vi.fn().mockResolvedValue(changeStats) } as never,
      enrichment: {
        setEnrichmentProgress: vi.fn(),
        whenComplete: vi.fn().mockResolvedValue(undefined),
        whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
        runRecovery: vi.fn().mockResolvedValue(undefined),
        recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
      } as never,
      snapshotDir: lockDir,
      indexingLock: new CollectionIndexingLock({ lockDir }),
      languageVersionStamper: { stampLanguageVersions: vi.fn() },
      codegraphEnabledStamper: { stampCodegraphEnabled: vi.fn() },
      statsCache: {
        load: vi.fn().mockReturnValue(languages ? { distributions: { language: languages } } : null),
      } as never,
      ...(rustAnalyzerInstallHint ? { rustAnalyzerInstallHint } : {}),
    };
  }

  it("carries the hint when Rust is indexed and the lookup answers one", async () => {
    const lookup = vi.fn().mockReturnValue(HINT);
    const stats = await new IndexingOps(makeDeps({ rust: 90, toml: 10 }, lookup)).run("/repo");

    expect(stats.rustAnalyzerHint).toBe(HINT);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith({ path: "/repo", languages: ["rust", "toml"] });
  });

  it("carries no hint when the lookup answers null (binary found, no Rust, slot off)", async () => {
    const stats = await new IndexingOps(makeDeps({ rust: 100 }, vi.fn().mockReturnValue(null))).run("/repo");

    expect(stats.rustAnalyzerHint).toBeUndefined();
  });

  it("carries no hint when no lookup is wired", async () => {
    const stats = await new IndexingOps(makeDeps({ rust: 100 }, undefined)).run("/repo");

    expect(stats.rustAnalyzerHint).toBeUndefined();
  });

  it("carries no hint, and does not consult the lookup, when no stats are cached", async () => {
    const lookup = vi.fn().mockReturnValue(HINT);
    const stats = await new IndexingOps(makeDeps(null, lookup)).run("/repo");

    expect(stats.rustAnalyzerHint).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("still completes the run when the lookup throws", async () => {
    const lookup = vi.fn().mockImplementation(() => {
      throw new Error("probe exploded");
    });
    const stats = await new IndexingOps(makeDeps({ rust: 100 }, lookup)).run("/repo");

    expect(stats.status).toBe("completed");
    expect(stats.rustAnalyzerHint).toBeUndefined();
  });

  it("still completes the run when the stats cache read throws", async () => {
    const deps = makeDeps({ rust: 100 }, vi.fn().mockReturnValue(HINT));
    (deps.statsCache as unknown as { load: ReturnType<typeof vi.fn> }).load.mockImplementation(() => {
      throw new Error("stats cache unreadable");
    });
    const stats = await new IndexingOps(deps).run("/repo");

    expect(stats.status).toBe("completed");
    expect(stats.rustAnalyzerHint).toBeUndefined();
  });
});
