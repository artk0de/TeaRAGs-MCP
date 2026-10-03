/**
 * The sparse floor's per-query cost (bd tea-rags-mcp-xi2r9, live probe P2-6):
 * with 159 touched files hybrid_search took 365 ms against semantic_search's
 * 40 ms. Two parts of it grew with the delta:
 *
 * - the BM25 vector of every delta row was recomputed on every query — it is
 *   now computed once per row;
 * - the exclusion of touched files was a 159-branch `should` of text+value
 *   pairs evaluated per candidate (131–280 ms on the live self-index; a bare
 *   `match.any` is no better on the text-indexed `relativePath`, 207–311 ms).
 *   It is now a `has_id` exclusion of the touched files' base point ids
 *   (5–8 ms), the ids read by `WorkingTreeTouchedBasePoints` (its own spec).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as sparse from "../../../../../src/core/adapters/qdrant/sparse.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import {
  excludeWorkingTreeBaseIds,
  scoreWorkingTreeRows,
} from "../../../../../src/core/domains/explore/working-tree/sparse-floor.js";

vi.mock("../../../../../src/core/adapters/qdrant/sparse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof sparse>();
  return { ...actual, generateSparseVector: vi.fn(actual.generateSparseVector) };
});

const row = (id: string, content: string, relativePath = "src/a.ts"): ScrollChunk => ({
  id,
  payload: { relativePath, content, language: "typescript" },
});

describe("scoreWorkingTreeRows — one BM25 vector per row", () => {
  afterEach(() => {
    vi.mocked(sparse.generateSparseVector).mockClear();
  });

  it("should vectorize each row once across queries", () => {
    const rows = [row("t1", "export function freshHelper() {}"), row("t2", "const other = 1;")];
    const scoring = (query: string) => ({ querySparse: sparse.generateSparseVector(query), legLimit: 10 });

    const first = scoreWorkingTreeRows(rows, scoring("freshHelper"));
    const second = scoreWorkingTreeRows(rows, scoring("other"));

    expect(first.map((r) => r.id)).toEqual(["t1"]);
    expect(second.map((r) => r.id)).toEqual(["t2"]);
    // two query vectors + two row vectors — the rows were not re-vectorized for the second query
    expect(sparse.generateSparseVector).toHaveBeenCalledTimes(4);
  });

  it("should re-vectorize a row whose content changed", () => {
    const edited = row("t1", "export function freshHelper() {}");
    scoreWorkingTreeRows([edited], { querySparse: sparse.generateSparseVector("freshHelper"), legLimit: 10 });
    edited.payload.content = "export function renamedHelper() {}";

    const scored = scoreWorkingTreeRows([edited], {
      querySparse: sparse.generateSparseVector("renamedHelper"),
      legLimit: 10,
    });

    expect(scored.map((r) => r.id)).toEqual(["t1"]);
  });
});

/**
 * A one-shot CLI process (WTO unbounded delta): every call is a new process,
 * so the per-row cache above never reaches the next call — 674 delta files
 * cost ~190 ms of BM25 vectorizing per hybrid_search. The vectors are stored
 * beside the rows they belong to, so a process that reads a stored entry
 * vectorizes nothing. A "new process" here is a fresh module graph
 * (`vi.resetModules`): none of the previous one's module state survives.
 */
describe("BM25 vectors of stored rows", () => {
  const COLLECTION = "code_sparse";
  const CONFIG = { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 2500 };
  const FILES: Record<string, string> = {
    "src/a.ts": "export function storedSparseHelper(): number { return 1; }\n",
    "src/b.ts": "let otherThing = 2;\n",
  };
  let scratch: string;
  let tree: string;
  let rootDir: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "wt-sparse-floor-"));
    tree = join(scratch, "tree");
    rootDir = join(scratch, "working-tree");
    for (const [relativePath, content] of Object.entries(FILES)) {
      mkdirSync(dirname(join(tree, relativePath)), { recursive: true });
      writeFileSync(join(tree, relativePath), content);
    }
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A fresh module graph: what a new process would load. */
  const newProcess = async () => {
    vi.resetModules();
    const bm25 = await import("../../../../../src/core/adapters/qdrant/sparse.js");
    const floor = await import("../../../../../src/core/domains/explore/working-tree/sparse-floor.js");
    const workingTree = await import("../../../../../src/core/domains/explore/working-tree/index.js");
    return { bm25, floor, workingTree };
  };

  /** One row per file, its content the file's code — as ingest's chunk payload carries it. */
  const chunkFile = async (_pool: unknown, file: { relativePath: string; code: string }): Promise<ScrollChunk[]> => [
    { id: `id:${file.relativePath}`, payload: { relativePath: file.relativePath, content: file.code } },
  ];

  /** Chunk the delta through a layer over the shared store dir and score it; counts row vectorizations. */
  const scoreInNewProcess = async () => {
    const { bm25, floor, workingTree } = await newProcess();
    const querySparse = bm25.generateSparseVector("storedSparseHelper");
    const vectorize = vi.mocked(bm25.generateSparseVector);
    vectorize.mockClear();
    const layer = workingTree.createWorkingTreeChunkLayer({
      createPool: () => ({ shutdown: async () => undefined }),
      chunkFile,
      store: workingTree.createWorkingTreeChunkStore({ rootDir }),
    });
    const read = await layer.chunk(tree, Object.keys(FILES), CONFIG, COLLECTION);
    const scored = floor.scoreWorkingTreeRows(read.chunks, { querySparse, legLimit: 10 });
    await layer.dispose();
    return { ids: scored.map((r) => r.id), rowVectorizations: vectorize.mock.calls.length, read };
  };

  it("should vectorize no row in a new process that reads the rows from the store", async () => {
    const first = await scoreInNewProcess();
    const second = await scoreInNewProcess();

    expect(first.ids).toEqual(["id:src/a.ts"]);
    expect(first.rowVectorizations).toBeGreaterThan(0);
    expect(second.ids).toEqual(first.ids);
    expect(second.rowVectorizations).toBe(0);
  });

  it("should score an entry stored without vectors, and store them for the next process", async () => {
    const { read } = await scoreInNewProcess();
    // Rewrite each entry as an earlier build stored it: rows, no BM25 vectors.
    const { workingTree } = await newProcess();
    const store = workingTree.createWorkingTreeChunkStore({ rootDir });
    for (const key of read.storeKeys?.values() ?? []) {
      const entry = await store.get(COLLECTION, key);
      if (!entry) throw new Error(`no stored entry for ${key.relativePath}`);
      const { lastReadAt: _lastReadAt, sparseVectors: _sparseVectors, ...legacy } = entry;
      await store.put(COLLECTION, legacy);
      expect((await store.get(COLLECTION, key))?.sparseVectors).toBeUndefined();
    }

    const legacyRead = await scoreInNewProcess();
    const afterBackfill = await scoreInNewProcess();

    expect(legacyRead.ids).toEqual(["id:src/a.ts"]);
    expect(afterBackfill.ids).toEqual(["id:src/a.ts"]);
    expect(afterBackfill.rowVectorizations).toBe(0);
  });

  it("should vectorize one content once per process, whichever row object carries it", async () => {
    const { bm25, floor } = await newProcess();
    const querySparse = bm25.generateSparseVector("memoSharedContent");
    const vectorize = vi.mocked(bm25.generateSparseVector);
    vectorize.mockClear();
    const content = "export function memoSharedContent(): void {}\n";

    floor.scoreWorkingTreeRows([row("t1", content)], { querySparse, legLimit: 10 });
    const scored = floor.scoreWorkingTreeRows([row("t2", content, "src/copy.ts")], { querySparse, legLimit: 10 });

    expect(scored.map((r) => r.id)).toEqual(["t2"]);
    expect(vectorize).toHaveBeenCalledTimes(1);
  });
});

describe("excludeWorkingTreeBaseIds", () => {
  it("should add one has_id condition to must_not and keep the rest of the filter", () => {
    const must = [{ key: "language", match: { value: "typescript" } }];

    expect(excludeWorkingTreeBaseIds({ must }, ["b1", "b2"])).toEqual({ must, must_not: [{ has_id: ["b1", "b2"] }] });
    expect(excludeWorkingTreeBaseIds({ must, must_not: [{ key: "isTest", match: { value: true } }] }, ["b1"])).toEqual({
      must,
      must_not: [{ key: "isTest", match: { value: true } }, { has_id: ["b1"] }],
    });
  });

  it("should expand the flat form and accept an absent filter", () => {
    expect(excludeWorkingTreeBaseIds(undefined, ["b1"])).toEqual({ must_not: [{ has_id: ["b1"] }] });
    expect(excludeWorkingTreeBaseIds({ language: "ruby" }, ["b1"])).toEqual({
      must: [{ key: "language", match: { value: "ruby" } }],
      must_not: [{ has_id: ["b1"] }],
    });
  });

  it("should leave the filter alone when the touched files have no base rows", () => {
    const filter = { must: [{ key: "language", match: { value: "typescript" } }] };

    expect(excludeWorkingTreeBaseIds(filter, [])).toBe(filter);
    expect(excludeWorkingTreeBaseIds(undefined, [])).toBeUndefined();
  });
});
