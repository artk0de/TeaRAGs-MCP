import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { TSCallResolver } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

describe("CodegraphEnrichmentProvider", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-prov-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      resolvers: new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]]),
    });
  });
  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exposes the documented provider key and signal descriptors", () => {
    expect(provider.key).toBe("codegraph.symbols");
    expect(provider.signals.map((s) => s.key)).toContain("codegraph.file.fanIn");
    expect(provider.signals.map((s) => s.key)).toContain("codegraph.chunk.fanOut");
  });

  // Slice 2 / A2 — per-provider EnrichmentMetrics. The provider tracks
  // how many files it walked, how many graph edges it produced, and what
  // fraction of call sites the resolver actually pinned to a target.
  // CompletionRunner aggregates these into EnrichmentMetrics.byProvider.
  it("getRunMetrics reports counters after a finished extraction cycle and resets them", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [] }],
      fileScope: [],
    });
    await sink.write({
      relPath: "src/main.ts",
      language: "typescript",
      imports: [{ importText: "./foo", startLine: 1 }],
      chunks: [
        {
          symbolId: "main",
          scope: [],
          calls: [
            { callText: "Foo.bar()", receiver: "Foo", member: "bar", startLine: 4 },
            // Receiver "Mystery" has no symbol-table entry → unresolved,
            // contributes to callsAttempted but NOT callsResolved.
            { callText: "Mystery.nope()", receiver: "Mystery", member: "nope", startLine: 5 },
          ],
        },
      ],
      fileScope: [],
    });
    await sink.finish();

    const m = provider.getRunMetrics();
    expect(m).toBeDefined();
    expect(m).toMatchObject({
      extractedFiles: 2,
      fileEdgeCount: 1, // src/main.ts imports ./foo → src/foo.ts
      methodEdgeCount: 1, // only Foo.bar() resolves
    });
    // 1 resolved / 2 attempted = 0.5
    expect((m as { resolveSuccessRate: number }).resolveSuccessRate).toBeCloseTo(0.5, 5);

    // Read-and-clear semantics — the next call must start from zero
    // even before another sink cycle. Coordinator relies on this for
    // per-run isolation.
    const next = provider.getRunMetrics();
    expect(next).toBeUndefined();
  });

  it("getRunMetrics returns undefined when no files were extracted", () => {
    // Fresh provider, no sink activity → no counters to report.
    expect(provider.getRunMetrics()).toBeUndefined();
  });

  // Slice 2 / A4a — deletion hook. When sync notices a file is gone the
  // coordinator forwards the relPath to every provider implementing
  // handleDeletedPaths. Codegraph must drop edges from DuckDB + symbol
  // table + chunkSymbolByLine cache so subsequent reranks don't expose
  // phantom callers/callees for a deleted file.
  it("handleDeletedPaths removes file edges and symbol-table entries", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [] }],
      fileScope: [],
    });
    await sink.write({
      relPath: "src/main.ts",
      language: "typescript",
      imports: [{ importText: "./foo", startLine: 1 }],
      chunks: [
        {
          symbolId: "main",
          scope: [],
          calls: [{ callText: "Foo.bar()", receiver: "Foo", member: "bar", startLine: 4 }],
        },
      ],
      fileScope: [],
    });
    await sink.finish();
    // Sanity check baseline state — src/foo.ts has fanIn=1.
    expect(await client.getFanIn("src/foo.ts")).toBe(1);

    await provider.handleDeletedPaths(["src/main.ts"]);

    // src/main.ts removed → src/foo.ts no longer has anyone importing it.
    expect(await client.getFanIn("src/foo.ts")).toBe(0);
    // Symbol table no longer surfaces the deleted file's symbols.
    const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
    expect(lookup.lookupByShortName("main")).toEqual([]);
  });

  it("handleDeletedPaths is idempotent for unknown paths and empty input", async () => {
    // Unknown path — graphDb.removeFile + symbolTable.removeFile both
    // tolerate it. No throw, no side effects on existing state.
    await expect(provider.handleDeletedPaths(["src/never-existed.ts"])).resolves.toBeUndefined();
    // Empty list — fast exit, no DB calls.
    await expect(provider.handleDeletedPaths([])).resolves.toBeUndefined();
  });

  // Slice 2 / A4b — re-extraction of a modified file must clear stale
  // edges before inserting new ones. Otherwise edge counts drift up
  // permanently as the file is re-indexed. This exercises the end-to-end
  // sink → graphDb path (not just the adapter unit test) to confirm the
  // provider doesn't accidentally double-emit on its side either.

  // Slice 2 / A4c — sink.finish persists symbol definitions so the next
  // cold-start bootstrap can hydrate the in-memory symbol table from
  // disk. Without this, partial reindex would lose cross-file
  // resolution: the walker only touches changed files, so symbols
  // defined in unchanged files would be invisible to the resolver.
  it("sink.finish persists symbol definitions via graphDb.upsertSymbols", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [
        { symbolId: "Foo.bar", scope: ["Foo"], calls: [] },
        { symbolId: "Foo.baz", scope: ["Foo"], calls: [] },
      ],
      fileScope: [],
    });
    await sink.finish();
    const rows = await client.listAllSymbols();
    expect(rows.map((r) => r.symbolId).sort()).toEqual(["Foo.bar", "Foo.baz"]);
    expect(rows.find((r) => r.symbolId === "Foo.bar")?.scope).toEqual(["Foo"]);
  });

  it("handleDeletedPaths also removes persisted symbol rows", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [] }],
      fileScope: [],
    });
    await sink.finish();
    expect(await client.listAllSymbols()).toHaveLength(1);

    await provider.handleDeletedPaths(["src/foo.ts"]);
    expect(await client.listAllSymbols()).toEqual([]);
  });

  it("re-extracting same file via sink keeps edge counts stable (no doubling)", async () => {
    const writeOnce = async (target: string, sym: string) => {
      const sink = provider.asExtractionSink();
      await sink.write({
        relPath: "src/main.ts",
        language: "typescript",
        imports: [{ importText: `./${target}`, startLine: 1 }],
        chunks: [
          {
            symbolId: "main",
            scope: [],
            calls: [
              { callText: `${sym}()`, receiver: sym.split(".")[0], member: sym.split(".")[1] ?? sym, startLine: 4 },
            ],
          },
        ],
        fileScope: [],
      });
      await sink.finish();
    };
    // Seed targets so the resolver can pin them.
    const seed = provider.asExtractionSink();
    await seed.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [] }],
      fileScope: [],
    });
    await seed.write({
      relPath: "src/bar.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Bar.baz", scope: ["Bar"], calls: [] }],
      fileScope: [],
    });
    await seed.finish();

    await writeOnce("foo", "Foo.bar");
    expect(await client.getFanOut("src/main.ts")).toBe(1);
    expect(await client.getFanIn("src/foo.ts")).toBe(1);

    // Modify main.ts — now imports bar instead of foo.
    await writeOnce("bar", "Bar.baz");
    // Stable fanOut (not 2), and old import target dropped.
    expect(await client.getFanOut("src/main.ts")).toBe(1);
    expect(await client.getFanIn("src/foo.ts")).toBe(0);
    expect(await client.getFanIn("src/bar.ts")).toBe(1);
  });

  it("sink finish populates graphDb with file edges and method edges", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [] }],
      fileScope: [],
    });
    await sink.write({
      relPath: "src/main.ts",
      language: "typescript",
      imports: [{ importText: "./foo", startLine: 1 }],
      chunks: [
        {
          symbolId: "main",
          scope: [],
          calls: [{ callText: "Foo.bar()", receiver: "Foo", member: "bar", startLine: 4 }],
        },
      ],
      fileScope: [],
    });
    await sink.finish();
    expect(await client.getFanIn("src/foo.ts")).toBe(1);
    expect(await client.getFanOut("src/main.ts")).toBe(1);
    expect(await client.getCalledByCount("Foo.bar")).toBe(1);
    expect(await client.getCallSiteCount("main")).toBe(1);
  });

  it("buildFileSignals returns fanIn / fanOut / instability / isLeaf based on graph state", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/leaf.ts",
      language: "typescript",
      imports: [],
      chunks: [],
      fileScope: [],
    });
    await sink.write({
      relPath: "src/main.ts",
      language: "typescript",
      imports: [{ importText: "./leaf", startLine: 1 }],
      chunks: [],
      fileScope: [],
    });
    await sink.finish();
    const overlays = await provider.buildFileSignals("/", {
      paths: ["src/leaf.ts", "src/main.ts"],
    });
    const leafOverlay = overlays.get("src/leaf.ts");
    expect(leafOverlay?.["codegraph.file.fanIn"]).toBe(1);
    expect(leafOverlay?.["codegraph.file.isLeaf"]).toBe(true);
    const mainOverlay = overlays.get("src/main.ts");
    expect(mainOverlay?.["codegraph.file.fanOut"]).toBe(1);
    expect(mainOverlay?.["codegraph.file.instability"]).toBeCloseTo(1, 5);
    // isHub stays false in buildFileSignals — IsHubSignal finalises it at rerank time.
    expect(mainOverlay?.["codegraph.file.isHub"]).toBe(false);
  });

  it("resolveRoot is identity — the slice scans the literal absolute path it is given", () => {
    expect(provider.resolveRoot("/abs/path")).toBe("/abs/path");
  });

  it("buildFileSignals auto-discovers TS/TSX files on disk when no paths option is provided", async () => {
    // Build a small project tree under the worktree's tmp dir. The walker
    // must:
    //   1. Recurse into nested dirs.
    //   2. Skip IGNORE_DIRS (node_modules, build, .git, ...).
    //   3. Skip dotfiles other than .claude-plugin.
    //   4. Pick up .ts and .tsx, skip other extensions and extensionless files.
    //   5. Hand each picked file to extractOneFile -> collectSymbols, which
    //      must handle both function_declaration and class_declaration nodes
    //      (the descendsInto branch in nameOf).
    const root = mkdtempSync(join(tmpdir(), "cg-discover-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "src", "nested"), { recursive: true });
      mkdirSync(join(root, "node_modules", "junk"), { recursive: true });
      mkdirSync(join(root, ".hidden"), { recursive: true });

      // Exercises function_declaration in collectSymbols (descendsInto=false).
      writeFileSync(
        join(root, "src", "alpha.ts"),
        "export function alpha(): number { return 1; }\nexport function beta(): number { return 2; }\n",
      );
      // Exercises class_declaration + nested method_definition
      // (descendsInto=true branch in nameOf, and the recursion into
      // children with extended scope).
      writeFileSync(
        join(root, "src", "nested", "service.tsx"),
        "export class Service {\n  go(): number { return 3; }\n  stop(): number { return 4; }\n}\n",
      );
      // No .ts extension — must be ignored by TS_EXTS filter.
      writeFileSync(join(root, "src", "notes.md"), "ignored");
      // Inside node_modules — must be ignored by IGNORE_DIRS.
      writeFileSync(join(root, "node_modules", "junk", "lib.ts"), "export const skip = 1;");
      // Hidden dir (starts with '.') — must be ignored.
      writeFileSync(join(root, ".hidden", "secret.ts"), "export const hidden = 1;");
      // Extensionless file in a real dir — must be skipped silently by
      // extensionOf returning "".
      writeFileSync(join(root, "src", "Makefile"), "all:\n\techo hi\n");

      const overlays = await provider.buildFileSignals(root);
      // Both legitimate files appear; junk does not.
      const keys = [...overlays.keys()].sort();
      expect(keys).toEqual(["src/alpha.ts", "src/nested/service.tsx"]);
      // Symbol table received both files' top-level decls. alpha.ts ->
      // 2 functions, service.tsx -> 1 class + 2 methods (collectSymbols
      // descends into class).
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      expect(lookup.lookupByShortName("alpha").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("Service").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("go").length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildFileSignals filters caller-supplied paths to .ts/.tsx", async () => {
    // When the caller passes paths (incremental reindex), the provider
    // still routes through extractOneFile for each. Mixed extensions
    // are filtered to TS_EXTS only. This drives the
    // `options.paths.length > 0` branch + the extensionOf filter on
    // user input.
    const root = mkdtempSync(join(tmpdir(), "cg-paths-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "export function a() { return 1; }\n");
      writeFileSync(join(root, "src", "b.md"), "ignored");

      const overlays = await provider.buildFileSignals(root, {
        paths: ["src/a.ts", "src/b.md"],
      });
      // Overlay is emitted for every caller-listed path (consistent map
      // shape for the enrichment coordinator), but only a.ts was actually
      // walked + extracted. b.md is reported with zero-valued signals.
      expect(overlays.has("src/a.ts")).toBe(true);
      expect(overlays.has("src/b.md")).toBe(true);
      expect(overlays.get("src/b.md")?.["codegraph.file.fanIn"]).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildFileSignals tolerates per-file extract errors and keeps going", async () => {
    // extractOneFile reads from disk and parses with tree-sitter. A
    // missing file makes readFileSync throw — the provider must catch
    // and skip, so the walk completes and the overlay map is still
    // populated for the well-formed neighbour.
    const root = mkdtempSync(join(tmpdir(), "cg-err-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "ok.ts"), "export function ok() { return 1; }\n");
      // Caller-supplied path that does not exist on disk. extractOneFile
      // will throw ENOENT inside readFileSync; provider catches it.
      const overlays = await provider.buildFileSignals(root, {
        paths: ["src/ok.ts", "src/missing.ts"],
      });
      expect(overlays.size).toBe(2);
      expect(overlays.get("src/ok.ts")?.["codegraph.file.fanIn"]).toBe(0);
      expect(overlays.get("src/missing.ts")?.["codegraph.file.fanIn"]).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildChunkSignals attaches chunk fanIn and fanOut per chunk by symbolId", async () => {
    const sink = provider.asExtractionSink();
    // Each ChunkExtraction now carries startLine/endLine so the
    // provider's internal chunkSymbolByLine map can recover symbolId
    // for a later buildChunkSignals lookup that only sees
    // ChunkLookupEntry { chunkId, startLine, endLine }.
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [], startLine: 10, endLine: 20 }],
      fileScope: [],
    });
    await sink.write({
      relPath: "src/main.ts",
      language: "typescript",
      imports: [{ importText: "./foo", startLine: 1 }],
      chunks: [
        {
          symbolId: "main",
          scope: [],
          calls: [{ callText: "Foo.bar()", receiver: "Foo", member: "bar", startLine: 4 }],
          startLine: 3,
          endLine: 5,
        },
      ],
      fileScope: [],
    });
    await sink.finish();
    // ChunkLookupEntry contract: { chunkId, startLine, endLine } — no
    // symbolId field. Provider resolves symbolId via the line index.
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
      ["src/main.ts", [{ chunkId: "chunk-main", startLine: 3, endLine: 5 }]],
      ["src/foo.ts", [{ chunkId: "chunk-foo-bar", startLine: 10, endLine: 20 }]],
    ]);
    const overlays = await provider.buildChunkSignals("/", chunkMap);
    const main = overlays.get("src/main.ts")?.get("chunk-main");
    expect(main?.["codegraph.chunk.fanOut"]).toBe(1);
    const fooBar = overlays.get("src/foo.ts")?.get("chunk-foo-bar");
    expect(fooBar?.["codegraph.chunk.fanIn"]).toBe(1);
  });

  // Slice 1 — resolveChunkSymbolId containment fallback. When the
  // ingest chunker splits an oversized method across multiple Qdrant
  // chunks, the resulting ChunkLookupEntry rows carry intermediate
  // startLines that don't exactly match any walker-indexed line. The
  // provider must fall back to the largest indexed startLine that is
  // <= the lookup's startLine AND <= its endLine — best-effort
  // containment so the inner chunks still get fanIn/fanOut attached
  // to the parent method's symbolId.
  it("buildChunkSignals resolves symbolId via containment when startLine isn't an exact match", async () => {
    const sink = provider.asExtractionSink();
    // Method indexed at startLine=10 covering an oversized body. The
    // ingest chunker may later split it into two Qdrant chunks: head
    // at 10 (exact-match) and tail at 18 (containment fallback).
    await sink.write({
      relPath: "src/big.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Big.method", scope: ["Big"], calls: [], startLine: 10, endLine: 30 }],
      fileScope: [],
    });
    await sink.write({
      relPath: "src/caller.ts",
      language: "typescript",
      imports: [{ importText: "./big", startLine: 1 }],
      chunks: [
        {
          symbolId: "caller",
          scope: [],
          calls: [{ callText: "Big.method()", receiver: "Big", member: "method", startLine: 4 }],
          startLine: 3,
          endLine: 5,
        },
      ],
      fileScope: [],
    });
    await sink.finish();

    // Two lookup entries for big.ts:
    //   - exact match (startLine=10) — hits the early-return path
    //   - non-exact (startLine=18, endLine=25) — drives the containment
    //     loop: scans line=10, 10<=18 && 10<=25 → best={start:10,
    //     sym:"Big.method"}. Returns Big.method.
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
      [
        "src/big.ts",
        [
          { chunkId: "chunk-head", startLine: 10, endLine: 17 },
          { chunkId: "chunk-tail", startLine: 18, endLine: 25 },
        ],
      ],
    ]);
    const overlays = await provider.buildChunkSignals("/", chunkMap);
    const head = overlays.get("src/big.ts")?.get("chunk-head");
    const tail = overlays.get("src/big.ts")?.get("chunk-tail");
    // Both head and tail must resolve to Big.method → same fanIn=1.
    expect(head?.["codegraph.chunk.fanIn"]).toBe(1);
    expect(tail?.["codegraph.chunk.fanIn"]).toBe(1);
  });

  // resolveChunkSymbolId's `if (!lineMap) return undefined` branch fires
  // when buildChunkSignals receives chunks for a relPath the provider
  // never walked (no chunkSymbolByLine entry). The skip path returns
  // an empty per-chunk map for that file. Documented behaviour: the
  // ingest coordinator can pass non-TS / non-codegraph files through
  // here without crashing.
  it("buildChunkSignals returns an empty per-chunk map for unwalked relPaths", async () => {
    // Provider has never seen "src/never-walked.ts" — no sink.write,
    // no buildFileSignals call. chunkSymbolByLine is empty.
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
      ["src/never-walked.ts", [{ chunkId: "chunk-x", startLine: 1, endLine: 10 }]],
    ]);
    const overlays = await provider.buildChunkSignals("/", chunkMap);
    // Map exists for the file (per the loop-over-chunkMap contract) but
    // contains no per-chunk entries because every lookup returned
    // undefined and was `continue`'d.
    expect(overlays.get("src/never-walked.ts")?.size).toBe(0);
  });

  it("buildChunkSignals skips chunks whose startLine has no containing indexed line", async () => {
    // Containment loop returns undefined when no indexed startLine
    // satisfies line<=startLine&&line<=endLine. Exercises the
    // `best` stays undefined path through the loop, then the
    // `if (!symbolId) continue` skip in buildChunkSignals.
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/big.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Big.method", scope: ["Big"], calls: [], startLine: 100, endLine: 120 }],
      fileScope: [],
    });
    await sink.finish();

    // Lookup at startLine=5: indexed line=100, 100<=5 is false → no
    // best candidate → resolveChunkSymbolId returns undefined → skip.
    const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>([
      ["src/big.ts", [{ chunkId: "chunk-orphan", startLine: 5, endLine: 8 }]],
    ]);
    const overlays = await provider.buildChunkSignals("/", chunkMap);
    // Map for the file exists but no per-chunk entry because the
    // lookup was skipped.
    expect(overlays.get("src/big.ts")?.has("chunk-orphan")).toBe(false);
  });

  // Slice 2 / B2 — sink.finish recomputes Tarjan SCC after the batch
  // settles. The recompute is best-effort: losing cycle freshness
  // degrades find_cycles but must NOT corrupt the rest of the graph.
  // The catch around recomputeCycles silences the error (debug-logging
  // only when DEBUG=true). This test wires a graphDb stub whose
  // recomputeCycles throws but everything else succeeds — finish must
  // still resolve normally.
  it("sink.finish swallows recomputeCycles failures (best-effort SCC refresh)", async () => {
    const fakeGraphDb = {
      upsertFile: async () => undefined,
      upsertSymbols: async () => undefined,
      removeFile: async () => undefined,
      removeSymbolsForFile: async () => undefined,
      recomputeCycles: async () => {
        throw new Error("simulated cycle recompute failure");
      },
      // Unused-by-finish but required by the GraphDbClient shape.
      findCycles: async () => [],
      getFanIn: async () => 0,
      getFanOut: async () => 0,
      getTransitiveImpact: async () => 0,
      getCallers: async () => [],
      getCallees: async () => [],
      getCalledByCount: async () => 0,
      getCallSiteCount: async () => 0,
      listAllSymbols: async () => [],
      hasData: async () => false,
    };
    const failingProvider = new CodegraphEnrichmentProvider({
      graphDb: fakeGraphDb as never,
      symbolTable: new InMemoryGlobalSymbolTable(),
      resolvers: new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]]),
    });
    const sink = failingProvider.asExtractionSink();
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [] }],
      fileScope: [],
    });
    // recomputeCycles throws inside finish — the provider's try/catch
    // must swallow it so the indexing pipeline doesn't abort.
    await expect(sink.finish()).resolves.toBeUndefined();
  });

  // Same path but with DEBUG=true so the stderr.write branch executes
  // (lines 166-167 of provider.ts). Restores DEBUG after the assertion
  // to keep test isolation.
  it("sink.finish emits stderr note on recompute failure when DEBUG=true", async () => {
    const fakeGraphDb = {
      upsertFile: async () => undefined,
      upsertSymbols: async () => undefined,
      removeFile: async () => undefined,
      removeSymbolsForFile: async () => undefined,
      recomputeCycles: async () => {
        throw new Error("debug-path cycle failure");
      },
      findCycles: async () => [],
      getFanIn: async () => 0,
      getFanOut: async () => 0,
      getTransitiveImpact: async () => 0,
      getCallers: async () => [],
      getCallees: async () => [],
      getCalledByCount: async () => 0,
      getCallSiteCount: async () => 0,
      listAllSymbols: async () => [],
      hasData: async () => false,
    };
    const failingProvider = new CodegraphEnrichmentProvider({
      graphDb: fakeGraphDb as never,
      symbolTable: new InMemoryGlobalSymbolTable(),
      resolvers: new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]]),
    });
    const sink = failingProvider.asExtractionSink();
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [] }],
      fileScope: [],
    });

    const prevDebug = process.env.DEBUG;
    process.env.DEBUG = "true";
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return origWrite(chunk as never, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      await expect(sink.finish()).resolves.toBeUndefined();
    } finally {
      process.stderr.write = origWrite;
      if (prevDebug === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = prevDebug;
    }
    // Slice 2 / B3 — message updated to "post-extract metric recompute"
    // because the same try/catch now also covers PageRank recompute.
    expect(writes.some((w) => w.includes("[codegraph] post-extract metric recompute failed"))).toBe(true);
  });

  // Slice 1 — discoverTypescriptFiles catch branch. When the walker
  // hits readdirSync against a non-existent or unreadable directory,
  // it must swallow the error and continue (one bad subtree shouldn't
  // crash the whole codegraph build). A non-existent root is the
  // cleanest reproduction — the FIRST readdirSync call throws ENOENT
  // and the catch returns from walk(), leaving out empty.
  it("buildFileSignals returns an empty overlay map when root does not exist (readdirSync throws)", async () => {
    const nonExistentRoot = join(tmpdir(), `cg-does-not-exist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Don't create the directory — readdirSync should ENOENT.
    const overlays = await provider.buildFileSignals(nonExistentRoot);
    // Walker caught the error and returned empty; no files walked, no
    // overlays emitted. Map is defined and empty (not undefined).
    expect(overlays.size).toBe(0);
  });

  // Slice 1 — LANGUAGES dispatch table. The provider walks any file
  // whose extension appears in LANGUAGES. Adding Python and Ruby
  // walkers/nameOf entries means buildFileSignals must:
  //   1. Pick up .py / .rb files via discoverSupportedFiles.
  //   2. Dispatch to the right walker via LANGUAGES[ext].walker.
  //   3. Call the right nameOf (pyNameOf / rbNameOf) in collectSymbols.
  //   4. Compose symbol ids with the per-language scopeSeparator.
  it("buildFileSignals dispatches .py files through the Python walker + pyNameOf", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-py-disp-"));
    try {
      mkdirSync(join(root, "pkg"), { recursive: true });
      // `class` triggers class_definition (descendsInto=true) + nested
      // function_definition. Two top-level functions exercise the
      // function_definition branch in pyNameOf.
      writeFileSync(
        join(root, "pkg", "service.py"),
        [
          "class Service:",
          "    def go(self):",
          "        return 1",
          "    def stop(self):",
          "        return 2",
          "",
          "def helper():",
          "    return 3",
          "",
        ].join("\n"),
      );
      const overlays = await provider.buildFileSignals(root);
      expect([...overlays.keys()]).toEqual(["pkg/service.py"]);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // Class symbol present.
      expect(lookup.lookupByShortName("Service").length).toBeGreaterThan(0);
      // Nested methods carry the parent's scope joined by "."
      // (Python's scopeSeparator).
      const goEntries = lookup.lookupByShortName("go");
      expect(goEntries.length).toBeGreaterThan(0);
      expect(goEntries[0].symbolId).toContain("Service.go");
      // Top-level helper function.
      expect(lookup.lookupByShortName("helper").length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildFileSignals dispatches .rb files through the Ruby walker + rbNameOf with :: separator", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-disp-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      // Plain class with one instance method and one singleton method.
      // rbNameOf must recognise BOTH `method` and `singleton_method`
      // node types; the scopeSeparator is "::".
      writeFileSync(
        join(root, "app", "models", "user.rb"),
        ["class User", "  def find(id)", "    id", "  end", "  def self.recent", "    []", "  end", "end", ""].join(
          "\n",
        ),
      );
      // Compound class header `class Acme::Auth` — exercises
      // scope_resolution branch in rbNameOf (scopeResolutionText).
      mkdirSync(join(root, "app", "services", "acme"), { recursive: true });
      writeFileSync(
        join(root, "app", "services", "acme", "auth.rb"),
        ["class Acme::Auth", "  def call", "    1", "  end", "end", ""].join("\n"),
      );
      const overlays = await provider.buildFileSignals(root);
      const keys = [...overlays.keys()].sort();
      expect(keys).toEqual(["app/models/user.rb", "app/services/acme/auth.rb"]);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // Class names indexed.
      expect(lookup.lookupByShortName("User").length).toBeGreaterThan(0);
      // Compound class composes via "::". scope_resolution branch.
      const acmeAuth = lookup.lookupByShortName("Acme::Auth");
      expect(acmeAuth.length).toBeGreaterThan(0);
      // Methods nested under classes get "::"-joined ids. The
      // provider's lastSegment helper splits on "/" then ".", so for
      // a "::"-joined Ruby id like "User::find" the shortName comes
      // out intact ("User::find") — we query the symbol table by
      // that literal shortName.
      const findEntries = lookup.lookupByShortName("User::find");
      expect(findEntries[0].symbolId).toBe("User::find");
      // singleton_method branch in rbNameOf.
      const recentEntries = lookup.lookupByShortName("User::recent");
      expect(recentEntries[0].symbolId).toBe("User::recent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Slice 1 — LANGUAGES dispatch for polyglot walkers. Each of the five
  // new languages (.js, .go, .java, .rs, .sh) ships with its own walker
  // + nameOf in the dispatch table. These tests drive buildFileSignals
  // against real source files for each so the table's loadParser arrow
  // is invoked AND the matching nameOf executes through collectSymbols.
  // Without these, the per-language arrow functions and nameOf bodies
  // for the new languages stay dead — they only exist to be looked up
  // at extension dispatch time.

  it("buildFileSignals dispatches .js files through extractFromJavascriptFile + tsNameOf", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-js-disp-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "service.js"),
        ["function helper() { return 1; }", "class Service {", "  go() { return 2; }", "}", ""].join("\n"),
      );
      const overlays = await provider.buildFileSignals(root);
      expect([...overlays.keys()]).toEqual(["src/service.js"]);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      expect(lookup.lookupByShortName("helper").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("Service").length).toBeGreaterThan(0);
      // Method nested in class — descendsInto branch in tsNameOf applied
      // to the JS class_declaration node.
      const go = lookup.lookupByShortName("go");
      expect(go.length).toBeGreaterThan(0);
      expect(go[0].symbolId).toContain("Service.go");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildFileSignals dispatches .go files through extractFromGoFile + goNameOf", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-go-disp-"));
    try {
      mkdirSync(join(root, "pkg"), { recursive: true });
      // function_declaration + type_declaration (struct). goNameOf must
      // emit BOTH as top-level symbols. method_declaration as well.
      writeFileSync(
        join(root, "pkg", "service.go"),
        [
          "package pkg",
          "",
          "type Service struct {",
          "  name string",
          "}",
          "",
          "func (s *Service) Go() int { return 1 }",
          "",
          "func helper() int { return 2 }",
          "",
        ].join("\n"),
      );
      const overlays = await provider.buildFileSignals(root);
      expect([...overlays.keys()]).toEqual(["pkg/service.go"]);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // type_declaration → struct emitted by goNameOf as top-level symbol.
      expect(lookup.lookupByShortName("Service").length).toBeGreaterThan(0);
      // method_declaration and function_declaration.
      expect(lookup.lookupByShortName("Go").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("helper").length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildFileSignals dispatches .java files through extractFromJavaFile + javaNameOf", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-java-disp-"));
    try {
      mkdirSync(join(root, "com", "example"), { recursive: true });
      // class_declaration + nested method_declaration + constructor_declaration.
      // Also an interface_declaration to drive that branch in javaNameOf.
      writeFileSync(
        join(root, "com", "example", "Service.java"),
        [
          "package com.example;",
          "",
          "interface Greeter { String hello(); }",
          "",
          "public class Service {",
          "  public Service() {}",
          "  public int go() { return 1; }",
          "}",
          "",
        ].join("\n"),
      );
      const overlays = await provider.buildFileSignals(root);
      expect([...overlays.keys()]).toEqual(["com/example/Service.java"]);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // class_declaration (descendsInto=true) + interface_declaration.
      expect(lookup.lookupByShortName("Service").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("Greeter").length).toBeGreaterThan(0);
      // method_declaration nested → scope joined by "." (Java's separator).
      const go = lookup.lookupByShortName("go");
      expect(go.length).toBeGreaterThan(0);
      expect(go[0].symbolId).toContain("Service.go");
      // constructor_declaration also surfaces.
      expect(lookup.lookupByShortName("Service").some((s) => s.symbolId.includes("Service.Service"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildFileSignals dispatches .rs files through extractFromRustFile + rustNameOf with :: separator", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rs-disp-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      // Split across two files to exercise every branch of rustNameOf
      // without conflicting in the cg_symbols PRIMARY KEY (relPath +
      // symbolId). `mod_item` (mod helpers;), `struct_item`,
      // `trait_item`, `enum_item`, `function_item` go in lib.rs. The
      // `impl_item` branch — which uses the `type` field text as the
      // local name and joins methods under it with "::" — lives in
      // handler.rs against a distinct type name so it doesn't collide
      // with anything in lib.rs.
      writeFileSync(
        join(root, "src", "lib.rs"),
        [
          "mod helpers;",
          "",
          "struct Service { name: String }",
          "",
          "trait Runnable { fn run(&self); }",
          "",
          "enum Status { Ok, Err }",
          "",
          "fn helper() -> i32 { 2 }",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "src", "handler.rs"),
        ["impl Handler {", "  fn go(&self) -> i32 { 1 }", "}", ""].join("\n"),
      );
      const overlays = await provider.buildFileSignals(root);
      expect([...overlays.keys()].sort()).toEqual(["src/handler.rs", "src/lib.rs"]);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // lib.rs branches: struct_item, trait_item, enum_item, mod_item,
      // function_item.
      expect(lookup.lookupByShortName("Service").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("Runnable").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("Status").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("helper").length).toBeGreaterThan(0);
      // handler.rs: impl_item composes via "::" — Handler's `go` is at
      // `Handler::go`. Drives the impl_item branch in rustNameOf plus
      // the recursive descend (descendsInto: true).
      const goEntries = lookup.lookupByShortName("Handler::go");
      expect(goEntries.length).toBeGreaterThan(0);
      expect(goEntries[0].symbolId).toBe("Handler::go");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildFileSignals dispatches .sh files through extractFromBashFile + bashNameOf", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-sh-disp-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      // function_definition — bashNameOf's only branch.
      writeFileSync(
        join(root, "scripts", "deploy.sh"),
        [
          "#!/usr/bin/env bash",
          "function deploy() {",
          "  echo deploying",
          "}",
          "function rollback() {",
          "  echo undo",
          "}",
          "",
        ].join("\n"),
      );
      const overlays = await provider.buildFileSignals(root);
      expect([...overlays.keys()]).toEqual(["scripts/deploy.sh"]);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      expect(lookup.lookupByShortName("deploy").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("rollback").length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The LANGUAGES dispatch table aliases additional JavaScript and Bash
  // extensions onto the same walker/nameOf — .jsx, .mjs, .cjs all route
  // to the JS walker; .bash also routes to the Bash walker. These rows
  // exist because the loadParser arrows would otherwise be dead until
  // a real codebase hands the indexer a file with one of these
  // extensions. Drives every per-extension loadParser arrow.
  it("buildFileSignals dispatches .jsx / .mjs / .cjs / .bash extension aliases", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-alias-disp-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "scripts"), { recursive: true });
      // .jsx — JSX content; tree-sitter-javascript tolerates JSX nodes.
      // We keep the body to plain JS so collectSymbols sees normal
      // function_declaration regardless of JSX support level.
      writeFileSync(join(root, "src", "view.jsx"), "function View() { return null; }\n");
      // .mjs — ES module syntax.
      writeFileSync(join(root, "src", "mod.mjs"), "export function moduleEntry() { return 1; }\n");
      // .cjs — CommonJS.
      writeFileSync(
        join(root, "src", "cjs.cjs"),
        "function commonjsEntry() { return 2; }\nmodule.exports = { commonjsEntry };\n",
      );
      // .bash — bashNameOf via the .bash alias row.
      writeFileSync(join(root, "scripts", "tool.bash"), "function bashTool() { echo ok; }\n");

      const overlays = await provider.buildFileSignals(root);
      const keys = [...overlays.keys()].sort();
      expect(keys).toEqual(["scripts/tool.bash", "src/cjs.cjs", "src/mod.mjs", "src/view.jsx"]);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      expect(lookup.lookupByShortName("View").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("moduleEntry").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("commonjsEntry").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("bashTool").length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // extractOneFile defensive fallback: when a caller-supplied path
  // points at an extension NOT in LANGUAGES, the provider returns an
  // empty FileExtraction instead of throwing. Covers the
  // `if (!langConfig)` branch on line 419. We use `.coffee` — not in
  // the LANGUAGES table — so SUPPORTED_EXTS filtering keeps it out of
  // targetRelPaths but the overlay still gets emitted (zero-valued)
  // per the consistent-shape contract.
  it("buildFileSignals tolerates caller-supplied paths with unsupported extensions", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-unsupp-"));
    try {
      const overlays = await provider.buildFileSignals(root, {
        paths: ["pkg/legacy.coffee"],
      });
      expect(overlays.has("pkg/legacy.coffee")).toBe(true);
      // No symbol-table entries for the unsupported file.
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      expect(lookup.lookupByShortName("anything")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
