/**
 * IndexingOps#clear drops the codegraph database of EVERY generation
 * (bd tea-rags-mcp-39xca.1).
 *
 * `StatusModule#clearIndex` deletes the alias, the collection it points at and
 * every `<name>_v<N>` Qdrant collection. The codegraph side used to remove
 * `<name>.duckdb` alone — the alias-named file, which for a versioned collection
 * is at most a shadow — so each generation's database outlived the index it
 * described, and a later index that reclaimed the same version number opened
 * it with the old graph still inside.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";

const COLLECTION = "code_clear";

describe("IndexingOps — clear removes every codegraph generation (39xca.1)", () => {
  let snapshotDir: string;

  beforeEach(() => {
    snapshotDir = mkdtempSync(join(tmpdir(), "indexing-ops-clear-"));
  });

  afterEach(() => {
    rmSync(snapshotDir, { recursive: true, force: true });
  });

  function makeOps(events: string[]): IndexingOps {
    const deps: IndexingOpsDeps = {
      qdrant: {
        collectionExists: vi.fn(async () => {
          events.push("qdrant-cleared");
          return false;
        }),
        aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      } as never,
      embeddings: { embed: vi.fn(), resolveModelInfo: vi.fn() } as never,
      config: { chunkSize: 1000, userSetChunkSize: false } as never,
      indexing: { indexCodebase: vi.fn() } as never,
      reindex: { reindexChanges: vi.fn() } as never,
      enrichment: { setEnrichmentProgress: vi.fn(), whenCompletionsSettled: vi.fn() } as never,
      snapshotDir,
      resolveCollectionForPath: async () => COLLECTION,
      codegraphPool: {
        // Answers only for the collection being cleared, so removing the
        // databases of any other base name cannot pass.
        listCollectionDbNames: (base: string) =>
          base === COLLECTION ? ["code_clear", "code_clear_v1", "code_clear_v3"] : [],
        removeCollection: async (name: string) => {
          events.push(`codegraph-removed:${name}`);
          return true;
        },
      } as never,
    };
    return new IndexingOps(deps);
  }

  it("removes the database of each generation on disk, not only the alias-named file", async () => {
    const events: string[] = [];

    await makeOps(events).clear(process.cwd());

    const removed = events.filter((e) => e.startsWith("codegraph-removed:")).map((e) => e.split(":")[1]);
    expect(removed.sort()).toEqual(["code_clear", "code_clear_v1", "code_clear_v3"]);
  });

  it("removes the codegraph databases only after Qdrant has been cleared", async () => {
    const events: string[] = [];

    await makeOps(events).clear(process.cwd());

    expect(events[0]).toBe("qdrant-cleared");
    expect(events.slice(1).every((e) => e.startsWith("codegraph-removed:"))).toBe(true);
  });
});
