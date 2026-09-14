/**
 * The deferred chunk pass maps each stored chunk to its owning symbol through
 * the shared chunk-owner rule (bd tea-rags-mcp-9i2ow).
 *
 * The pass used to take the greatest walker symbol START at or before the
 * chunk's start and never look at the end. On the self-index that put the
 * `#part2` chunk 1093-1115 of `collectPythonImports` on the nested
 * `collectPythonImports.reexport` (1075-1077), which does not contain it. The
 * signals under test are told apart by PageRank, written straight into
 * `cg_symbols_metrics` after the walk, so the assertion names the owner rather
 * than depending on resolver heuristics.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { ChunkExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { ChunkLookupEntry } from "../../../../../../src/core/contracts/types/provider.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const REL = "src/walker.ts";

function chunk(symbolId: string, startLine: number, endLine: number): ChunkExtraction {
  return { symbolId, scope: [], calls: [], startLine, endLine };
}

describe("CodegraphEnrichmentProvider.buildChunkSignals — chunk owner (bd tea-rags-mcp-9i2ow)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-chunk-owner-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Walk one file, then give each symbol a distinguishable PageRank. */
  async function walk(chunks: ChunkExtraction[], ranks: Record<string, number>): Promise<void> {
    const sink = provider.asExtractionSink();
    await sink.write({ relPath: REL, language: "typescript", imports: [], chunks, fileScope: [] });
    await sink.finish();
    await client.replacePageRanks(new Map(Object.entries(ranks)));
  }

  async function pageRankOf(entry: ChunkLookupEntry): Promise<number | undefined> {
    const overlays = await provider.buildChunkSignals("/", new Map([[REL, [entry]]]));
    return overlays.get(REL)?.get(entry.chunkId)?.["pageRank"] as number | undefined;
  }

  const IMPORTS = [chunk("collectPythonImports", 1033, 1140), chunk("collectPythonImports.reexport", 1075, 1077)];
  const IMPORTS_RANKS = { collectPythonImports: 0.1, "collectPythonImports.reexport": 0.3 };

  it("keeps a later `#part` chunk on the outer function, not on a nested symbol that ended above it", async () => {
    await walk(IMPORTS, IMPORTS_RANKS);

    expect(
      await pageRankOf({ chunkId: "p2", startLine: 1093, endLine: 1115, symbolId: "collectPythonImports#part2" }),
    ).toBe(0.1);
  });

  it("maps the same span with no chunker symbolId to the innermost symbol containing it", async () => {
    await walk(IMPORTS, IMPORTS_RANKS);

    expect(await pageRankOf({ chunkId: "blk", startLine: 1093, endLine: 1115 })).toBe(0.1);
  });

  it("narrows an outer-anchored chunk to the nested function that contains its start", async () => {
    await walk(
      [chunk("collectPythonInheritanceEdges", 240, 320), chunk("collectPythonInheritanceEdges.walkScope", 257, 300)],
      { collectPythonInheritanceEdges: 0.1, "collectPythonInheritanceEdges.walkScope": 0.3 },
    );

    expect(
      await pageRankOf({ chunkId: "p3", startLine: 282, endLine: 303, symbolId: "collectPythonInheritanceEdges" }),
    ).toBe(0.3);
  });

  it("keeps a primary chunk whose leading comment starts above the method on the method", async () => {
    await walk([chunk("helper", 1, 8), chunk("Foo#bar", 12, 30)], { helper: 0.1, "Foo#bar": 0.3 });

    expect(await pageRankOf({ chunkId: "m", startLine: 10, endLine: 30, symbolId: "Foo#bar" })).toBe(0.3);
  });

  it("persists every walked symbol's line range on cg_symbols", async () => {
    await walk(IMPORTS, IMPORTS_RANKS);

    const byId = new Map((await client.listAllSymbols()).map((d) => [d.symbolId, d]));
    expect(byId.get("collectPythonImports")).toMatchObject({ startLine: 1033, endLine: 1140 });
    expect(byId.get("collectPythonImports.reexport")).toMatchObject({ startLine: 1075, endLine: 1077 });
  });
});
