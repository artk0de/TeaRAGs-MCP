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

/**
 * An in-memory store with the real store's contract — `putVectors` MERGES into
 * what the entry holds — and its read-modify-write shape: the read and the
 * write are separate turns, so two overlapping writes of one entry can race.
 */
function memoryStore() {
  const entries = new Map<string, Map<string, number[]>>();
  const getVectors = vi.fn(async (_c: string, key: { relativePath: string }, _model: string) => {
    const held = entries.get(key.relativePath);
    return held ? new Map(held) : undefined;
  });
  const putVectors = vi.fn(
    async (_c: string, key: { relativePath: string }, _model: string, vectors: ReadonlyMap<string, number[]>) => {
      const held = new Map(entries.get(key.relativePath) ?? []);
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const [sha, vector] of vectors) held.set(sha, vector);
      entries.set(key.relativePath, held);
    },
  );
  return { entries, store: { getVectors, putVectors } };
}

const storeKey = (relativePath: string) => ({
  treeRoot: "/tree",
  relativePath,
  contentSha256: `f-${relativePath}`,
  chunkerFingerprint: "c",
});

/** A promise that never settles: a provider call that hangs. */
const never = async <T>(): Promise<T> => new Promise<T>(() => undefined);

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

  it("stores the vectors reused from base points even when the embed call never settles", async () => {
    const { embeddings } = provider(async () => never());
    const { entries, store } = memoryStore();
    const source = new WorkingTreeDenseVectorSource({ embeddings, qdrant: BASE, store });

    const read = await source.warm({
      collectionName: "c",
      rows: [unchanged, edited],
      storeKeys: new Map([[PATH, storeKey(PATH)]]),
      readTouchedBasePoints: async () => basePoints,
    })(20);

    expect(read.vectors.get("t-same")).toEqual([9, 9]);
    await vi.waitFor(() => {
      expect(entries.get(PATH)?.get(sha256("same body"))).toEqual([9, 9]);
    });
  });

  it("embeds file by file and stores a file as soon as its rows are embedded, while a later batch hangs", async () => {
    let calls = 0;
    const { embeddings, asked } = provider(async (texts) => {
      calls += 1;
      if (calls > 1) return never();
      return texts.map((text) => ({ embedding: [text.length, 1], dimensions: 2 }));
    });
    const { entries, store } = memoryStore();
    const a1 = codeRow("a1", { relativePath: "a.ts", content: "a one" });
    const a2 = codeRow("a2", { relativePath: "a.ts", content: "a two two" });
    const b1 = codeRow("b1", { relativePath: "b.ts", content: "b one" });
    const c1 = codeRow("c1", { relativePath: "c.ts", content: "c one" });
    const source = new WorkingTreeDenseVectorSource({ embeddings, store, batchSize: 2 });

    const read = await source.warm({
      collectionName: "c",
      rows: [a1, c1, a2, b1],
      storeKeys: new Map(["a.ts", "b.ts", "c.ts"].map((path) => [path, storeKey(path)])),
    })(20);

    expect(asked[0]).toEqual(["a one", "a two two"]);
    expect(read.pending).toBe(2);
    await vi.waitFor(() => {
      expect(entries.get("a.ts")).toEqual(
        new Map([
          [sha256("a one"), ["a one".length, 1]],
          [sha256("a two two"), ["a two two".length, 1]],
        ]),
      );
    });
    expect(entries.has("b.ts")).toBe(false);
    expect(entries.has("c.ts")).toBe(false);
  });

  it("serves a fresh source from the store alone: no base read, no embedding for stored rows", async () => {
    const { entries, store } = memoryStore();
    const request = {
      collectionName: "c",
      rows: [unchanged, edited],
      storeKeys: new Map([[PATH, storeKey(PATH)]]),
      readTouchedBasePoints: async () => basePoints,
    };
    const qdrant = qdrantStoring({ "b-same": { content: "same body", vector: [9, 9] } });
    const hanging = provider(async () => never());
    await new WorkingTreeDenseVectorSource({ embeddings: hanging.embeddings, qdrant, store }).warm(request)(20);
    await vi.waitFor(() => {
      expect(entries.get(PATH)?.size).toBe(1);
    });
    qdrant.retrieveDenseVectors.mockClear();
    const working = provider();
    await new WorkingTreeDenseVectorSource({ embeddings: working.embeddings, qdrant, store }).warm(request)(2_000);
    // Only the still-unstored edited row looks for a base twin; the stored one is not re-read.
    expect(qdrant.retrieveDenseVectors.mock.calls.flatMap(([, ids]) => ids)).not.toContain("b-same");
    await vi.waitFor(() => {
      expect(entries.get(PATH)?.size).toBe(2);
    });
    qdrant.retrieveDenseVectors.mockClear();

    const fresh = provider();
    const read = await new WorkingTreeDenseVectorSource({ embeddings: fresh.embeddings, qdrant, store }).warm(request)(
      2_000,
    );

    expect(working.asked).toEqual([["brand new body"]]);
    expect(read.vectors.get("t-same")).toEqual([9, 9]);
    expect(read.vectors.get("t-new")).toEqual(["brand new body".length, 1]);
    expect(read.pending).toBe(0);
    expect(qdrant.retrieveDenseVectors).not.toHaveBeenCalled();
    expect(fresh.asked).toEqual([]);
  });

  it("keeps every vector of a file written in parts: a later write never drops an earlier one", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { embeddings } = provider(async (texts) => {
      calls += 1;
      if (calls > 1) await gate;
      return texts.map((text) => ({ embedding: [text.length, 1], dimensions: 2 }));
    });
    const { entries, store } = memoryStore();
    const rows = ["x", "yy", "zzz"].map((content, i) => codeRow(`p${i}`, { relativePath: PATH, content }));
    const source = new WorkingTreeDenseVectorSource({ embeddings, store, batchSize: 1 });
    const reader = source.warm({ collectionName: "c", rows, storeKeys: new Map([[PATH, storeKey(PATH)]]) });

    await reader(20);
    await vi.waitFor(() => {
      expect(entries.get(PATH)).toEqual(new Map([[sha256("x"), [1, 1]]]));
    });
    release();
    expect((await reader(2_000)).pending).toBe(0);

    await vi.waitFor(() => {
      expect(entries.get(PATH)).toEqual(
        new Map([
          [sha256("x"), [1, 1]],
          [sha256("yy"), [2, 1]],
          [sha256("zzz"), [3, 1]],
        ]),
      );
    });
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

describe("WorkingTreeDenseVectorSource — memory bound in bytes (WTO unbounded delta)", () => {
  /** Rows of distinct content, one per file — a delta of `count` rows. */
  const deltaRows = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      codeRow(`t-${String(i)}`, { relativePath: `src/f${String(i)}.ts`, content: `body ${String(i)}` }),
    );
  const warmOnce = async (source: WorkingTreeDenseVectorSource, rows: ReturnType<typeof deltaRows>) =>
    source.warm({ collectionName: "c", rows })(10_000);

  it("keeps 5,000 full-size (768-d) vectors under the default bound: a re-asked delta embeds nothing", async () => {
    const { embeddings, asked } = provider(async (texts) =>
      texts.map(() => ({ embedding: new Array<number>(768).fill(0.5), dimensions: 768 })),
    );
    const source = new WorkingTreeDenseVectorSource({ embeddings });
    const rows = deltaRows(5_000);

    const first = await warmOnce(source, rows);
    const embeddedFirst = asked.flat().length;
    const again = await warmOnce(source, rows);

    expect(first.pending).toBe(0);
    expect(embeddedFirst).toBe(5_000);
    expect(asked.flat()).toHaveLength(5_000);
    expect(again.vectors.size).toBe(5_000);
  });

  it("evicts the least recently used vector once `memoryBytes` is exceeded (8 bytes per number)", async () => {
    const { embeddings, asked } = provider();
    // The provider's vectors are 2-d: 16 bytes each, so 32 bytes hold two.
    const source = new WorkingTreeDenseVectorSource({ embeddings, memoryBytes: 32 });
    const [a, b, c] = deltaRows(3);

    await warmOnce(source, [a]);
    await warmOnce(source, [b]);
    await warmOnce(source, [a]); // a hit: a is now the most recently used
    await warmOnce(source, [c]); // over the bound: b, the least recently used, goes
    asked.length = 0;
    await warmOnce(source, [a]);
    await warmOnce(source, [b]);

    expect(asked.flat()).toEqual([b.payload.content]);
  });

  it("does not keep a vector larger than the whole bound", async () => {
    const { embeddings, asked } = provider();
    const source = new WorkingTreeDenseVectorSource({ embeddings, memoryBytes: 8 });
    const [a] = deltaRows(1);

    await warmOnce(source, [a]);
    await warmOnce(source, [a]);

    expect(asked.flat()).toEqual([a.payload.content, a.payload.content]);
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
