/**
 * `buildChunkSignals` falls back to the chunk's own payload `symbolId` when the
 * walker line map has nothing for it (bd tea-rags-mcp-fxio5).
 *
 * The walker line map is filled only by a walk in the SAME process. Pre-reindex
 * recovery (`EnrichmentRecovery#recoverChunkLevel`) runs before any walk, so
 * with the line map as the only source every chunk was skipped and the applier
 * stamped `enrichedAt` over an empty overlay: 18 of 18 probe chunks on the
 * tea-rags self-index lost fanIn / fanOut / pageRank. The chunker writes
 * `symbolId` onto every chunk payload, and by `.claude/rules/symbolid-convention.md`
 * it equals `cg_symbols.symbol_id` for the same AST node, so it is a valid key
 * into the bulk signal map.
 *
 * The walker map stays first: the deferred chunk pass must behave exactly as
 * before.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { ChunkLookupEntry } from "../../../../../../src/core/contracts/types/chunker.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

type ChunkSignalsBulk = Awaited<ReturnType<DuckDbGraphClient["getChunkSignalsBulk"]>>;

describe("CodegraphEnrichmentProvider.buildChunkSignals — payload symbolId fallback", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-payload-symbolid-"));
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

  function stubBulkSignals(entries: [string, { fanIn: number; fanOut: number; pageRank: number }][]): void {
    vi.spyOn(client, "getChunkSignalsBulk").mockResolvedValue(new Map(entries) as unknown as ChunkSignalsBulk);
  }

  it("resolves a chunk by its payload symbolId when no walk populated the line map", async () => {
    stubBulkSignals([["X#method", { fanIn: 3, fanOut: 2, pageRank: 0.5 }]]);

    const chunkMap = new Map<string, ChunkLookupEntry[]>([
      ["src/x.ts", [{ chunkId: "chunk-x", startLine: 10, endLine: 20, symbolId: "X#method" }]],
    ]);
    const out = await provider.buildChunkSignals("/", chunkMap);

    expect(out.get("src/x.ts")?.get("chunk-x")).toEqual({ fanIn: 3, fanOut: 2, pageRank: 0.5 });
  });

  it("strips the chunker #partN suffix so a split method resolves to its base symbol", async () => {
    stubBulkSignals([["X#method", { fanIn: 4, fanOut: 1, pageRank: 0.25 }]]);

    const chunkMap = new Map<string, ChunkLookupEntry[]>([
      ["src/x.ts", [{ chunkId: "chunk-x-part2", startLine: 40, endLine: 80, symbolId: "X#method#part2" }]],
    ]);
    const out = await provider.buildChunkSignals("/", chunkMap);

    expect(out.get("src/x.ts")?.get("chunk-x-part2")).toEqual({ fanIn: 4, fanOut: 1, pageRank: 0.25 });
  });

  it("prefers the walker line map over a conflicting payload symbolId", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/w.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "W#run", scope: [], calls: [], startLine: 1, endLine: 5 }],
      fileScope: [],
    });
    await sink.finish();
    stubBulkSignals([
      ["W#run", { fanIn: 7, fanOut: 7, pageRank: 0.7 }],
      ["Other#thing", { fanIn: 1, fanOut: 1, pageRank: 0.1 }],
    ]);

    const chunkMap = new Map<string, ChunkLookupEntry[]>([
      ["src/w.ts", [{ chunkId: "chunk-w", startLine: 1, endLine: 5, symbolId: "Other#thing" }]],
    ]);
    const out = await provider.buildChunkSignals("/", chunkMap);

    expect(out.get("src/w.ts")?.get("chunk-w")).toEqual({ fanIn: 7, fanOut: 7, pageRank: 0.7 });
  });

  it("produces no overlay for a chunk with neither a walker hit nor a payload symbolId", async () => {
    stubBulkSignals([["X#method", { fanIn: 3, fanOut: 2, pageRank: 0.5 }]]);

    const chunkMap = new Map<string, ChunkLookupEntry[]>([
      ["src/x.ts", [{ chunkId: "chunk-anon", startLine: 10, endLine: 20 }]],
    ]);
    const out = await provider.buildChunkSignals("/", chunkMap);

    expect(out.get("src/x.ts")?.has("chunk-anon")).toBe(false);
  });
});
