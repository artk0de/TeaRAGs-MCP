/**
 * bd tea-rags-mcp-39xca.12 — the registry's chunksCount counts real chunks.
 *
 * Every code collection carries two service points besides its chunks: the
 * indexing marker and the schema metadata point. `get_index_status` and
 * `get_index_metrics` leave both out; a registry entry that counted them would
 * report two more chunks than the index it describes, and `prime` renders that
 * number next to theirs.
 *
 * In-memory Qdrant that honours `must_not`, so the count reflects the filter the
 * writer actually sends rather than a number the fake was told to return.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectRegistryOps } from "../../../../../src/core/api/internal/ops/project-registry-ops.js";
import { INDEXING_METADATA_ID } from "../../../../../src/core/contracts/constants.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";
import { resolveCollectionName, validatePath } from "../../../../../src/core/infra/collection-name.js";
import { MockQdrantManager } from "../../../domains/ingest/__helpers__/test-helpers.js";

const CHUNK_COUNT = 3;

describe("ProjectRegistryOps — chunksCount counts real chunks only", () => {
  let dir: string;
  let repoPath: string;
  let registry: CollectionRegistry;
  let qdrant: MockQdrantManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pro-chunks-"));
    repoPath = join(dir, "repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, ".keep"), "");
    registry = new CollectionRegistry(join(dir, "registry"));
    qdrant = new MockQdrantManager();
    Object.defineProperty(qdrant, "url", { value: "http://localhost:6333", configurable: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** CHUNK_COUNT chunks plus the indexing marker and the schema metadata point. */
  async function seedCollection(collectionName: string): Promise<void> {
    const now = new Date().toISOString();
    await qdrant.createCollection(collectionName, 384, "Cosine", false);
    await qdrant.addPoints(collectionName, [
      {
        id: INDEXING_METADATA_ID,
        vector: new Array(384).fill(0),
        payload: { _type: "indexing_metadata", indexingComplete: true, indexedAt: now, embeddingModel: "mock-model" },
      },
      {
        id: "__schema_metadata__",
        vector: new Array(384).fill(0),
        payload: { _type: "schema_metadata", schemaVersion: 14, indexes: [], migratedAt: now },
      },
      ...Array.from({ length: CHUNK_COUNT }, (_, i) => ({
        id: `chunk-${i}`,
        vector: new Array(384).fill(0.1),
        payload: { relativePath: `src/file${i}.ts` },
      })),
    ]);
  }

  it("register() records the chunk count of an already-indexed collection", async () => {
    const collectionName = resolveCollectionName(await validatePath(repoPath));
    await seedCollection(collectionName);
    const ops = new ProjectRegistryOps({ registry, qdrant: qdrant as never });

    await ops.register({ path: repoPath, name: "alpha" });

    expect(registry.get(collectionName)?.chunksCount).toBe(CHUNK_COUNT);
  });

  it("recoverFromQdrant() records the chunk count of each recovered collection", async () => {
    await seedCollection("code_recovered");
    const ops = new ProjectRegistryOps({ registry, qdrant: qdrant as never });

    await ops.recoverFromQdrant();

    expect(registry.get("code_recovered")?.chunksCount).toBe(CHUNK_COUNT);
  });
});
