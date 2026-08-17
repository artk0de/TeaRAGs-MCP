/**
 * bd tea-rags-mcp-tslvq — `buildChunkSignals` names every file it re-derived,
 * including the ones whose join came back empty.
 *
 * `cg_symbols` is written as a row diff now, so a re-walked symbol whose
 * definition did not change keeps the chunk_id it already had. The only thing
 * that can retire a stale id is the deferred chunk pass, and it can only retire
 * ids for files it NAMES. A file whose symbols all fell out of every chunk's
 * line range produces an empty mapping — which is precisely the case that must
 * still reach the writer, or the file keeps pointing at chunks that no longer
 * cover it.
 *
 * The walked-but-unchunked file is the other half of the contract: it was never
 * re-derived this pass, so its join is still valid and must not be named.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

describe("CodegraphEnrichmentProvider.buildChunkSignals — stale join retirement", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-join-replace-"));
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

  async function walk(names: readonly string[]): Promise<void> {
    const sink = provider.asExtractionSink();
    for (const name of names) {
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

  async function chunkIdOf(symbolId: string): Promise<string | null> {
    const rows = await client.queryAll<{ chunk_id: string | null }>(
      `SELECT chunk_id FROM cg_symbols WHERE symbol_id = '${symbolId}'`,
    );
    return rows[0]?.chunk_id ?? null;
  }

  it("retires the join of a re-derived file whose symbols fell out of every chunk", async () => {
    await walk(["a"]);
    await provider.buildChunkSignals("/", new Map([["src/a.ts", [{ chunkId: "chunk-a", startLine: 1, endLine: 5 }]]]));
    expect(await chunkIdOf("A#run")).toBe("chunk-a");

    // Re-chunking moved the file's only chunk past the symbol's start line, so
    // this pass resolves no covering chunk for A#run at all.
    await provider.buildChunkSignals(
      "/",
      new Map([["src/a.ts", [{ chunkId: "chunk-far", startLine: 50, endLine: 60 }]]]),
    );

    expect(await chunkIdOf("A#run")).toBeNull();
  });

  it("keeps the join of a file this pass did not re-derive", async () => {
    await walk(["a", "b"]);
    await provider.buildChunkSignals(
      "/",
      new Map([
        ["src/a.ts", [{ chunkId: "chunk-a", startLine: 1, endLine: 5 }]],
        ["src/b.ts", [{ chunkId: "chunk-b", startLine: 1, endLine: 5 }]],
      ]),
    );

    // Only src/a.ts is in this pass's chunkMap — src/b.ts was not re-chunked.
    await provider.buildChunkSignals("/", new Map([["src/a.ts", [{ chunkId: "chunk-a2", startLine: 1, endLine: 5 }]]]));

    expect(await chunkIdOf("A#run")).toBe("chunk-a2");
    expect(await chunkIdOf("B#run")).toBe("chunk-b");
  });
});
