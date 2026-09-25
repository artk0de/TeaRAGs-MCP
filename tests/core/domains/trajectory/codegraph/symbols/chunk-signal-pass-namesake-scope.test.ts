/**
 * The deferred chunk pass places a chunk's signals by `(relPath, symbolId)`,
 * so two namesake symbols in different files get their OWN fan numbers
 * (bd tea-rags-mcp-xtdkq).
 *
 * The adapter half — the grouping that stopped merging namesakes — is
 * `tests/core/adapters/duckdb/chunk-signals-bulk-namesake-scope.test.ts`. This
 * one pins the seam above it: the pass must look the bulk map up under the file
 * it is settling, or the scoped read is thrown away one call later and every
 * top-level `main` reads all-zero instead of merged, which is not an
 * improvement.
 */
import ignore from "ignore";
import { describe, expect, it } from "vitest";

import {
  fileScopedSymbolKey,
  type ChunkGraphSignals,
  type FileScopedSymbolId,
  type GraphDbClient,
  type SymbolChunkIdJoinEntry,
  type SymbolLineRange,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { ChunkLookupEntry } from "../../../../../../src/core/contracts/types/provider.js";
import { CodegraphChunkSignalPass } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/chunk-signal-pass.js";

const COLL = "code_namesake";
const BENCH = "scripts/bench-onnx.ts";
const GATE = "scripts/cochange-forgotten-change-gate.ts";

/** Both scripts declare a top-level `main` at the same lines — the id is identical, the symbol is not. */
const RANGES: SymbolLineRange[] = [{ symbolId: "main", startLine: 10, endLine: 40 }];

const CHUNKS: ChunkLookupEntry[] = [{ chunkId: "c", startLine: 10, endLine: 40, symbolId: "main" }];

const SIGNALS = new Map<FileScopedSymbolId, ChunkGraphSignals>([
  [fileScopedSymbolKey({ relPath: BENCH, symbolId: "main" }), { fanIn: 0, fanOut: 2, pageRank: 0.01 }],
  [fileScopedSymbolKey({ relPath: GATE, symbolId: "main" }), { fanIn: 0, fanOut: 3, pageRank: 0.02 }],
]);

function graphDbStub(): GraphDbClient {
  return {
    getChunkSignalsBulk: async () => Promise.resolve(SIGNALS),
    updateSymbolChunkIdsBulk: async (_entries: SymbolChunkIdJoinEntry[]) => Promise.resolve(),
  } as unknown as GraphDbClient;
}

describe("CodegraphChunkSignalPass — namesake scoping (bd tea-rags-mcp-xtdkq)", () => {
  it("gives each file's `main` the signals of its own declaration", async () => {
    const walkRanges = new Map<string, Map<string, SymbolLineRange[]>>([
      [
        COLL,
        new Map([
          [BENCH, RANGES],
          [GATE, RANGES],
        ]),
      ],
    ]);
    const pass = new CodegraphChunkSignalPass(walkRanges, ignore());

    const overlays = await pass.build(
      graphDbStub(),
      new Map([
        [BENCH, CHUNKS],
        [GATE, CHUNKS],
      ]),
      COLL,
    );

    expect(overlays.get(BENCH)?.get("c")).toEqual({ fanIn: 0, fanOut: 2, pageRank: 0.01 });
    expect(overlays.get(GATE)?.get("c")).toEqual({ fanIn: 0, fanOut: 3, pageRank: 0.02 });
  });
});
