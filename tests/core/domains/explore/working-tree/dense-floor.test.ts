/**
 * The dense floor's vectors (bd tea-rags-mcp-xi2r9, WTO-5): every delta row's
 * dense vector comes from, in order, the base point of the same file holding
 * byte-identical content (its stored vector is exact), the working-tree chunk
 * store, then the embedding provider. Only changed chunk content is embedded,
 * once per content however many requests ask, and a reader waits at most the
 * time it is given — what is still missing is reported, never thrown.
 */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { codeRow } from "../__fixtures__/working-tree-view.js";
import type { WorkingTreeTouchedBasePointsByPath } from "../../../../../src/core/contracts/types/working-tree.js";
import {
  recommendWorkingTreeScore,
  scoreWorkingTreeRowsByVector,
  WorkingTreeDenseVectorSource,
} from "../../../../../src/core/domains/explore/working-tree/dense-floor.js";

const MODEL = "nomic-embed-text";
const PATH = "src/touched.ts";

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

/** A provider whose vector for a text is [length, 1]; counts what it was asked to embed. */
function provider(embedBatch?: (texts: string[]) => Promise<{ embedding: number[]; dimensions: number }[]>) {
  const asked: string[][] = [];
  const impl =
    embedBatch ?? (async (texts: string[]) => texts.map((text) => ({ embedding: [text.length, 1], dimensions: 2 })));
  return {
    asked,
    embeddings: {
      getModel: () => MODEL,
      embedBatch: vi.fn(async (texts: string[]) => {
        asked.push(texts);
        return impl(texts);
      }),
    },
  };
}

const unchanged = codeRow("t-same", { relativePath: PATH, content: "same body", startLine: 10, endLine: 12 });
const edited = codeRow("t-new", { relativePath: PATH, content: "brand new body", startLine: 20, endLine: 25 });

/** The base points of the touched file: one with the unchanged row's content and lines. */
const basePoints: WorkingTreeTouchedBasePointsByPath = new Map([
  [
    PATH,
    [
      { id: "b-same", payload: { relativePath: PATH, startLine: 1, endLine: 3 } },
      { id: "b-old", payload: { relativePath: PATH, startLine: 20, endLine: 25 } },
    ],
  ],
]);

function qdrantStoring(vectors: Record<string, { content: string; vector: number[] }>) {
  return {
    retrieveDenseVectors: vi.fn(async (_c: string, ids: readonly (string | number)[]) =>
      ids.flatMap((id) => {
        const stored = vectors[String(id)];
        return stored ? [{ id, payload: { content: stored.content }, vector: stored.vector }] : [];
      }),
    ),
  };
}

const BASE = qdrantStoring({
  "b-same": { content: "same body", vector: [9, 9] },
  "b-old": { content: "old body", vector: [7, 7] },
});

describe("WorkingTreeDenseVectorSource", () => {
  it("reuses the stored vector of a base point with byte-identical content and embeds only the rest", async () => {
    const { embeddings, asked } = provider();
    const source = new WorkingTreeDenseVectorSource({ embeddings, qdrant: BASE });

    const read = await source.warm({
      collectionName: "c",
      rows: [unchanged, edited],
      readTouchedBasePoints: async () => basePoints,
    })(2_000);

    expect(read.vectors.get("t-same")).toEqual([9, 9]);
    expect(read.vectors.get("t-new")).toEqual(["brand new body".length, 1]);
    expect(asked).toEqual([["brand new body"]]);
    expect(read.pending).toBe(0);
    expect(read.failure).toBeUndefined();
  });

  it("embeds one content once per process, however many requests and rows ask for it", async () => {
    const { embeddings, asked } = provider();
    const source = new WorkingTreeDenseVectorSource({ embeddings });
    const twin = codeRow("t-twin", { relativePath: "src/other.ts", content: "brand new body" });

    const [a, b] = await Promise.all([
      source.warm({ collectionName: "c", rows: [edited, twin] })(2_000),
      source.warm({ collectionName: "c", rows: [edited] })(2_000),
    ]);
    const later = await source.warm({ collectionName: "c", rows: [edited] })(2_000);

    expect(asked.flat()).toEqual(["brand new body"]);
    expect(a.vectors.get("t-twin")).toEqual(a.vectors.get("t-new"));
    expect(b.vectors.get("t-new")).toBeDefined();
    expect(later.vectors.get("t-new")).toBeDefined();
  });

  it("serves a stored vector without embedding, and stores what it embedded beside the file's rows", async () => {
    const { embeddings, asked } = provider();
    const key = { treeRoot: "/tree", relativePath: PATH, contentSha256: "f", chunkerFingerprint: "c" };
    const getVectors = vi.fn(async () => new Map([[sha256("same body"), [5, 5]]]));
    const putVectors = vi.fn(async () => undefined);
    const source = new WorkingTreeDenseVectorSource({ embeddings, store: { getVectors, putVectors } });

    const read = await source.warm({
      collectionName: "c",
      rows: [unchanged, edited],
      storeKeys: new Map([[PATH, key]]),
    })(2_000);
    await vi.waitFor(() => {
      expect(putVectors).toHaveBeenCalled();
    });

    expect(read.vectors.get("t-same")).toEqual([5, 5]);
    expect(asked).toEqual([["brand new body"]]);
    expect(getVectors).toHaveBeenCalledWith("c", key, MODEL);
    expect(putVectors).toHaveBeenCalledWith(
      "c",
      key,
      MODEL,
      new Map([
        [sha256("same body"), [5, 5]],
        [sha256("brand new body"), ["brand new body".length, 1]],
      ]),
    );
  });

  it("answers what it has once the wait lapses, and the rest on a later read", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { embeddings } = provider(async (texts) => {
      await gate;
      return texts.map(() => ({ embedding: [1, 0], dimensions: 2 }));
    });
    const source = new WorkingTreeDenseVectorSource({ embeddings, qdrant: BASE });
    const reader = source.warm({
      collectionName: "c",
      rows: [unchanged, edited],
      readTouchedBasePoints: async () => basePoints,
    });

    const early = await reader(20);
    release();
    const late = await reader(2_000);

    expect(early.vectors.get("t-same")).toEqual([9, 9]);
    expect(early.vectors.has("t-new")).toBe(false);
    expect(early.pending).toBe(1);
    expect(early.failure).toBeUndefined();
    expect(late.vectors.get("t-new")).toEqual([1, 0]);
    expect(late.pending).toBe(0);
  });

  it("reports the provider's failure without throwing, keeps reused vectors, and retries on the next request", async () => {
    let fail = true;
    const { embeddings, asked } = provider(async (texts) => {
      if (fail) throw new Error("connect ECONNREFUSED 127.0.0.1:1");
      return texts.map(() => ({ embedding: [1, 0], dimensions: 2 }));
    });
    const source = new WorkingTreeDenseVectorSource({ embeddings, qdrant: BASE });
    const request = { collectionName: "c", rows: [unchanged, edited], readTouchedBasePoints: async () => basePoints };

    const failed = await source.warm(request)(2_000);
    fail = false;
    const retried = await source.warm(request)(2_000);

    expect(failed.vectors.get("t-same")).toEqual([9, 9]);
    expect(failed.pending).toBe(1);
    expect(failed.failure).toContain("ECONNREFUSED");
    expect(retried.vectors.get("t-new")).toEqual([1, 0]);
    expect(retried.failure).toBeUndefined();
    expect(asked).toHaveLength(2);
  });

  it("falls through to the provider when the base vectors cannot be read", async () => {
    const { embeddings, asked } = provider();
    const qdrant = { retrieveDenseVectors: vi.fn(async () => Promise.reject(new Error("qdrant down"))) };
    const source = new WorkingTreeDenseVectorSource({ embeddings, qdrant });

    const read = await source.warm({
      collectionName: "c",
      rows: [unchanged],
      readTouchedBasePoints: async () => basePoints,
    })(2_000);

    expect(read.vectors.get("t-same")).toEqual(["same body".length, 1]);
    expect(asked).toEqual([["same body"]]);
  });

  it("does not count a row without content as pending: it has nothing to embed", async () => {
    const { embeddings, asked } = provider();
    const source = new WorkingTreeDenseVectorSource({ embeddings });

    const read = await source.warm({ collectionName: "c", rows: [codeRow("t-empty", { content: "" })] })(2_000);

    expect(read.pending).toBe(0);
    expect(read.vectors.size).toBe(0);
    expect(asked).toEqual([]);
  });
});

describe("scoreWorkingTreeRowsByVector", () => {
  it("scores each admitted row with a vector by exact cosine against the query, best first", () => {
    const rows = [
      codeRow("far", { relativePath: "a.ts" }),
      codeRow("near", { relativePath: "b.ts" }),
      codeRow("none", { relativePath: "c.ts" }),
      codeRow("filtered", { relativePath: "d.ts" }),
    ];
    const vectors = new Map([
      ["far", [0, 1]],
      ["near", [1, 0.1]],
      ["filtered", [1, 0]],
    ]);

    const scored = scoreWorkingTreeRowsByVector(rows, vectors, [1, 0], (row) => row.payload.relativePath !== "d.ts");

    expect(scored.map((r) => r.id)).toEqual(["near", "far"]);
    expect(scored[0].score).toBeCloseTo(1 / Math.sqrt(1.01), 10);
    expect(scored[1].score).toBeCloseTo(0, 10);
  });
});

describe("recommendWorkingTreeScore", () => {
  const candidate = [1, 0];

  // Qdrant 1.18 `merge_similarities`: scaled_fast_sigmoid(x) = 0.5 * (x / (1 + |x|) + 1)
  // of the best positive when it beats the best negative, else its negation of
  // the best negative — measured live against the embedded daemon (cos 0.8724
  // → 0.73296, cos 0.6181 beating a 0.5906 negative → 0.69099).
  it("best_score: Qdrant's scaled sigmoid of the best positive when it beats the best negative, else minus the negative's", () => {
    expect(recommendWorkingTreeScore(candidate, [[1, 0]], [[0, 1]], "best_score")).toBeCloseTo(0.75, 10);
    expect(recommendWorkingTreeScore(candidate, [[0, 1]], [[1, 0]], "best_score")).toBeCloseTo(-0.75, 10);
    expect(recommendWorkingTreeScore(candidate, [[1, 1]], [], "best_score")).toBeCloseTo(
      0.5 * (Math.SQRT1_2 / (1 + Math.SQRT1_2) + 1),
      10,
    );
  });

  it("sum_scores: positive cosines minus negative cosines", () => {
    expect(
      recommendWorkingTreeScore(
        candidate,
        [
          [1, 0],
          [0, 1],
        ],
        [[1, 1]],
        "sum_scores",
      ),
    ).toBeCloseTo(1 - 1 / Math.sqrt(2), 10);
  });

  it("average_vector: cosine against avg(pos) + avg(pos) - avg(neg)", () => {
    // avg(pos) = [1, 0]; avg(neg) = [0, 1] → query [2, -1]
    expect(recommendWorkingTreeScore(candidate, [[1, 0]], [[0, 1]], "average_vector")).toBeCloseTo(
      2 / Math.sqrt(5),
      10,
    );
    // no negatives → query = avg(pos)
    expect(recommendWorkingTreeScore(candidate, [[1, 0]], [], "average_vector")).toBeCloseTo(1, 10);
  });
});
