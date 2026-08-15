/**
 * `buildChunkSignals` writes the symbol → covering-chunk join ONCE for the whole
 * pass, not once per file (bd tea-rags-mcp-6aytq).
 *
 * The deferred chunk pass is a single call carrying the run's entire chunkMap —
 * 10,478 files on taxdome. Issuing the join inside the per-file loop turned that
 * into 10,478 daemon round-trips, each opening its own transaction: the whole
 * measured 14.0s `deferredChunk` step of the completion tail, against a 0.21s
 * bulk read of the same graph. The join set is known only after the loop has
 * resolved every file's symbols, so it is collected there and written after.
 *
 * The overlays the pass returns are unaffected — this pins the write shape and
 * that the join still lands for every file in the map.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { SymbolId } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

describe("CodegraphEnrichmentProvider.buildChunkSignals — symbol/chunk join write shape", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-join-bulk-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
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

  /** Feed the provider three walked files so its line map covers all of them. */
  async function walkThreeFiles(): Promise<void> {
    const sink = provider.asExtractionSink();
    for (const name of ["a", "b", "c"]) {
      await sink.write({
        relPath: `src/${name}.ts`,
        language: "typescript",
        imports: [],
        chunks: [{ symbolId: `${name.toUpperCase()}#run`, scope: [], calls: [], startLine: 1, endLine: 5 }],
        fileScope: [],
      });
    }
    await sink.finish();
  }

  it("issues ONE join write for a multi-file pass, not one per file", async () => {
    await walkThreeFiles();
    const bulk = vi.spyOn(client, "updateSymbolChunkIdsBulk");
    const perFile = vi.spyOn(client, "updateSymbolChunkIds");

    const chunkMap = new Map([
      ["src/a.ts", [{ chunkId: "chunk-a", startLine: 1, endLine: 5 }]],
      ["src/b.ts", [{ chunkId: "chunk-b", startLine: 1, endLine: 5 }]],
      ["src/c.ts", [{ chunkId: "chunk-c", startLine: 1, endLine: 5 }]],
    ]);
    await provider.buildChunkSignals("/", chunkMap);

    expect(perFile).not.toHaveBeenCalled();
    expect(bulk).toHaveBeenCalledTimes(1);
    expect(bulk.mock.calls[0][0].map((e) => e.relPath)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("still joins every file's symbol to its covering chunk", async () => {
    await walkThreeFiles();

    await provider.buildChunkSignals(
      "/",
      new Map([
        ["src/a.ts", [{ chunkId: "chunk-a", startLine: 1, endLine: 5 }]],
        ["src/c.ts", [{ chunkId: "chunk-c", startLine: 1, endLine: 5 }]],
      ]),
    );

    expect(await client.findSymbolChunk("A#run" as SymbolId)).toEqual({
      relPath: "src/a.ts",
      chunkId: "chunk-a",
    });
    expect(await client.findSymbolChunk("C#run" as SymbolId)).toEqual({
      relPath: "src/c.ts",
      chunkId: "chunk-c",
    });
    // Walked but absent from the chunkMap — nothing to join. Read the row
    // directly: findSymbolChunk's last-segment tier would answer with a
    // same-tailed neighbour's chunk and hide an unjoined row.
    const unjoined = await client.queryAll<{ chunk_id: string | null }>(
      "SELECT chunk_id FROM cg_symbols WHERE symbol_id = 'B#run'",
    );
    expect(unjoined).toEqual([{ chunk_id: null }]);
  });

  it("writes nothing when no file in the pass produced a join", async () => {
    const bulk = vi.spyOn(client, "updateSymbolChunkIdsBulk");

    // No file was walked, so the provider holds no line map to invert.
    await provider.buildChunkSignals("/", new Map([["src/unwalked.ts", [{ chunkId: "x", startLine: 1, endLine: 2 }]]]));

    expect(bulk).not.toHaveBeenCalled();
  });
});
