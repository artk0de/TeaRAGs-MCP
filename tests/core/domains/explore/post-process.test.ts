import { describe, expect, it, vi } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../src/core/contracts/types/trajectory.js";
import {
  applyEssentialSignals,
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

  it("returns results trimmed to limit", async () => {
    const result = await postProcess(sampleResults, { limit: 2, reranker: mockReranker });
    expect(result).toHaveLength(2);
  });

  // bd tea-rags-mcp-xf01b: the Qdrant text pre-filter is a superset, so
  // pathPattern must still select results exactly (picomatch) here.
  it("pathPattern keeps only results whose relativePath matches the glob exactly", async () => {
    const result = await postProcess(sampleResults, {
      limit: 10,
      pathPattern: "src/**",
      reranker: mockReranker,
    });
    expect(result.map((r) => r.payload?.relativePath)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("applies reranking for non-relevance preset", async () => {
    await postProcess(sampleResults, { limit: 10, rerank: "hotspots", reranker: mockReranker });
    expect(mockReranker.rerank).toHaveBeenCalledWith(sampleResults, "hotspots", "semantic_search", {
      signalLevel: undefined,
      query: undefined,
    });
  });

  it("skips reranking for relevance preset", async () => {
    const reranker = { rerank: vi.fn() } as unknown as Reranker;
    await postProcess(sampleResults, { limit: 10, rerank: "relevance", reranker });
    expect(reranker.rerank).not.toHaveBeenCalled();
  });

  it("skips reranking when no rerank option", async () => {
    const reranker = { rerank: vi.fn() } as unknown as Reranker;
    await postProcess(sampleResults, { limit: 10, reranker });
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
    // Git signals declared as the git trajectory declares them in production.
    { key: "git.file.ageDays", type: "number", description: "File age" },
    { key: "git.file.commitCount", type: "number", description: "File commits" },
    { key: "git.chunk.commitCount", type: "number", description: "Chunk commits" },
  ];

  // metaOnly contract (2026-09-24, supersedes bd tea-rags-mcp-rtjrn): the
  // payload is RAW everywhere — every value at its owner path in its stored
  // form, never a {value,label}. Labels live only on the hit's rankingOverlay.
  // Live shape: a techDebt file-level overlay carries a git signal, a static
  // flat signal (`imports`) and a codegraph signal (`fanIn`).
  describe("payload stays raw whatever the overlay carries", () => {
    const ownedSignals: PayloadSignalDescriptor[] = [
      ...payloadSignals,
      { key: "git.file.bugFixRate", type: "number", description: "Bug-fix rate" },
      { key: "imports", type: "string[]", description: "File imports", level: "file" },
      { key: "codegraph.file.fanIn", type: "number", description: "File fan-in" },
      { key: "codegraph.chunk.fanIn", type: "number", description: "Symbol fan-in" },
    ];

    const liveFileHit = (): SearchResult => ({
      score: 0.8,
      payload: {
        relativePath: "src/hub.ts",
        imports: ["./a", "./b"],
        git: { file: { commitCount: 27, bugFixRate: 40 } },
        codegraph: { symbols: { file: { fanIn: 12, fanOut: 3 } } },
      },
      rankingOverlay: {
        preset: "techDebt",
        file: {
          commitCount: { value: 27, label: "high" },
          imports: ["./a", "./b"],
          fanIn: { value: 12, label: "frequent" },
        },
      },
    });

    it("carries no {value,label} anywhere in the payload", () => {
      const meta = filterMetaOnly([liveFileHit()], ownedSignals, ["git.file.commitCount"])[0];
      expect(JSON.stringify(meta)).not.toContain('"label"');
    });

    it("keeps git essential fields raw at their owner path", () => {
      const meta = filterMetaOnly([liveFileHit()], ownedSignals, ["git.file.commitCount"])[0];
      expect(meta.git).toEqual({ file: { commitCount: 27 } });
    });

    it("keeps a static signal raw at the payload root", () => {
      const meta = filterMetaOnly([liveFileHit()], ownedSignals, [])[0];
      expect(meta.imports).toEqual(["./a", "./b"]);
    });

    it("forwards the codegraph branch raw", () => {
      const meta = filterMetaOnly([liveFileHit()], ownedSignals, [])[0];
      expect((meta.codegraph as any).symbols.file).toEqual({ fanIn: 12, fanOut: 3 });
    });

    it("adds no overlay-only git field and no preset to the payload", () => {
      const meta = filterMetaOnly([liveFileHit()], ownedSignals, [])[0];
      expect(meta.git).toBeUndefined();
      expect(meta).not.toHaveProperty("preset");
    });

    it("does not mutate the hit's own payload", () => {
      const hit = liveFileHit();
      filterMetaOnly([hit], ownedSignals, []);
      expect((hit.payload as any).codegraph.symbols.file.fanIn).toBe(12);
    });
  });

  // bd tea-rags-mcp-947xf: the score lives on the hit, not in its payload.
  it("extracts payload signal fields and no copy of the score", () => {
    const results: SearchResult[] = [
      { score: 0.9, payload: { relativePath: "src/a.ts", language: "typescript", startLine: 1, content: "code..." } },
    ];
    const meta = filterMetaOnly(results, payloadSignals, []);
    expect(meta[0]).not.toHaveProperty("score");
    expect(meta[0].relativePath).toBe("src/a.ts");
    expect(meta[0].language).toBe("typescript");
    expect(meta[0].startLine).toBe(1);
    // content should NOT be included (not in payloadSignals)
    expect(meta[0].content).toBeUndefined();
  });

  it("does not copy file-level overlay values into the payload", () => {
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
    expect(meta[0].git).toBeUndefined();
    expect(meta[0].derived).toBeUndefined();
    expect(meta[0]).not.toHaveProperty("preset");
  });

  it("filters git by essential fields when no overlay", () => {
    const results: SearchResult[] = [
      {
        score: 0.7,
        payload: {
          relativePath: "src/c.ts",
          git: { file: { ageDays: 200, commitCount: 10, recentAuthors: ["Alice"] } },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, ["git.file.ageDays", "git.file.commitCount"]);
    const git = meta[0].git as Record<string, Record<string, unknown>>;
    expect(git.file.ageDays).toBe(200);
    expect(git.file.commitCount).toBe(10);
    expect(git.file.recentAuthors).toBeUndefined(); // not essential
  });

  it("includes taskIds in essential fields", () => {
    const results: SearchResult[] = [
      {
        score: 0.7,
        payload: {
          relativePath: "src/c.ts",
          git: {
            file: { ageDays: 200, taskIds: ["TD-123", "TD-456"], recentAuthors: ["Alice"] },
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
    expect(git.file.recentAuthors).toBeUndefined(); // not essential
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

  it("does not copy chunk-level overlay values into the payload", () => {
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
    expect(meta[0].git).toBeUndefined();
  });

  it("keeps only raw essential fields when an overlay also exists", () => {
    const results: SearchResult[] = [
      {
        score: 0.8,
        payload: {
          relativePath: "src/b.ts",
          git: {
            file: { ageDays: 100, commitCount: 5, taskIds: ["TD-123", "TD-456"], recentAuthors: ["Alice"] },
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
    // essential fields only, raw from the full payload — the overlay's
    // ageDays/commitCount stay on rankingOverlay
    expect(meta[0].git).toEqual({
      file: { taskIds: ["TD-123", "TD-456"] },
      chunk: { commitCount: 3, taskIds: ["TD-123"] },
    });
    expect(meta[0]).not.toHaveProperty("preset");
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

  it("does not copy the overlay preset into the payload", () => {
    // The preset is attributed by rankingOverlay.preset, which a metaOnly hit
    // keeps; a payload copy would be a field the non-metaOnly payload lacks.
    const results: SearchResult[] = [
      {
        score: 0.42,
        payload: { relativePath: "src/empty-overlay.ts" },
        rankingOverlay: {
          preset: "stable",
          // No file/chunk entries — hasOverlayData returns false.
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, []);
    expect(meta[0]).not.toHaveProperty("preset");
    // No git block produced: no essentials requested.
    expect(meta[0].git).toBeUndefined();
  });

  // tea-rags-mcp-0am0 — codegraph projection in metaOnly mode.
  // EnrichmentApplier writes codegraph file-level signals under
  // `payload.codegraph.symbols.{file,chunk}` with dotted inner keys. Before
  // this fix, filterMetaOnly only forwarded the git namespace, so MCP
  // callers requesting metaOnly never saw codegraph signals even when
  // they were present in the payload.
  it("preserves codegraph.symbols.file payload in metaOnly projection", () => {
    const results: SearchResult[] = [
      {
        score: 0.9,
        payload: {
          relativePath: "src/hub.ts",
          codegraph: {
            symbols: {
              file: {
                "codegraph.file.fanIn": 12,
                "codegraph.file.fanOut": 3,
                "codegraph.file.isHub": true,
              },
            },
          },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, []);
    const codegraph = meta[0].codegraph as
      | { symbols?: { file?: Record<string, unknown>; chunk?: Record<string, unknown> } }
      | undefined;
    expect(codegraph).toBeDefined();
    expect(codegraph!.symbols).toBeDefined();
    expect(codegraph!.symbols!.file).toEqual({
      "codegraph.file.fanIn": 12,
      "codegraph.file.fanOut": 3,
      "codegraph.file.isHub": true,
    });
  });

  it("preserves codegraph chunk section when the hit has an overlay", () => {
    const results: SearchResult[] = [
      {
        score: 0.8,
        payload: {
          relativePath: "src/method.ts",
          codegraph: {
            symbols: {
              chunk: {
                "codegraph.chunk.fanIn": 5,
                "codegraph.chunk.pageRank": 0.01,
              },
            },
          },
        },
        rankingOverlay: {
          preset: "hotspots",
          chunk: { commitCount: 3 },
        },
      },
    ];
    const meta = filterMetaOnly(results, payloadSignals, []);
    expect(meta[0].git).toBeUndefined();
    const codegraph = meta[0].codegraph as { symbols?: { chunk?: Record<string, unknown> } } | undefined;
    expect(codegraph?.symbols?.chunk).toEqual({
      "codegraph.chunk.fanIn": 5,
      "codegraph.chunk.pageRank": 0.01,
    });
  });

  // bd tea-rags-mcp-947xf — the file-level members outline is gone; a stray
  // undeclared `members` key is rebuilt away like any other undeclared field.
  it("does not forward an undeclared members field", () => {
    const results: SearchResult[] = [
      { score: 0.9, payload: { relativePath: "src/reranker.ts", members: "src/reranker.ts\n  Reranker" } },
    ];
    expect(filterMetaOnly(results, payloadSignals, [])[0]).not.toHaveProperty("members");
  });
});

// ---------------------------------------------------------------------------
// applyEssentialSignals
// ---------------------------------------------------------------------------

describe("applyEssentialSignals", () => {
  // metaOnly contract (2026-09-24, supersedes bd tea-rags-mcp-rtjrn): the
  // find_symbol metaOnly payload is raw — overlay values never enter it; the
  // hit keeps its rankingOverlay, where every label lives.
  it("never merges overlay values or the preset into the payload", () => {
    const result: SearchResult = {
      score: 0.9,
      payload: {
        relativePath: "src/foo.ts",
        imports: ["./a"],
        git: { file: { commitCount: 27 } },
        codegraph: { symbols: { file: { fanIn: 12 } } },
      },
      rankingOverlay: {
        preset: "techDebt",
        file: {
          bugFixRate: { value: 40, label: "concerning" },
          imports: ["./a"],
          fanIn: { value: 12, label: "frequent" },
        },
      },
    };
    const out = applyEssentialSignals(result, ["git.file.commitCount"]);
    const payload = out.payload as any;
    expect(payload.git.file).toEqual({ commitCount: 27 });
    expect(payload.imports).toEqual(["./a"]);
    expect(payload.codegraph.symbols.file).toEqual({ fanIn: 12 });
    expect(payload).not.toHaveProperty("preset");
    expect(JSON.stringify(payload)).not.toContain('"label"');
    expect(out.rankingOverlay).toBe(result.rankingOverlay);
  });

  // bd tea-rags-mcp-0x55i — an essential codegraph key is LOGICAL
  // (`codegraph.file.fanIn`); the payload stores it PHYSICALLY
  // (`codegraph.symbols.file.fanIn`), so the filter must read the physical path.
  it("keeps an essential codegraph key at its physical payload path", () => {
    const result: SearchResult = {
      score: 0.9,
      payload: {
        relativePath: "src/foo.ts",
        codegraph: { symbols: { file: { fanIn: 12, fanOut: 3 }, chunk: { pageRank: 0.01 } } },
      },
    };
    const out = applyEssentialSignals(result, ["codegraph.file.fanIn"]);
    expect((out.payload as any).codegraph).toEqual({ symbols: { file: { fanIn: 12 } } });
  });

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
      { commitCount: 27, ageDays: 0, taskIds: [], recentDominantAuthor: "Alice", enrichedAt: "2026-01-01" },
      { commitCount: 2, relativeChurn: 0.5 },
    );
    const essentialKeys = ["git.file.commitCount", "git.file.ageDays", "git.chunk.commitCount"];

    const out = applyEssentialSignals(result, essentialKeys);
    const { git } = out.payload as any;

    expect(Object.keys(git.file).sort()).toEqual(["ageDays", "commitCount"]);
    expect(git.file.recentDominantAuthor).toBeUndefined();
    expect(git.file.enrichedAt).toBeUndefined();
    // Chunk level: only commitCount kept, relativeChurn dropped
    expect(Object.keys(git.chunk)).toEqual(["commitCount"]);
  });

  it("preserves non-git payload fields (outline scaffolding untouched)", () => {
    const result = buildResult({ commitCount: 5, recentDominantAuthor: "x" });
    const out = applyEssentialSignals(result, ["git.file.commitCount"]);

    // Outline-specific fields preserved
    expect(out.payload?.relativePath).toBe("src/foo.ts");
    expect(out.payload?.symbolId).toBe("Foo#bar");
    expect(out.payload?.chunkCount).toBe(3);
  });

  it("keeps a raw essential value raw when the overlay labels the same field", () => {
    const result: SearchResult = {
      score: 0.9,
      payload: { relativePath: "src/foo.ts", git: { file: { commitCount: 27, bugFixRate: 42 } } },
      rankingOverlay: {
        preset: "bugHunt",
        file: { commitCount: { value: 27, label: "high" }, churnVolatility: { value: 3.26, label: "stable" } },
      },
    };
    const out = applyEssentialSignals(result, ["git.file.commitCount"]);
    expect((out.payload as any).git).toEqual({ file: { commitCount: 27 } });
    expect(out.payload).not.toHaveProperty("preset");
  });

  it("leaves payload unchanged when no essential keys", () => {
    const result = buildResult({ commitCount: 5 });
    expect(applyEssentialSignals(result, [])).toBe(result);
  });

  it("leaves payload unchanged when no essential keys even if the hit is reranked", () => {
    const result: SearchResult = {
      ...buildResult({ commitCount: 5 }),
      rankingOverlay: { preset: "hotspots", file: { commitCount: { value: 5, label: "low" } } },
    };
    expect(applyEssentialSignals(result, [])).toBe(result);
  });

  it("drops namespace entirely when no essential fields match", () => {
    const result = buildResult({ recentDominantAuthor: "x", enrichedAt: "y" });
    const out = applyEssentialSignals(result, ["git.file.commitCount"]); // no match
    expect((out.payload as any).git).toBeUndefined();
    expect(out.payload?.relativePath).toBe("src/foo.ts"); // non-git preserved
  });

  it("ignores keys with fewer than 3 segments (flat fields handled elsewhere)", () => {
    const result = buildResult({ commitCount: 5 });
    const out = applyEssentialSignals(result, ["imports", "methodLines"]);
    // Flat keys produce no namespace groups → payload passes through
    // unchanged. Flat-field preservation is the caller's concern (e.g.
    // filterMetaOnly already iterates payloadSignals).
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
    const out = applyEssentialSignals(result, ["runtime.file.memoryMb", "runtime.file.cpuPct"]);
    const { runtime } = out.payload as any;
    expect(Object.keys(runtime.file).sort()).toEqual(["cpuPct", "memoryMb"]);
    expect(runtime.file.debugTrace).toBeUndefined();
    expect(runtime.file.internalId).toBeUndefined();
  });

  it("writes no namespace from the overlay when the payload lacks it", () => {
    const result: SearchResult = {
      score: 0.9,
      payload: { relativePath: "src/foo.ts" }, // no git in payload
      rankingOverlay: {
        preset: "hotspots",
        file: { bugFixRate: { value: 10, label: "healthy" } },
      },
    };
    const out = applyEssentialSignals(result, ["git.file.commitCount"]);
    expect((out.payload as any).git).toBeUndefined();
    expect(out.payload).not.toHaveProperty("preset");
  });
});
