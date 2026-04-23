import { describe, expect, it, vi } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import {
  applyEssentialSignalsToOverlay,
  computeFetchLimit,
  filterMetaOnly,
  postProcess,
  type SearchResult,
} from "../../../../src/core/domains/explore/post-process.js";
import type { Reranker } from "../../../../src/core/domains/explore/reranker.js";

// ---------------------------------------------------------------------------
// computeFetchLimit
// ---------------------------------------------------------------------------

describe("computeFetchLimit", () => {
  it("returns default limit of 5 when undefined", () => {
    const result = computeFetchLimit(undefined);
    expect(result.requestedLimit).toBe(5);
    expect(result.fetchLimit).toBeGreaterThanOrEqual(20);
  });

  it("uses requested limit", () => {
    const result = computeFetchLimit(10);
    expect(result.requestedLimit).toBe(10);
  });

  it("pathPattern no longer affects overfetch (pre-filter now)", () => {
    const without = computeFetchLimit(10);
    const withPattern = computeFetchLimit(10, "src/**");
    expect(withPattern.fetchLimit).toBe(without.fetchLimit);
  });

  it("applies higher overfetch with rerank (non-relevance)", () => {
    const without = computeFetchLimit(10);
    const withRerank = computeFetchLimit(10, undefined, "hotspots");
    expect(withRerank.fetchLimit).toBeGreaterThan(without.fetchLimit);
  });

  it("does not overfetch for relevance preset", () => {
    const without = computeFetchLimit(10);
    const withRelevance = computeFetchLimit(10, undefined, "relevance");
    expect(withRelevance.fetchLimit).toBe(without.fetchLimit);
  });
});

// ---------------------------------------------------------------------------
// postProcess
// ---------------------------------------------------------------------------

describe("postProcess", () => {
  const mockReranker: Reranker = {
    rerank: vi
      .fn()
      .mockImplementation((results: SearchResult[]) => results.map((r, i) => ({ ...r, score: 1 - i * 0.1 }))),
  } as unknown as Reranker;

  const sampleResults: SearchResult[] = [
    { id: "1", score: 0.9, payload: { relativePath: "src/a.ts" } },
    { id: "2", score: 0.8, payload: { relativePath: "src/b.ts" } },
    { id: "3", score: 0.7, payload: { relativePath: "test/c.test.ts" } },
  ];

  it("returns results trimmed to limit", () => {
    const result = postProcess(sampleResults, { limit: 2, reranker: mockReranker });
    expect(result).toHaveLength(2);
  });

  it("pathPattern in postProcess is a no-op (pre-filter handles it)", () => {
    const result = postProcess(sampleResults, {
      limit: 10,
      pathPattern: "src/**",
      reranker: mockReranker,
    });
    // All 3 results pass through — pathPattern is handled as Qdrant pre-filter, not post-filter
    expect(result).toHaveLength(3);
  });

  it("applies reranking for non-relevance preset", () => {
    postProcess(sampleResults, { limit: 10, rerank: "hotspots", reranker: mockReranker });
    expect(mockReranker.rerank).toHaveBeenCalledWith(sampleResults, "hotspots", "semantic_search", {
      signalLevel: undefined,
      query: undefined,
    });
  });

  it("skips reranking for relevance preset", () => {
    const reranker = { rerank: vi.fn() } as unknown as Reranker;
    postProcess(sampleResults, { limit: 10, rerank: "relevance", reranker });
    expect(reranker.rerank).not.toHaveBeenCalled();
  });

  it("skips reranking when no rerank option", () => {
    const reranker = { rerank: vi.fn() } as unknown as Reranker;
    postProcess(sampleResults, { limit: 10, reranker });
    expect(reranker.rerank).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// filterMetaOnly
// ---------------------------------------------------------------------------

describe("filterMetaOnly", () => {
  const payloadSignals: PayloadSignalDescriptor[] = [
    { key: "relativePath", type: "string", description: "File path" },
    { key: "language", type: "string", description: "Language" },
    { key: "startLine", type: "number", description: "Start line" },
  ];

  it("extracts score and payload signal fields", () => {
    const results: SearchResult[] = [
      { score: 0.9, payload: { relativePath: "src/a.ts", language: "typescript", startLine: 1, content: "code..." } },
    ];
    const meta = filterMetaOnly(results, payloadSignals, []);
    expect(meta[0].score).toBe(0.9);
    expect(meta[0].relativePath).toBe("src/a.ts");
    expect(meta[0].language).toBe("typescript");
    expect(meta[0].startLine).toBe(1);
    // content should NOT be included (not in payloadSignals)
    expect(meta[0].content).toBeUndefined();
  });

  it("includes overlay git data when overlay has data", () => {
    const results: SearchResult[] = [
      {
        score: 0.8,
        payload: { relativePath: "src/b.ts" },
        rankingOverlay: {
          preset: "techDebt",
          file: { ageDays: 100, commitCount: 5 },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, []);
    expect(meta[0].git).toEqual({ file: { ageDays: 100, commitCount: 5 } });
    expect(meta[0].derived).toBeUndefined();
    expect(meta[0].preset).toBe("techDebt");
  });

  it("filters git by essential fields when no overlay", () => {
    const results: SearchResult[] = [
      {
        score: 0.7,
        payload: {
          relativePath: "src/c.ts",
          git: { file: { ageDays: 200, commitCount: 10, authors: ["Alice"] } },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, ["git.file.ageDays", "git.file.commitCount"]);
    const git = meta[0].git as Record<string, Record<string, unknown>>;
    expect(git.file.ageDays).toBe(200);
    expect(git.file.commitCount).toBe(10);
    expect(git.file.authors).toBeUndefined(); // not essential
  });

  it("includes taskIds in essential fields", () => {
    const results: SearchResult[] = [
      {
        score: 0.7,
        payload: {
          relativePath: "src/c.ts",
          git: {
            file: { ageDays: 200, taskIds: ["TD-123", "TD-456"], authors: ["Alice"] },
            chunk: { commitCount: 5, taskIds: ["TD-123"] },
          },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, [
      "git.file.ageDays",
      "git.file.taskIds",
      "git.chunk.commitCount",
      "git.chunk.taskIds",
    ]);
    const git = meta[0].git as Record<string, Record<string, unknown>>;
    expect(git.file.ageDays).toBe(200);
    expect(git.file.taskIds).toEqual(["TD-123", "TD-456"]);
    expect(git.file.authors).toBeUndefined(); // not essential
    expect(git.chunk.commitCount).toBe(5);
    expect(git.chunk.taskIds).toEqual(["TD-123"]);
  });

  it("returns empty git when no essential fields match", () => {
    const results: SearchResult[] = [
      {
        score: 0.6,
        payload: {
          relativePath: "src/d.ts",
          git: { file: { ageDays: 50 } },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, ["git.chunk.commitCount"]);
    expect(meta[0].git).toBeUndefined();
  });

  it("includes chunk-level overlay data", () => {
    const results: SearchResult[] = [
      {
        score: 0.5,
        payload: { relativePath: "src/e.ts" },
        rankingOverlay: {
          preset: "hotspots",
          chunk: { commitCount: 3 },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, []);
    expect(meta[0].git).toEqual({ chunk: { commitCount: 3 } });
  });

  it("merges essential fields with overlay data when both exist", () => {
    const results: SearchResult[] = [
      {
        score: 0.8,
        payload: {
          relativePath: "src/b.ts",
          git: {
            file: { ageDays: 100, commitCount: 5, taskIds: ["TD-123", "TD-456"], authors: ["Alice"] },
            chunk: { commitCount: 3, taskIds: ["TD-123"] },
          },
        },
        rankingOverlay: {
          preset: "techDebt",
          file: { ageDays: 100, commitCount: 5 },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, [
      "git.file.taskIds",
      "git.chunk.commitCount",
      "git.chunk.taskIds",
    ]);
    const git = meta[0].git as Record<string, Record<string, unknown>>;
    // overlay signals present
    expect(git.file.ageDays).toBe(100);
    expect(git.file.commitCount).toBe(5);
    // essential fields merged from full payload
    expect(git.file.taskIds).toEqual(["TD-123", "TD-456"]);
    expect(git.chunk.commitCount).toBe(3);
    expect(git.chunk.taskIds).toEqual(["TD-123"]);
    // non-essential fields excluded
    expect(git.file.authors).toBeUndefined();
    expect(meta[0].preset).toBe("techDebt");
  });

  it("includes imports when marked essential in payload signals", () => {
    const signalsWithImports: PayloadSignalDescriptor[] = [
      ...payloadSignals,
      { key: "imports", type: "string[]", description: "File imports", essential: true },
    ];
    const results: SearchResult[] = [
      {
        score: 0.7,
        payload: {
          relativePath: "src/c.ts",
          language: "typescript",
          startLine: 1,
          imports: ["./utils", "./types"],
          content: "code...",
        },
      },
    ];
    const meta = filterMetaOnly(results, signalsWithImports, []);
    expect(meta[0].imports).toEqual(["./utils", "./types"]);
    expect(meta[0].content).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyEssentialSignalsToOverlay
// ---------------------------------------------------------------------------

describe("applyEssentialSignalsToOverlay", () => {
  const buildResult = (gitFile: Record<string, unknown>, gitChunk?: Record<string, unknown>): SearchResult => ({
    score: 0.9,
    payload: {
      relativePath: "src/foo.ts",
      symbolId: "Foo#bar",
      chunkCount: 3,
      git: { file: gitFile, ...(gitChunk ? { chunk: gitChunk } : {}) },
    },
  });

  it("filters git.file to only fields named in essentialKeys", () => {
    const result = buildResult(
      { commitCount: 27, ageDays: 0, taskIds: [], dominantAuthor: "Alice", enrichedAt: "2026-01-01" },
      { commitCount: 2, relativeChurn: 0.5 },
    );
    const essentialKeys = ["git.file.commitCount", "git.file.ageDays", "git.chunk.commitCount"];

    const out = applyEssentialSignalsToOverlay(result, essentialKeys);
    const { git } = out.payload as any;

    expect(Object.keys(git.file).sort()).toEqual(["ageDays", "commitCount"]);
    expect(git.file.dominantAuthor).toBeUndefined();
    expect(git.file.enrichedAt).toBeUndefined();
    // Chunk level: only commitCount kept, relativeChurn dropped
    expect(Object.keys(git.chunk)).toEqual(["commitCount"]);
  });

  it("preserves non-git payload fields (outline scaffolding untouched)", () => {
    const result = buildResult({ commitCount: 5, dominantAuthor: "x" });
    const out = applyEssentialSignalsToOverlay(result, ["git.file.commitCount"]);

    // Outline-specific fields preserved
    expect(out.payload?.relativePath).toBe("src/foo.ts");
    expect(out.payload?.symbolId).toBe("Foo#bar");
    expect(out.payload?.chunkCount).toBe(3);
  });

  it("merges ranking overlay signals on top of essential fields", () => {
    const result: SearchResult = {
      score: 0.9,
      payload: { relativePath: "src/foo.ts", git: { file: { commitCount: 27, bugFixRate: 42 } } },
      rankingOverlay: {
        preset: "bugHunt",
        file: { bugFixRate: { value: 42, label: "healthy" }, churnVolatility: { value: 3.26, label: "stable" } },
      },
    };
    const out = applyEssentialSignalsToOverlay(result, ["git.file.commitCount"]);
    const { git } = out.payload as any;

    expect(git.file.commitCount).toBe(27); // essential kept
    expect(git.file.bugFixRate).toEqual({ value: 42, label: "healthy" }); // overlay overwrites raw
    expect(git.file.churnVolatility).toEqual({ value: 3.26, label: "stable" }); // overlay adds
    expect((out.payload as any).preset).toBe("bugHunt");
  });

  it("leaves payload unchanged when no essential keys and no overlay", () => {
    const result = buildResult({ commitCount: 5 });
    const out = applyEssentialSignalsToOverlay(result, []);
    expect(out).toBe(result);
  });

  it("drops namespace entirely when no essential fields match", () => {
    const result = buildResult({ dominantAuthor: "x", enrichedAt: "y" });
    const out = applyEssentialSignalsToOverlay(result, ["git.file.commitCount"]); // no match
    expect((out.payload as any).git).toBeUndefined();
    expect(out.payload?.relativePath).toBe("src/foo.ts"); // non-git preserved
  });

  it("ignores keys with fewer than 3 segments (flat fields handled elsewhere)", () => {
    const result = buildResult({ commitCount: 5 });
    const out = applyEssentialSignalsToOverlay(result, ["imports", "methodLines"]);
    // Flat keys produce no namespace groups and no overlay → payload
    // passes through unchanged. Flat-field preservation is the caller's
    // concern (e.g. filterMetaOnly already iterates payloadSignals).
    expect(out).toBe(result);
  });

  it("is trajectory-agnostic: works for a hypothetical non-git namespace", () => {
    const result: SearchResult = {
      score: 0.9,
      payload: {
        relativePath: "src/foo.ts",
        runtime: {
          file: { memoryMb: 128, cpuPct: 45, debugTrace: "<trace>", internalId: "abc" },
        },
      },
    };
    const out = applyEssentialSignalsToOverlay(result, ["runtime.file.memoryMb", "runtime.file.cpuPct"]);
    const { runtime } = out.payload as any;
    expect(Object.keys(runtime.file).sort()).toEqual(["cpuPct", "memoryMb"]);
    expect(runtime.file.debugTrace).toBeUndefined();
    expect(runtime.file.internalId).toBeUndefined();
  });

  it("handles missing payload namespace with only overlay present", () => {
    const result: SearchResult = {
      score: 0.9,
      payload: { relativePath: "src/foo.ts" }, // no git in payload
      rankingOverlay: {
        preset: "hotspots",
        file: { bugFixRate: { value: 10, label: "healthy" } },
      },
    };
    const out = applyEssentialSignalsToOverlay(result, ["git.file.commitCount"]);
    const { git } = out.payload as any;
    expect(git.file.bugFixRate).toEqual({ value: 10, label: "healthy" });
    expect((out.payload as any).preset).toBe("hotspots");
  });
});
