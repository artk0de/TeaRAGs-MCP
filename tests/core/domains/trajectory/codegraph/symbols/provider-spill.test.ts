/**
 * Slice 2 streaming spill lifecycle for `CodegraphEnrichmentProvider`.
 *
 * Verifies the chunked-flush ingest invariants:
 *
 *   - `sink.write()` appends to `<rootDir>/codegraph/.spill/<coll>-<runId>.ndjson`.
 *   - `sink.finish()` reads the spill back, runs the resolver, upserts
 *     per file, and removes the spill on the success path.
 *   - A spill IO failure surfaces as `CodegraphSpillIoError` (typed)
 *     instead of a generic Error — so the prefetch marker carries a
 *     readable message rather than "in_progress" forever.
 *   - Symbol defs are persisted to DuckDB on EVERY write (cold-start
 *     hydration depends on this — incremental reindex must not require
 *     re-walking unchanged files to fill the symbol table).
 *   - Pool-level stale spill purge runs at construction, NOT at every
 *     acquire (otherwise concurrent in-flight spills get wiped).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GraphDbClientPool } from "../../../../../../src/core/adapters/duckdb/pool.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { CodegraphSpillIoError } from "../../../../../../src/core/domains/trajectory/errors.js";

describe("CodegraphEnrichmentProvider — slice 2 spill lifecycle", () => {
  let tmp: string;
  let pool: GraphDbClientPool;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-prov-spill-"));
    pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    provider = new CodegraphEnrichmentProvider({
      pool,
      ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
      composer: new DefaultSymbolIdComposer(),
    });
  });

  afterEach(async () => {
    await pool.closeAll();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("spill file is removed after a successful finish()", async () => {
    const sink = provider.asExtractionSink("alpha");
    await sink.write({
      relPath: "src/index.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "main", scope: [], calls: [] }],
      fileScope: [],
    });
    await sink.finish();
    // After finish: spill is cleaned up. Mid-flight existence is not
    // asserted here because Node's createWriteStream creates the OS
    // file lazily — the load-bearing invariant is the post-finish
    // cleanup.
    const spillDir = join(tmp, "codegraph", ".spill");
    expect(readdirSync(spillDir).filter((n) => n.endsWith(".ndjson")).length).toBe(0);
  });

  it("pool construction purges stale spill files left by a prior crashed run", () => {
    // Simulate residue from a prior process that crashed mid-write.
    const spillDir = join(tmp, "codegraph", ".spill");
    expect(existsSync(spillDir)).toBe(true);
    writeFileSync(join(spillDir, "stale-collection-uuid.ndjson"), "garbage\n");
    expect(readdirSync(spillDir)).toContain("stale-collection-uuid.ndjson");

    // A fresh pool over the SAME rootDir wipes the stale file.
    const pool2 = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    });
    void pool2;
    expect(readdirSync(spillDir)).not.toContain("stale-collection-uuid.ndjson");
  });

  it("does NOT purge spill files of a sibling collection on per-collection acquire", async () => {
    // Acquire ONE collection to materialise the DuckDB file + ensure
    // the .spill dir exists with its empty content.
    await pool.acquire("alpha");
    const spillDir = join(tmp, "codegraph", ".spill");
    // Simulate a concurrent collection's in-flight spill landing while
    // another collection's DuckDB init is running.
    const inFlightPath = join(spillDir, "beta-mid-flight.ndjson");
    writeFileSync(inFlightPath, "{}\n");

    // Acquire the OTHER collection — must not touch the in-flight file.
    await pool.acquire("beta");
    expect(existsSync(inFlightPath)).toBe(true);
  });

  it("write() throws CodegraphSpillIoError when the spill directory is unwritable", async () => {
    // Construct a provider whose direct mode would land the spill in
    // a path that cannot be created (a regular file masquerading as
    // a parent directory). The error surfaces as the typed class so
    // the marker carries a readable message.
    const blocked = join(tmp, "blocked");
    writeFileSync(blocked, "I am a file, not a directory\n");

    // Direct mode keeps the test off the pool path (so we can force a
    // bad spill location). The provider falls back to a process.cwd()
    // sub-path for direct mode, so we monkey-patch cwd just for this
    // test to force a known unwritable target.
    const origCwd = process.cwd;
    Object.defineProperty(process, "cwd", { value: () => blocked, configurable: true });
    try {
      // pool-mode uses pool.spillPathFor; switch to direct mode by
      // building a provider without a pool. Direct mode requires
      // graphDb+symbolTable, supplied as no-op stubs.
      const directProvider = new CodegraphEnrichmentProvider({
        graphDb: {
          upsertSymbols: async () => undefined,
          upsertFile: async () => undefined,
          checkpoint: async () => undefined,
          async *streamAdjacency() {},
          listAdjacency: async () => new Map<string, string[]>(),
          replaceCycles: async () => undefined,
          replacePageRanks: async () => undefined,
          removeFile: async () => undefined,
          removeSymbolsForFile: async () => undefined,
          getFanIn: async () => 0,
          getFanOut: async () => 0,
          getTransitiveImpact: async () => 0,
          findCycles: async () => [],
          getCallers: async () => [],
          getCallees: async () => [],
          getCalledByCount: async () => 0,
          getCallSiteCount: async () => 0,
          getPageRank: async () => 0,
          listAllSymbols: async () => [],
          hasData: async () => false,
        } as never,
        symbolTable: new InMemoryGlobalSymbolTable(),
        ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
        composer: new DefaultSymbolIdComposer(),
      });
      const sink = directProvider.asExtractionSink();
      await expect(
        sink.write({
          relPath: "src/index.ts",
          language: "typescript",
          imports: [],
          chunks: [],
          fileScope: [],
        }),
      ).rejects.toBeInstanceOf(CodegraphSpillIoError);
    } finally {
      Object.defineProperty(process, "cwd", { value: origCwd, configurable: true });
    }
  });

  it("write() throws a programming error when called after finish() (caller bug guard)", async () => {
    const sink = provider.asExtractionSink("alpha");
    await sink.write({
      relPath: "src/index.ts",
      language: "typescript",
      imports: [],
      chunks: [],
      fileScope: [],
    });
    await sink.finish();
    await expect(
      sink.write({
        relPath: "src/other.ts",
        language: "typescript",
        imports: [],
        chunks: [],
        fileScope: [],
      }),
    ).rejects.toThrow(/write\(\) called after finish/);
  });

  it("finish() with zero writes still resolves cleanly (no resolve pass needed)", async () => {
    // Exercises the `spillWriteCount > 0` guard around streamingResolveAndUpsert.
    const sink = provider.asExtractionSink("empty-coll");
    await sink.finish();
    // No throw, no spill file persisted, no resolver invocation.
    const handle = await pool.acquire("empty-coll");
    const defs = await handle.graphDb.listAllSymbols();
    expect(defs.length).toBe(0);
  });

  it("upsertSymbols persists on every write (not deferred to finish)", async () => {
    // Slice 2 invariant: defs land in DuckDB at write-time so an
    // incremental reindex's `listAllSymbols` hydration sees the full
    // cross-file set on the next cold start. Prior implementation
    // batched defs at finish, which broke partial reindex resolver
    // accuracy after a crash mid-batch.
    const sink = provider.asExtractionSink("alpha");
    await sink.write({
      relPath: "src/index.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "EarlyDef", scope: [], calls: [] }],
      fileScope: [],
    });

    // Before finish: the def is already queryable from the per-collection
    // DuckDB symbol table because upsertSymbols ran on the write path.
    const handle = await pool.acquire("alpha");
    const defs = await handle.graphDb.listAllSymbols();
    expect(defs.map((d) => d.symbolId)).toContain("EarlyDef");

    await sink.finish();
  });
});
