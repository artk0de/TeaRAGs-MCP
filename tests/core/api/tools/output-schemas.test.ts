import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { WorkingTreeMarker } from "../../../../src/core/api/public/dto/working-tree.js";
import { BODY_SHOWN_BANNER, SEARCH_ANCHOR_BANNER } from "../../../../src/core/api/tools/answer-banner.js";
import { toColumns, type ColumnTable } from "../../../../src/core/api/tools/columns.js";
import { compactWorkingTreeMarker } from "../../../../src/core/api/tools/format.js";
import {
  FindSymbolResultItemSchema,
  SearchResultItemSchema,
  SearchResultOutputSchema,
} from "../../../../src/core/api/tools/output-schemas.js";
import { CodeChunkGrouper } from "../../../../src/core/domains/explore/chunk-grouping/code.js";
import { collectReferencedDefinitions } from "../../../../src/core/domains/explore/referenced-definitions.js";
import { resolvePresets } from "../../../../src/core/domains/explore/rerank/presets/index.js";
import { Reranker } from "../../../../src/core/domains/explore/reranker.js";
import { resolveSymbols } from "../../../../src/core/domains/explore/symbol-resolve.js";
import { foldRailsTableMigrations } from "../../../../src/core/domains/language/index.js";
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

  // PIN-UPDATED q1g6s.16: a search tool's default row carries no id / score, so neither is required.
  it("accepts an item without id and score — a search tool's default row", () => {
    const row = { payload: { relativePath: "src/a.ts", symbolId: "A#run", startLine: 1, endLine: 9 } };
    expect(items.parse([row])).toEqual([row]);
    expect(() => items.parse([{ id: { nested: true } }])).toThrow();
  });

  it("accepts the column table of default search rows, every row a valid item", () => {
    const table = overTheWire(
      toColumns([{ payload: { relativePath: "src/a.ts", symbolId: "A#run", startLine: 1, endLine: 9, content: "x" } }]),
    );

    const parsed = schema.parse({ results: table });

    expect(items.parse(rowsOf(asTable(parsed.results)))).toHaveLength(1);
  });

  // nknkg.3: Claude Code shows the model structuredContent instead of content, so a
  // decision-point answer carries its banner as the FIRST structuredContent key.
  it("declares the answer banner: kept on parse, first key, strict parse passes", () => {
    const bannered = { banner: SEARCH_ANCHOR_BANNER, results: [{ payload: { symbolId: "A#run" } }] };

    const parsed = schema.parse(bannered);

    expect(Object.keys(parsed)[0]).toBe("banner");
    expect(parsed.banner).toBe(SEARCH_ANCHOR_BANNER);
    expect(schema.strict().safeParse(bannered).success).toBe(true);
    expect(schema.strict().safeParse({ ...bannered, banner: BODY_SHOWN_BANNER }).success).toBe(true);
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

  // bd tea-rags-mcp-d0z7b.4: a method row's referencedDefinitions is a declared optional payload key.
  it("declares find_symbol's referencedDefinitions and accepts the rows the collector builds", () => {
    const findSymbolItems = z.array(FindSymbolResultItemSchema);
    expect(Object.keys(FindSymbolResultItemSchema.shape.payload.unwrap().shape)).toContain("referencedDefinitions");
    // Declared on find_symbol alone: the other search tools never emit it.
    expect(Object.keys(SearchResultItemSchema.shape.payload.unwrap().shape)).not.toContain("referencedDefinitions");

    const definitions = collectReferencedDefinitions({
      body: "def previewable?\n  ext.match?(Doc::PREVIEWABLE)\nend",
      ownerSymbolId: "Doc",
      headerChunks: [
        {
          id: "h",
          payload: {
            symbolId: "Doc",
            parentSymbolId: "Doc",
            chunkType: "block",
            startLine: 2,
            endLine: 2,
            memberSymbolIds: ["Doc::PREVIEWABLE"],
          },
        },
      ],
      treeText: "class Doc\n  PREVIEWABLE = /pdf/\nend",
    });
    const [row] = overTheWire([{ payload: { symbolId: "Doc#previewable?", referencedDefinitions: definitions } }]);
    expect(findSymbolItems.parse([row])).toEqual([row]);
    expect(() =>
      findSymbolItems.parse([
        { payload: { referencedDefinitions: [{ symbolId: "Doc::X", startLine: "2", endLine: 2 }] } },
      ]),
    ).toThrow();
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

  // PIN-UPDATED 68jud: search answers carry no drift — get_index_status / prime report it.
  it("declares no driftWarning", () => {
    expect(SearchResultOutputSchema).not.toHaveProperty("driftWarning");
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

// Agent turn economy N6 (bd tea-rags-mcp-wrosj).
describe("SearchResultOutputSchema — empty answer explanation", () => {
  const schema = z.object(SearchResultOutputSchema);

  it("keeps the empty-answer reason, message and suggestions", () => {
    const empty = { reason: "pathPatternMatchesNothing", message: "no file", suggestions: ["src/core/**"] };
    expect(schema.parse({ results: EMPTY_TABLE, empty }).empty).toEqual(empty);
  });
});

describe("SearchResultOutputSchema — workingTree (xi2r9.1)", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("validates a measured marker and a degraded one", () => {
    const measured: WorkingTreeMarker = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: null,
      indexedDirty: true,
      changedFiles: 0,
      deletedFiles: 0,
      floors: [],
    };
    const degraded: WorkingTreeMarker = {
      ...measured,
      indexedCommit: null,
      degraded: { reason: "index has no indexedCommit stamp", remedy: "tea-rags index-codebase --project p" },
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: compactWorkingTreeMarker(measured) }).workingTree).toEqual(
      compactWorkingTreeMarker(measured),
    );
    expect(schema.parse({ results: EMPTY_TABLE, workingTree: compactWorkingTreeMarker(degraded) }).workingTree).toEqual(
      compactWorkingTreeMarker(degraded),
    );
  });

  // bd tea-rags-mcp-45kbu: a clean answer's marker is compacted at the MCP
  // boundary; the schema the SDK validates against must accept that form.
  it("validates the compact marker of a clean answer", () => {
    const compact = compactWorkingTreeMarker({
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: "a".repeat(40),
      indexedDirty: false,
      changedFiles: 0,
      deletedFiles: 0,
      floors: [],
      project: "p",
    });

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: compact }).workingTree).toEqual({
      tree: "/repo/wt",
      project: "p",
    });
  });
});

describe("SearchResultOutputSchema — workingTree wire keys (q1g6s.15)", () => {
  it("declares no floors, commits or indexedDirty and leaves changedFiles optional", () => {
    const marker = SearchResultOutputSchema.workingTree.unwrap();
    const keys = Object.keys(marker.shape);

    expect(keys.filter((key) => ["floors", "indexedCommit", "treeCommit", "indexedDirty"].includes(key))).toEqual([]);
    expect(marker.shape.changedFiles.isOptional()).toBe(true);
  });
});

describe("SearchResultOutputSchema — workingTree dense floor (WTO-5)", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("validates the dense floor and the reason some rows were ranked without it", () => {
    const marker: WorkingTreeMarker = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: "b".repeat(40),
      indexedDirty: false,
      changedFiles: 2,
      deletedFiles: 0,
      floors: ["chunks", "sparse", "dense"],
      denseUnavailable: { reason: "3 rows pending" },
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: compactWorkingTreeMarker(marker) }).workingTree).toEqual(
      compactWorkingTreeMarker(marker),
    );
  });
});

describe("SearchResultOutputSchema — workingTree git signals pending", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("keeps gitUnavailable on the marker", () => {
    const marker: WorkingTreeMarker = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: "b".repeat(40),
      indexedDirty: false,
      changedFiles: 2,
      deletedFiles: 0,
      floors: ["chunks", "sparse"],
      gitUnavailable: { reason: "1 row pending" },
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: compactWorkingTreeMarker(marker) }).workingTree).toEqual(
      compactWorkingTreeMarker(marker),
    );
  });
});

describe("SearchResultOutputSchema — workingTree index-only files", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("keeps indexOnlyFiles on the marker", () => {
    const marker: WorkingTreeMarker = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: "b".repeat(40),
      indexedDirty: false,
      changedFiles: 4,
      deletedFiles: 0,
      floors: ["chunks"],
      indexOnlyFiles: 3,
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: compactWorkingTreeMarker(marker) }).workingTree).toEqual(
      compactWorkingTreeMarker(marker),
    );
  });
});

describe("SearchResultOutputSchema — workingTree pending files", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("keeps pendingFiles on the marker", () => {
    const marker: WorkingTreeMarker = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: "b".repeat(40),
      indexedDirty: false,
      changedFiles: 4,
      deletedFiles: 0,
      floors: ["chunks"],
      pendingFiles: 2,
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: compactWorkingTreeMarker(marker) }).workingTree).toEqual(
      compactWorkingTreeMarker(marker),
    );
  });
});

describe("SearchResultOutputSchema — dense leg unavailable", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("validates the top-level denseUnavailable a BM25-only hybrid answer carries", () => {
    const denseUnavailable = { reason: "No llama-server endpoint is reachable at http://127.0.0.1:9" };

    expect(schema.parse({ results: EMPTY_TABLE, denseUnavailable }).denseUnavailable).toEqual(denseUnavailable);
  });
});

// PIN-UPDATED icujw: N5 (bd tea-rags-mcp-r4rl1) expansion hints retired — followed 0 of 18 times.
// Pagination keeps `truncated.next`; the top-level hint list is gone.
describe("SearchResultOutputSchema — next expansion hints", () => {
  it("declares no top-level next, keeps truncated.next", () => {
    expect(SearchResultOutputSchema).not.toHaveProperty("next");
    expect(SearchResultOutputSchema.truncated.unwrap().shape).toHaveProperty("next");
  });
});

describe("SearchResultOutputSchema — workingTree answering alias (iqx9x)", () => {
  const schema = z.object(SearchResultOutputSchema).strict();

  it("keeps project on the marker", () => {
    const marker: WorkingTreeMarker = {
      tree: "/repo/wt",
      indexedCommit: "a".repeat(40),
      treeCommit: "b".repeat(40),
      indexedDirty: false,
      changedFiles: 0,
      deletedFiles: 0,
      floors: [],
      project: "proj",
    };

    expect(schema.parse({ results: EMPTY_TABLE, workingTree: compactWorkingTreeMarker(marker) }).workingTree).toEqual(
      compactWorkingTreeMarker(marker),
    );
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

  it("keeps the nearest-path suggestions of an unknown path entry (q1g6s.4)", () => {
    const missing = [{ request: "src/nope.ts", message: "unknown path", suggestions: ["src/a/x.ts"] }];

    expect(schema.parse({ results: EMPTY_TABLE, missing }).missing).toEqual(missing);
  });

  it("validates the batch notice of a downgraded or refused path entry (yz10n)", () => {
    const batchNotice = "paths answer as outline in a batch";

    expect(schema.parse({ results: EMPTY_TABLE, batchNotice }).batchNotice).toBe(batchNotice);
  });
});

describe("SearchResultOutputSchema — find_symbol table:<name> (nplgm)", () => {
  const operation = (version: string, name: string, content: string) => ({
    symbolId: `migration:db/migrate/${version}_orders.rb:${name}:1`,
    version,
    operation: name,
    direction: "change",
    table: "orders",
    columns: [],
    content,
  });
  const schema = z.object(SearchResultOutputSchema).strict();

  it("strictly accepts a real fold result carrying renames, indexes, foreign keys and unfolded ops", () => {
    const table = foldRailsTableMigrations("orders", [
      operation(
        "1",
        "create_table",
        "create_table :orders do |t|\n  t.references :user, foreign_key: true\n  t.string :code\n  t.send(:x)\nend",
      ),
      operation("2", "rename_column", "rename_column :orders, :code, :reference"),
      operation("3", "add_index", "add_index :orders, :reference, unique: true, name: 'idx_a'"),
      operation("4", "rename_index", "rename_index :orders, 'idx_a', 'idx_b'"),
    ]);

    expect(table.columns.find((column) => column.name === "reference")?.renamedFrom).toBe("code");
    expect(table.indexes.find((index) => index.name === "idx_b")?.renamedFrom).toBe("idx_a");
    expect(table.foreignKeys).toHaveLength(1);
    expect(table.unfolded).toHaveLength(1);
    expect(schema.parse(overTheWire({ results: EMPTY_TABLE, table })).table).toEqual(table);
  });

  it("strictly accepts a partial index predicate and foreign key actions (7dcty.3)", () => {
    const table = foldRailsTableMigrations("orders", [
      operation(
        "1",
        "create_table",
        "create_table :orders do |t|\n  t.references :user, foreign_key: { on_delete: :cascade, on_update: :restrict }\nend",
      ),
      operation("2", "add_index", "add_index :orders, :user_id, where: 'status = 1', name: 'idx_p'"),
    ]);

    expect(table.indexes.find((index) => index.name === "idx_p")?.where).toBe("status = 1");
    expect(table.foreignKeys[0]).toMatchObject({ onDelete: "cascade", onUpdate: "restrict" });
    expect(schema.parse(overTheWire({ results: EMPTY_TABLE, table })).table).toEqual(table);
  });

  it("strictly accepts a dropped table", () => {
    const table = foldRailsTableMigrations("orders", [
      operation("1", "create_table", "create_table :orders do |t|\nend"),
      operation("2", "rename_table", "rename_table :orders, :purchases"),
    ]);

    expect(table.dropped?.renamedTo).toBe("purchases");
    expect(schema.parse(overTheWire({ results: EMPTY_TABLE, table })).table).toEqual(table);
  });
});
