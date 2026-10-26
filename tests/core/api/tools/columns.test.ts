import { describe, expect, it } from "vitest";

import { foldColumnTables, tabulateRecordArrays, toColumns } from "../../../../src/core/api/tools/columns.js";
import { resolvePresets } from "../../../../src/core/domains/explore/rerank/presets/index.js";
import { Reranker } from "../../../../src/core/domains/explore/reranker.js";
import { gitPayloadSignalDescriptors } from "../../../../src/core/domains/trajectory/git/payload-signals.js";
import { gitDerivedSignals } from "../../../../src/core/domains/trajectory/git/rerank/derived-signals/index.js";
import { GIT_PRESETS } from "../../../../src/core/domains/trajectory/git/rerank/presets/index.js";
import { rowsOf } from "../../../helpers/column-table.js";

/** What the MCP transport actually carries: undefined-valued keys vanish. */
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("toColumns", () => {
  it("flattens nested plain objects into dotted columns in first-seen order", () => {
    const table = toColumns([{ id: "a", payload: { relativePath: "x.ts", git: { file: { commitCount: 3 } } } }]);

    expect(table).toEqual({
      columns: ["id", "payload.relativePath", "payload.git.file.commitCount"],
      rows: [["a", "x.ts", 3]],
    });
  });

  it("unions keys across records and fills a key a record lacks with null", () => {
    const table = toColumns([
      { relativePath: "a.ts", callWeight: 2 },
      { relativePath: "b.ts", callWeight: 1, modelCallWeight: 0.8 },
    ]);

    expect(table).toEqual({
      columns: ["relativePath", "callWeight", "modelCallWeight"],
      rows: [
        ["a.ts", 2, null],
        ["b.ts", 1, 0.8],
      ],
    });
  });

  // bd tea-rags-mcp-e6es3: null = absent, so a column absent from every row is
  // pure header cost — it goes; a column some row fills stays.
  it("omits a column whose every row is null or absent, and keeps a mixed one", () => {
    const table = toColumns([
      { id: "a", rankingOverlay: undefined, symbolId: "A#run", note: null },
      { id: "b", rankingOverlay: undefined, note: null },
    ]);

    expect(table).toEqual({
      columns: ["id", "symbolId"],
      rows: [
        ["a", "A#run"],
        ["b", null],
      ],
    });
  });

  it("keeps arrays as cell values and leaves objects inside arrays unflattened", () => {
    const table = toColumns([{ taskIds: ["T-1"], headingPath: [{ depth: 2, text: "Intro" }] }]);

    expect(table).toEqual({
      columns: ["taskIds", "headingPath"],
      rows: [[["T-1"], [{ depth: 2, text: "Intro" }]]],
    });
  });

  it("turns no records into an empty table", () => {
    expect(toColumns([])).toEqual({ columns: [], rows: [] });
  });

  it("round-trips a real reranked result", async () => {
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
        {
          id: "chunk-2",
          score: 0.6,
          payload: { relativePath: "src/api.ts", startLine: 4, endLine: 9, language: "typescript" },
        },
      ],
      "hotspots",
      "semantic_search",
    );
    const records = overTheWire(ranked) as unknown as Record<string, unknown>[];

    expect(rowsOf(toColumns(records))).toEqual(records);
  });
});

describe("tabulateRecordArrays", () => {
  it("turns an array of two or more plain objects into a table at any depth", () => {
    const value = { relativePath: "a.ts", graph: { importers: [{ path: "b.ts" }, { path: "c.ts" }] } };

    expect(tabulateRecordArrays(value)).toEqual({
      relativePath: "a.ts",
      graph: { importers: { columns: ["path"], rows: [["b.ts"], ["c.ts"]] } },
    });
  });

  it("leaves a one-record array and an array of scalars as they are", () => {
    const value = { callers: [{ symbolId: "A#run" }], taskIds: ["T-1", "T-2"] };

    expect(tabulateRecordArrays(value)).toEqual(value);
  });

  it("leaves arrays inside a table cell as cell values", () => {
    const value = [
      { id: "a", steps: [{ symbolId: "A" }, { symbolId: "B" }] },
      { id: "b", steps: [] },
    ];

    expect(tabulateRecordArrays(value)).toEqual({
      columns: ["id", "steps"],
      rows: [
        ["a", [{ symbolId: "A" }, { symbolId: "B" }]],
        ["b", []],
      ],
    });
  });
});

describe("foldColumnTables", () => {
  it("folds every column table at any depth back into the records it was built from", () => {
    const dto = {
      total: 2,
      callers: [
        { sourceSymbolId: "A#run", edge: { kind: "exact", confidence: 1 } },
        { sourceSymbolId: "B#run", tags: ["x", "y"] },
      ],
      meta: {
        topAuthors: [
          { name: "a", commits: 3 },
          { name: "b", commits: 1 },
        ],
        note: "n",
      },
    };

    expect(foldColumnTables(tabulateRecordArrays(dto))).toEqual(dto);
  });

  it("leaves a value that holds no table unchanged", () => {
    const value = { results: [{ id: "a", score: 1 }], scalar: 3, list: [1, 2] };

    expect(foldColumnTables(value)).toEqual(value);
  });
});
