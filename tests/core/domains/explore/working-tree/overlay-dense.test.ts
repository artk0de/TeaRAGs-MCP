/**
 * `WorkingTreeOverlay#view` and the dense floor (bd tea-rags-mcp-xi2r9, WTO-5):
 * a view of a tree that changed files starts warming its delta rows' vectors
 * when it is made — fire and forget — and hands ranked readers the warm-up's
 * reader. A clean tree warms nothing and offers no reader. Git is real.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import {
  createWorkingTreeChunkLayer,
  createWorkingTreeDeltaReader,
  WorkingTreeOverlay,
  type WorkingTreeDenseVectorRequest,
  type WorkingTreeDenseVectors,
} from "../../../../../src/core/domains/explore/working-tree/index.js";
import { FileScanner } from "../../../../../src/core/domains/ingest/pipeline/scanner.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const COLLECTION = "code_overlay_dense";

describe("WorkingTreeOverlay dense warm-up", { timeout: 60_000 }, () => {
  let fixture: GitWorkingTreeFixture;
  let registryDir: string;
  let registry: CollectionRegistry;
  let tree: string;

  const createFileFilter = async (root: string) => {
    const scanner = new FileScanner({ supportedExtensions: [".ts"], ignorePatterns: [] });
    await scanner.loadIgnorePatterns(root);
    return (relativePath: string) => scanner.accepts(relativePath);
  };

  const layer = () =>
    createWorkingTreeChunkLayer({
      createPool: () => ({ shutdown: async () => undefined }),
      chunkFile: async (_pool, file): Promise<ScrollChunk[]> => [
        { id: `row:${file.relativePath}`, payload: { relativePath: file.relativePath, content: file.code } },
      ],
    });

  const READ: WorkingTreeDenseVectors = { vectors: new Map([["row:src/keep.ts", [1, 0]]]), pending: 0 };

  const overlay = (warm = vi.fn((_request: WorkingTreeDenseVectorRequest) => async () => READ)) => ({
    warm,
    overlay: new WorkingTreeOverlay({
      registry,
      deltaReader: createWorkingTreeDeltaReader(),
      createFileFilter,
      deltaChunks: { layer: layer(), resolveChunkerConfig: async () => ({ chunkSize: 100, chunkOverlap: 0 }) },
      denseVectors: { warm },
      touchedBasePoints: { pointsOf: async () => new Map() },
    }),
  });

  const view = async (o: WorkingTreeOverlay) =>
    o.view({ root: tree, baseIndex: { collectionName: COLLECTION, root: fixture.mainRoot } }, "proj");

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture([
      { commit: { "src/keep.ts": "export const keep = 1;\n" }, message: "A" },
      { addWorktree: "feature" },
    ]);
    const [indexedCommit] = fixture.seeded.commits;
    tree = fixture.seeded.worktrees.feature;
    registryDir = mkdtempSync(join(tmpdir(), "wto-dense-registry-"));
    registry = new CollectionRegistry(registryDir);
    registry.record({
      collectionName: COLLECTION,
      path: fixture.mainRoot,
      embeddingModel: "m",
      embeddingDimensions: 2,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
      git: { indexedBranch: "main", indexedCommit, indexedDirty: false },
    });
  });

  afterEach(() => {
    fixture.cleanup();
    rmSync(registryDir, { recursive: true, force: true });
  });

  it("starts warming the changed files' rows when the view is made, before anyone reads", async () => {
    writeFileSync(join(tree, "src/keep.ts"), "export const keep = 2;\n");
    const { overlay: o, warm } = overlay();

    const made = await view(o);
    await vi.waitFor(() => {
      expect(warm).toHaveBeenCalledTimes(1);
    });

    const request = warm.mock.calls[0][0];
    expect(request.collectionName).toBe(COLLECTION);
    expect(request.rows.map((row) => row.id)).toEqual(["row:src/keep.ts"]);
    expect(request.readTouchedBasePoints).toBe(made.readTouchedBasePoints);
    expect(made.marker.floors).toEqual([]);
    expect(await made.readDeltaVectors?.(2_000)).toBe(READ);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("warms nothing and offers no reader on a clean tree", async () => {
    const { overlay: o, warm } = overlay();

    const made = await view(o);

    expect(made.readDeltaVectors).toBeUndefined();
    expect(warm).not.toHaveBeenCalled();
  });

  it("answers no vectors, without throwing, when the delta rows cannot be read", async () => {
    writeFileSync(join(tree, "src/keep.ts"), "export const keep = 2;\n");
    const o = new WorkingTreeOverlay({
      registry,
      deltaReader: createWorkingTreeDeltaReader(),
      createFileFilter,
      deltaChunks: {
        layer: layer(),
        resolveChunkerConfig: async () => Promise.reject(new Error("no chunker config")),
      },
      denseVectors: { warm: vi.fn() },
    });

    const made = await view(o);

    await expect(made.readDeltaVectors?.(2_000)).resolves.toEqual({
      vectors: new Map(),
      pending: 0,
      failure: "no chunker config",
    });
  });
});
