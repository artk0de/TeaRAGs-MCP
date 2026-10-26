import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toColumns, type ColumnTable } from "../../../../src/core/api/tools/columns.js";
import { SearchResultItemSchema, SearchResultOutputSchema } from "../../../../src/core/api/tools/output-schemas.js";
import { CodeChunkGrouper } from "../../../../src/core/domains/explore/chunk-grouping/code.js";
import { resolvePresets } from "../../../../src/core/domains/explore/rerank/presets/index.js";
import { Reranker } from "../../../../src/core/domains/explore/reranker.js";
import { resolveSymbols } from "../../../../src/core/domains/explore/symbol-resolve.js";
import { gitPayloadSignalDescriptors } from "../../../../src/core/domains/trajectory/git/payload-signals.js";
import { gitDerivedSignals } from "../../../../src/core/domains/trajectory/git/rerank/derived-signals/index.js";
import { GIT_PRESETS } from "../../../../src/core/domains/trajectory/git/rerank/presets/index.js";
import { rowsOf } from "../../../helpers/column-table.js";

/** What the MCP transport actually carries: undefined-valued keys vanish. */
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const EMPTY_TABLE = { columns: [], rows: [] };

/** `results` is the table branch of the union in these cases. */
function asTable(results: unknown): ColumnTable {
  return results as ColumnTable;
}

describe("SearchResultOutputSchema", () => {
  const schema = z.object(SearchResultOutputSchema);
  const items = z.array(SearchResultItemSchema);

  // bd tea-rags-mcp-nb32e: the item schema declared relativePath / startLine /
  // content / git at item level and passed only through `.passthrough()`. Real
  // items are SearchResult { id, score, payload?, rankingOverlay? } — chunk
  // fields live INSIDE payload.
  it("declares the item shape tools return: id, score, payload, rankingOverlay", () => {
    expect(Object.keys(SearchResultItemSchema.shape).sort()).toEqual([
      "id",
      "payload",
      "rankingOverlay",
      "score",
      "treeState",
    ]);
  });

  it("requires id and score on every item", () => {
    expect(() => items.parse([{ score: 0.8 }])).toThrow();
    expect(() => items.parse([{ id: "a" }])).toThrow();
  });

  it("validates a minimal search result", () => {
    const result = items.parse([
      {
        id: "uuid-1",
        score: 0.85,
        payload: { relativePath: "src/auth.ts", startLine: 10, endLine: 30, language: "typescript" },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.85);
    expect(result[0].payload?.relativePath).toBe("src/auth.ts");
  });

  it("keeps every payload key, declared or not (payload passthrough)", () => {
    const payload = {
      relativePath: "src/main.ts",
      content: "function main() {}",
      git: { file: { commitCount: 5, ageDays: 30 }, chunk: { commitCount: 2 } },
      codegraph: { symbols: { chunk: { fanIn: 3 } } },
      navigation: { prevSymbolId: "a", nextSymbolId: "b" },
    };
    const result = items.parse([{ id: 1, score: 0.7, payload }]);
    expect(result[0].payload).toEqual(payload);
  });

  // The overlay the reranker emits is RankingOverlay { preset, file?, chunk? } —
  // labelled values plus raw unlabelled ones. The declared schema must keep
  // both levels, since a metaOnly payload is raw and the overlay carries every label.
  it("keeps the rankingOverlay file and chunk levels the reranker emits", () => {
    const overlay = {
      preset: "techDebt",
      file: { commitCount: { value: 37, label: "extreme" }, imports: ["./a"] },
      chunk: { methodLines: { value: 120, label: "decomposition_candidate" } },
    };
    const result = items.parse([{ id: "x", score: 0.9, rankingOverlay: overlay }]);
    expect(result[0].rankingOverlay).toEqual(overlay);
  });

  it("accepts a real reranked strategy result unchanged", async () => {
    const reranker = new Reranker(gitDerivedSignals, resolvePresets([...GIT_PRESETS], []), gitPayloadSignalDescriptors);
    const ranked = await reranker.rerank(
      [
        {
          id: "chunk-1",
          score: 0.8,
          payload: {
            relativePath: "src/db.ts",
            startLine: 1,
            endLine: 50,
            language: "typescript",
            chunkType: "function",
            git: { file: { commitCount: 30, bugFixRate: 40 }, chunk: { commitCount: 8, churnRatio: 0.4 } },
          },
        },
      ],
      "hotspots",
      "semantic_search",
    );
    const results = overTheWire(ranked);
    expect(results[0].rankingOverlay).toBeDefined();

    expect(items.parse(results)).toEqual(results);
  });

  it("accepts a real reranked result as the column table tools emit, every row a valid item", async () => {
    const reranker = new Reranker(gitDerivedSignals, resolvePresets([...GIT_PRESETS], []), gitPayloadSignalDescriptors);
    const ranked = await reranker.rerank(
      [
        {
          id: "chunk-1",
          score: 0.8,
          payload: {
            relativePath: "src/db.ts",
            language: "typescript",
            git: { file: { commitCount: 30, bugFixRate: 40 }, chunk: { commitCount: 8, churnRatio: 0.4 } },
          },
        },
        { id: "chunk-2", score: 0.5, payload: { relativePath: "src/api.ts", language: "typescript" } },
      ],
      "hotspots",
      "semantic_search",
    );
    const table = overTheWire(toColumns(ranked));

    const parsed = schema.parse({ results: table });

    expect(parsed.results).toEqual(table);
    expect(asTable(parsed.results).columns).toEqual(expect.arrayContaining(["id", "score", "payload.relativePath"]));
    expect(items.parse(rowsOf(asTable(parsed.results)))).toHaveLength(2);
  });

  it("accepts a one-result answer as a records list beside the table form", () => {
    const record = overTheWire({ id: "chunk-1", score: 0.8, payload: { relativePath: "src/db.ts" } });

    expect(schema.parse({ results: [record] }).results).toEqual([record]);
    expect(schema.parse({ results: [] }).results).toEqual([]);
  });

  it("accepts find_symbol's synthetic results (mergedChunkIds, chunkCount) unchanged", () => {
    const merged = resolveSymbols([
      {
        id: "uuid-1",
        payload: {
          symbolId: "processData",
          chunkType: "function",
          relativePath: "src/processor.ts",
          content: "function processData() {",
          startLine: 10,
          endLine: 20,
          language: "typescript",
        },
      },
      {
        id: "uuid-2",
        payload: {
          symbolId: "processData",
          chunkType: "function",
          relativePath: "src/processor.ts",
          content: "  return 1;\n}",
          startLine: 21,
          endLine: 25,
          language: "typescript",
        },
      },
    ]);
    const outline = CodeChunkGrouper.groupMembers("Processor", [
      {
        id: 7,
        payload: {
          symbolId: "Processor#run",
          name: "run",
          chunkType: "function",
          parentSymbolId: "Processor",
          relativePath: "src/processor.ts",
          language: "typescript",
          startLine: 3,
          endLine: 9,
          content: "run() {}",
        },
      },
    ]);
    const results = overTheWire([...merged, outline]);
    expect(results[0].payload?.mergedChunkIds).toEqual(["uuid-1", "uuid-2"]);
    expect(results[1].payload?.chunkCount).toBe(1);

    expect(items.parse(results)).toEqual(results);
  });

  it("validates response with level field", () => {
    const result = schema.parse({
      results: EMPTY_TABLE,
      level: "file",
    });
    expect(result.level).toBe("file");
  });

  it("validates response with driftWarning", () => {
    const result = schema.parse({
      results: EMPTY_TABLE,
      driftWarning: "Index is 5 days old",
    });
    expect(result.driftWarning).toBe("Index is 5 days old");
  });

  it("validates empty results", () => {
    const result = schema.parse({ results: EMPTY_TABLE });
    expect(asTable(result.results).rows).toHaveLength(0);
  });

  it("rejects missing results field", () => {
    expect(() => schema.parse({})).toThrow();
  });

  it("validates response with codegraphWarning (a43tr)", () => {
    const result = schema.parse({
      results: EMPTY_TABLE,
      codegraphWarning: "codegraph fallback skipped [INFRA_CODEGRAPH_DAEMON_STALE_BUILD]",
    });
    expect(result.codegraphWarning).toBe("codegraph fallback skipped [INFRA_CODEGRAPH_DAEMON_STALE_BUILD]");
  });
});

describe("SearchResultOutputSchema — workingTree (xi2r9.1)", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("validates a measured marker and a degraded one", () => {
    const measured = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: null,
      indexedDirty: true,
      changedFiles: 0,
      deletedFiles: 0,
      floors: [],
    };
    const degraded = {
      ...measured,
      indexedCommit: null,
      degraded: { reason: "index has no indexedCommit stamp", remedy: "tea-rags index-codebase --project p" },
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: measured }).workingTree).toEqual(measured);
    expect(schema.parse({ results: EMPTY_TABLE, workingTree: degraded }).workingTree).toEqual(degraded);
  });
});

describe("SearchResultOutputSchema — workingTree dense floor (WTO-5)", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("validates the dense floor and the reason some rows were ranked without it", () => {
    const marker = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: "b".repeat(40),
      indexedDirty: false,
      changedFiles: 2,
      deletedFiles: 0,
      floors: ["chunks", "sparse", "dense"],
      denseUnavailable: { reason: "3 rows pending" },
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: marker }).workingTree).toEqual(marker);
  });
});

describe("SearchResultOutputSchema — workingTree git signals pending", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("keeps gitUnavailable on the marker", () => {
    const marker = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: "b".repeat(40),
      indexedDirty: false,
      changedFiles: 2,
      deletedFiles: 0,
      floors: ["chunks", "sparse"],
      gitUnavailable: { reason: "1 row pending" },
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: marker }).workingTree).toEqual(marker);
  });
});

describe("SearchResultOutputSchema — workingTree index-only files", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("keeps indexOnlyFiles on the marker", () => {
    const marker = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: "b".repeat(40),
      indexedDirty: false,
      changedFiles: 4,
      deletedFiles: 0,
      floors: ["chunks"],
      indexOnlyFiles: 3,
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: marker }).workingTree).toEqual(marker);
  });
});

describe("SearchResultOutputSchema — workingTree pending files", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("keeps pendingFiles on the marker", () => {
    const marker = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: "b".repeat(40),
      indexedDirty: false,
      changedFiles: 4,
      deletedFiles: 0,
      floors: ["chunks"],
      pendingFiles: 2,
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: marker }).workingTree).toEqual(marker);
  });
});

describe("SearchResultOutputSchema — dense leg unavailable", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("validates the top-level denseUnavailable a BM25-only hybrid answer carries", () => {
    const denseUnavailable = { reason: "No llama-server endpoint is reachable at http://127.0.0.1:9" };

    expect(schema.parse({ results: EMPTY_TABLE, denseUnavailable }).denseUnavailable).toEqual(denseUnavailable);
  });
});

describe("SearchResultOutputSchema — workingTree answering alias (iqx9x)", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("keeps project on the marker", () => {
    const marker = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: "b".repeat(40),
      indexedDirty: false,
      changedFiles: 0,
      deletedFiles: 0,
      floors: [],
      project: "proj",
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: marker }).workingTree).toEqual(marker);
  });
});

describe("SearchResultOutputSchema — find_symbol batch, directory and empty answers (N1, N2)", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("validates the miss list, the directory frame and the empty-answer explanation", () => {
    const missing = [
      { request: "Nope#x", message: "unknown symbol" },
      { request: "gone", message: "deleted", treeState: "deleted" },
    ];
    const directory = {
      kind: "directory",
      dir: "src/a",
      subdirs: [{ dir: "src/a/b", fileCount: 2 }],
      total: 3,
      truncated: false,
    };
    const empty = { reason: "unknownPath", message: "No indexed file", suggestions: ["src/a/x.ts"] };

    expect(schema.parse({ results: EMPTY_TABLE, missing, directory, empty })).toMatchObject({
      missing,
      directory,
      empty,
    });
  });
});
