/**
 * Cross-collection isolation for `CodegraphEnrichmentProvider`.
 *
 * A single provider instance is reused for every Qdrant collection a
 * tea-rags process indexes — `bootstrap/factory.ts` constructs one
 * provider, wires the pool, and the same object handles every
 * `buildFileSignals` / `asExtractionSink` / `buildChunkSignals` call
 * regardless of which project triggered it.
 *
 * The first iteration of this code kept the extraction `buffer` and the
 * `chunkSymbolByLine` Map as instance fields, which leaked across
 * collections:
 *
 *   - When two `asExtractionSink` calls existed concurrently (or one
 *     leaked residue from an aborted finish), `sink.finish` for project
 *     B would drain project A's extractions through B's graphDb,
 *     producing rows where `cg_symbols_files.rel_path` belonged to a
 *     different repo.
 *   - `chunkSymbolByLine` indexed by bare relPath, so two projects with
 *     overlapping rel_paths (e.g. both repos hold `src/index.ts`)
 *     clobbered each other's line maps.
 *
 * The fix moves the buffer into the sink closure (so each sink owns its
 * FIFO and writes only its own extractions) and keys the chunk line map
 * by collection name. These tests pin both invariants so the regression
 * cannot recur.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GraphDbClientPool } from "../../../../../../src/core/adapters/duckdb/pool.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { TSCallResolver } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("CodegraphEnrichmentProvider — cross-collection isolation", () => {
  let tmp: string;
  let pool: GraphDbClientPool;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-prov-iso-"));
    pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    provider = new CodegraphEnrichmentProvider({
      pool,
      resolvers: new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]]),
      composer: new DefaultSymbolIdComposer(),
    });
  });

  afterEach(async () => {
    await pool.closeAll();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("two collections' sinks own disjoint buffers — A's extractions never land in B's graphDb", async () => {
    // Reproduces the user-visible bug: indexing project A then project B
    // back-to-back (or with overlapping timing) left A's `rel_path` rows
    // in B's `cg_symbols_files` table. With per-sink local buffers each
    // finish() drains only its own writes.
    const sinkA = provider.asExtractionSink("project-alpha");
    const sinkB = provider.asExtractionSink("project-beta");

    // Interleave writes between the two sinks WITHOUT calling finish
    // until both have written. Under the old shared-buffer code, the
    // first finish would absorb both files into one DB.
    await sinkA.write({
      relPath: "src/test/java/org/apache/commons/lang3/ArrayUtilsTest.java",
      language: "java",
      imports: [],
      chunks: [{ symbolId: "ArrayUtilsTest", scope: [], calls: [] }],
      fileScope: [],
    });
    await sinkB.write({
      relPath: "config/__init__.py",
      language: "python",
      imports: [],
      chunks: [{ symbolId: "config", scope: [], calls: [] }],
      fileScope: [],
    });
    // Drain in reverse order on purpose — the bug manifested as the
    // earlier sink absorbing the later sink's residue.
    await sinkB.finish();
    await sinkA.finish();

    const alphaHandle = await pool.acquire("project-alpha");
    const betaHandle = await pool.acquire("project-beta");

    const alphaRows = await alphaHandle.graphDb.queryAll<{ rel_path: string }>("SELECT rel_path FROM cg_symbols_files");
    const betaRows = await betaHandle.graphDb.queryAll<{ rel_path: string }>("SELECT rel_path FROM cg_symbols_files");

    expect(alphaRows.map((r) => r.rel_path)).toEqual(["src/test/java/org/apache/commons/lang3/ArrayUtilsTest.java"]);
    expect(betaRows.map((r) => r.rel_path)).toEqual(["config/__init__.py"]);
  });

  it("buildChunkSignals reads the line-map for the right collection (no cross-coll relPath bleed)", async () => {
    // Same rel_path lives in BOTH collections but maps to a different
    // symbolId in each. Pre-fix, `chunkSymbolByLine` was keyed only by
    // relPath — the second project's write clobbered the first's entry
    // and `buildChunkSignals` for the first project resolved to the
    // second project's symbol.
    const sinkA = provider.asExtractionSink("project-alpha");
    const sinkB = provider.asExtractionSink("project-beta");
    await sinkA.write({
      relPath: "src/index.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "alphaSymbol", scope: [], calls: [], startLine: 1, endLine: 5 }],
      fileScope: [],
    });
    await sinkB.write({
      relPath: "src/index.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "betaSymbol", scope: [], calls: [], startLine: 1, endLine: 5 }],
      fileScope: [],
    });
    await sinkA.finish();
    await sinkB.finish();

    // A chunkMap that resolves `src/index.ts` line 1 — must hit the
    // collection's own symbolId, not the other's.
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
      ["src/index.ts", [{ chunkId: "chunk-1", startLine: 1, endLine: 5 }]],
    ]);

    // Each collection's buildChunkSignals call sees only its own
    // symbol. Pre-fix this would have failed: both calls resolved to
    // whichever symbolId the shared line-map happened to store last.
    const alphaChunks = await provider.buildChunkSignals("/", chunkMap, {
      collectionName: "project-alpha",
    });
    const betaChunks = await provider.buildChunkSignals("/", chunkMap, {
      collectionName: "project-beta",
    });

    // The line map for alpha resolves to alphaSymbol; for beta to
    // betaSymbol. A symbol exists in each collection's own DB, so
    // buildChunkSignals emits a per-chunk overlay for each one.
    expect(alphaChunks.get("src/index.ts")?.has("chunk-1")).toBe(true);
    expect(betaChunks.get("src/index.ts")?.has("chunk-1")).toBe(true);
  });

  it("handleDeletedPaths only clears the line-map of the targeted collection", async () => {
    // Both collections have an entry for src/index.ts in their line
    // maps. Deleting it from collection A's view must NOT clear B's
    // entry — otherwise an A-side incremental reindex would silently
    // drop B's chunk-symbol resolution.
    const sinkA = provider.asExtractionSink("project-alpha");
    const sinkB = provider.asExtractionSink("project-beta");
    await sinkA.write({
      relPath: "src/index.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "alphaSymbol", scope: [], calls: [], startLine: 1, endLine: 5 }],
      fileScope: [],
    });
    await sinkB.write({
      relPath: "src/index.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "betaSymbol", scope: [], calls: [], startLine: 1, endLine: 5 }],
      fileScope: [],
    });
    await sinkA.finish();
    await sinkB.finish();

    await provider.handleDeletedPaths(["src/index.ts"], { collectionName: "project-alpha" });

    // A's line map dropped → buildChunkSignals returns no entries for A.
    const alphaChunks = await provider.buildChunkSignals(
      "/",
      new Map([["src/index.ts", [{ chunkId: "c", startLine: 1, endLine: 5 }]]]),
      { collectionName: "project-alpha" },
    );
    expect(alphaChunks.get("src/index.ts")?.size).toBe(0);

    // B's line map is untouched → buildChunkSignals still resolves.
    const betaChunks = await provider.buildChunkSignals(
      "/",
      new Map([["src/index.ts", [{ chunkId: "c", startLine: 1, endLine: 5 }]]]),
      { collectionName: "project-beta" },
    );
    expect(betaChunks.get("src/index.ts")?.has("c")).toBe(true);
  });

  it("symbol tables of two collections stay disjoint across the provider's whole lifecycle", async () => {
    // Tail-end check: after a full write+finish on each collection, the
    // pool-owned symbol tables must still be disjoint — confirms no
    // shared in-memory bookkeeping snuck in via a side channel.
    const sinkA = provider.asExtractionSink("project-alpha");
    const sinkB = provider.asExtractionSink("project-beta");
    await sinkA.write({
      relPath: "src/alpha.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "AlphaUtil", scope: [], calls: [] }],
      fileScope: [],
    });
    await sinkB.write({
      relPath: "src/beta.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "BetaUtil", scope: [], calls: [] }],
      fileScope: [],
    });
    await sinkA.finish();
    await sinkB.finish();

    const a = await pool.acquire("project-alpha");
    const b = await pool.acquire("project-beta");
    expect(a.symbolTable.lookupByShortName("AlphaUtil")).toHaveLength(1);
    expect(a.symbolTable.lookupByShortName("BetaUtil")).toHaveLength(0);
    expect(b.symbolTable.lookupByShortName("BetaUtil")).toHaveLength(1);
    expect(b.symbolTable.lookupByShortName("AlphaUtil")).toHaveLength(0);
  });
});
