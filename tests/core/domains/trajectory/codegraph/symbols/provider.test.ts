import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ignore from "ignore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { GraphDbClient } from "../../../../../../src/core/contracts/types/codegraph.js";
import { BUILTIN_IGNORE_PATTERNS } from "../../../../../../src/core/domains/ingest/pipeline/ignore-defaults.js";
import { JavascriptCallResolver } from "../../../../../../src/core/domains/language/javascript/resolver/index.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
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
      // bd tea-rags-mcp-mk45 — JS resolver registered so JS-file edge
      // tests (synthetic constructor, new_expression dispatch, getter
      // helpers) can verify cg_symbols_edges_method rows, not just
      // symbol-table lookups.
      ...buildTestCodegraphDeps(
        new Map([
          ["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })],
          ["javascript", new JavascriptCallResolver()],
        ]),
      ),
      composer: new DefaultSymbolIdComposer(),
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

  describe("streamFileBatch + finalizeSignals (deferred file enrichment)", () => {
    const makeRoot = (): string => {
      const root = mkdtempSync(join(tmpdir(), "cg-stream-"));
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "export function a(): number { return 1; }\n");
      writeFileSync(
        join(root, "src", "b.ts"),
        'import { a } from "./a.js";\nexport function b(): number { return a(); }\n',
      );
      return root;
    };

    it("declares defersChunkEnrichment (chunk signals need the finalized graph)", () => {
      expect(provider.defersChunkEnrichment).toBe(true);
    });

    it("streamFileBatch extracts the batch and returns an empty map (signals deferred)", async () => {
      const root = makeRoot();
      try {
        const r = await provider.streamFileBatch(root, ["src/a.ts"]);
        expect(r).toBeInstanceOf(Map);
        expect(r.size).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("finalizeSignals returns file overlays for the streamed batches", async () => {
      const root = makeRoot();
      try {
        await provider.streamFileBatch(root, ["src/a.ts"]);
        await provider.streamFileBatch(root, ["src/b.ts"]);
        const file = await provider.finalizeSignals(root);
        expect(file).toBeInstanceOf(Map);
        expect(file.size).toBeGreaterThan(0);
        // Each overlay carries the file-level codegraph signal shape.
        const overlay = file.get("src/b.ts") ?? [...file.values()][0];
        expect(overlay).toHaveProperty("fanIn");
        expect(overlay).toHaveProperty("fanOut");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("keeps chunkSymbolByLine after finalize (deferred chunk needs it) and resets it at the next run start (leak bound)", async () => {
      const root = makeRoot();
      try {
        await provider.streamFileBatch(root, ["src/a.ts"]);
        await provider.finalizeSignals(root);
        const map = (provider as unknown as { chunkSymbolByLine: Map<string, Map<string, unknown>> }).chunkSymbolByLine;
        // Survives finalize: the post-finalize buildChunkSignals pass resolves
        // symbolIds from this map, so clearing it at finalize would zero every
        // chunk's fanIn/fanOut/pageRank.
        expect(map.has("__direct__")).toBe(true);
        const firstRunLineMap = map.get("__direct__");

        // A new run's first streamFileBatch resets the prior run's map (leak is
        // bounded to one run, not monotonic across runs).
        await provider.streamFileBatch(root, ["src/b.ts"]);
        const secondRunLineMap = map.get("__direct__");
        expect(map.has("__direct__")).toBe(true);
        expect(secondRunLineMap).not.toBe(firstRunLineMap);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
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
    expect(leafOverlay?.["fanIn"]).toBe(1);
    expect(leafOverlay?.["isLeaf"]).toBe(true);
    // btl8: connectionCount = fanIn + fanOut, support signal for instability
    // confidence — written inline by buildFileSignals so no extra DB call.
    expect(leafOverlay?.["connectionCount"]).toBe(1);
    const mainOverlay = overlays.get("src/main.ts");
    expect(mainOverlay?.["fanOut"]).toBe(1);
    expect(mainOverlay?.["instability"]).toBeCloseTo(1, 5);
    expect(mainOverlay?.["connectionCount"]).toBe(1);
    // isHub is computed at index time against collection p95 of fanIn.
    // Distribution here is [leaf=1, main=0] → p95 = 0.95. main (fanIn=0)
    // is not above p95, so it is not a hub.
    expect(mainOverlay?.["isHub"]).toBe(false);
    // leaf has fanIn=1 > p95(0.95) → it IS the hub of this tiny graph.
    expect(leafOverlay?.["isHub"]).toBe(true);
  });

  it("buildFileSignals marks the high-fanIn file isHub:true and low-fanIn files isHub:false (collection p95)", async () => {
    // Regression for tea-rags-mcp-he6g: isHub used to be hardcoded false
    // in buildFileSignals (placeholder for a rerank-time finalisation that
    // never existed), so every file was isHub:false and architecturalHub's
    // 0.35 isHub weight scored zero. isHub is now computed at index time
    // against the collection-wide p95 of fanIn pulled from the DuckDB graph.
    //
    // Graph: `hub.ts` is imported by a,b,c,d,e (fanIn=5); `mild.ts` is
    // imported by a (fanIn=1); the five importers and any other file have
    // fanIn=0. Distribution over the 7-file universe:
    //   [a=0,b=0,c=0,d=0,e=0, hub=5, mild=1] → sorted [0,0,0,0,0,1,5].
    // PERCENTILE_CONT(0.95) over n=7: idx 0.95*6=5.7 →
    //   interp(sorted[5]=1, sorted[6]=5, 0.7) = 1 + 0.7*(5-1) = 3.8.
    // hub fanIn=5 > 3.8 → isHub true. mild fanIn=1, importers fanIn=0 → false.
    const sink = provider.asExtractionSink();
    const importers = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
    for (const relPath of importers) {
      await sink.write({
        relPath,
        language: "typescript",
        imports: [{ importText: "./hub", startLine: 1 }],
        chunks: [],
        fileScope: [],
      });
    }
    // mild.ts imports hub too AND is imported by a (so a → mild edge).
    await sink.write({
      relPath: "src/a.ts",
      language: "typescript",
      imports: [
        { importText: "./hub", startLine: 1 },
        { importText: "./mild", startLine: 2 },
      ],
      chunks: [],
      fileScope: [],
    });
    // Register hub.ts and mild.ts as file rows in the universe.
    await sink.write({ relPath: "src/hub.ts", language: "typescript", imports: [], chunks: [], fileScope: [] });
    await sink.write({ relPath: "src/mild.ts", language: "typescript", imports: [], chunks: [], fileScope: [] });
    await sink.finish();

    const overlays = await provider.buildFileSignals("/", {
      paths: [...importers, "src/hub.ts", "src/mild.ts"],
    });

    // Sanity on the distribution before asserting the derived boolean.
    expect(overlays.get("src/hub.ts")?.["fanIn"]).toBe(5);
    expect(overlays.get("src/mild.ts")?.["fanIn"]).toBe(1);

    expect(overlays.get("src/hub.ts")?.["isHub"]).toBe(true);
    expect(overlays.get("src/mild.ts")?.["isHub"]).toBe(false);
    expect(overlays.get("src/b.ts")?.["isHub"]).toBe(false);
  });

  it("resolveRoot is identity — the slice scans the literal absolute path it is given", () => {
    expect(provider.resolveRoot("/abs/path")).toBe("/abs/path");
  });

  it("buildFileSignals auto-discovers TS/TSX files on disk when no paths option is provided", async () => {
    // Build a small project tree under the worktree's tmp dir. The walker
    // must:
    //   1. Recurse into nested dirs.
    //   2. Skip FileScanner ignoreFilter matches (node_modules/ via
    //      BUILTIN_IGNORE_PATTERNS).
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
      // No .ts extension — must be ignored by SUPPORTED_EXTS filter.
      writeFileSync(join(root, "src", "notes.md"), "ignored");
      // Inside node_modules — must be ignored by FileScanner ignoreFilter
      // (BUILTIN_IGNORE_PATTERNS lists `node_modules/`).
      writeFileSync(join(root, "node_modules", "junk", "lib.ts"), "export const skip = 1;");
      // Hidden dir (starts with '.') — must be ignored by dotfile guard.
      writeFileSync(join(root, ".hidden", "secret.ts"), "export const hidden = 1;");
      // Extensionless file in a real dir — must be skipped silently by
      // extensionOf returning "".
      writeFileSync(join(root, "src", "Makefile"), "all:\n\techo hi\n");

      const ignoreFilter = ignore().add(BUILTIN_IGNORE_PATTERNS);
      const overlays = await provider.buildFileSignals(root, { ignoreFilter });
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

  // Real-world bug from ugnest indexing (2026-05-21): the discover walker
  // descended into `legacy/uapi/frontend/_nuxt/` and extracted 96k method
  // edges from one minified bundle. Post-tf1o the codegraph layer no
  // longer owns a duplicate dir blocklist — the FileScanner ignoreFilter
  // (passed via FileSignalOptions) carries BUILTIN_IGNORE_PATTERNS that
  // covers framework build artefacts (`_nuxt/`, `.next/`, `target/`,
  // `.gradle/`) and language caches (`__pycache__/`, `.venv/`). This
  // test wires the same BUILTIN_IGNORE_PATTERNS the production pipeline
  // uses, verifying the layered ignore prevents the regression.
  it("discoverSupportedFiles skips framework build dirs / caches via FileScanner ignoreFilter", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-ignore-dirs-"));
    try {
      // Legitimate source — must survive.
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "real.ts"), "export function real(): number { return 1; }\n");

      // Framework dirs that previously slipped through.
      mkdirSync(join(root, "_nuxt"), { recursive: true });
      writeFileSync(join(root, "_nuxt", "bundle.ts"), "export const x = 1;");
      mkdirSync(join(root, "target"), { recursive: true });
      writeFileSync(join(root, "target", "Out.ts"), "export const out = 1;");
      mkdirSync(join(root, "__pycache__"), { recursive: true });
      writeFileSync(join(root, "__pycache__", "junk.py"), "x = 1");
      mkdirSync(join(root, ".venv"), { recursive: true });
      writeFileSync(join(root, ".venv", "stub.py"), "x = 1");

      const ignoreFilter = ignore().add(BUILTIN_IGNORE_PATTERNS);
      const overlays = await provider.buildFileSignals(root, { ignoreFilter });
      const keys = [...overlays.keys()].sort();
      // Only the legitimate file appears; every framework dir skipped.
      expect(keys).toEqual(["src/real.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // tea-rags-mcp-tf1o — FileScanner ignoreFilter integration. Codegraph
  // honours the same `.gitignore`-style rules the main Qdrant ingest uses
  // so the file sets stay aligned. Synthetic: caller's ignoreFilter
  // excludes `legacy/`, and codegraph must NOT walk legacy/foo.ts.
  it("discoverSupportedFiles honours an explicit ignoreFilter from FileScanner", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-ignore-filter-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "legacy"), { recursive: true });
      writeFileSync(join(root, "src", "real.ts"), "export function real(): number { return 1; }\n");
      writeFileSync(join(root, "legacy", "old.ts"), "export const legacy = 1;");

      const ignoreFilter = ignore().add(["legacy/"]);
      const overlays = await provider.buildFileSignals(root, { ignoreFilter });
      const keys = [...overlays.keys()].sort();
      expect(keys).toEqual(["src/real.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // tea-rags-mcp-tf1o + hh4m — codegraph-layer test exclusion. Tests are
  // legitimate Qdrant ingest targets but skew the fan-graph (fanIn=0,
  // fanOut=many). Default `excludeTests:true` keeps them out of the
  // graph without affecting search-side indexing.
  it("discoverSupportedFiles skips test files when excludeTests=true", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-tests-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "tests"), { recursive: true });
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(join(root, "src", "service.ts"), "export function service(): number { return 1; }\n");
      writeFileSync(join(root, "src", "service.test.ts"), "export const test = 1;");
      writeFileSync(join(root, "tests", "integration.ts"), "export const it = 1;");
      writeFileSync(join(root, "lib", "service_test.go"), "package lib");
      writeFileSync(join(root, "lib", "User_spec.rb"), "puts 1");

      const testExcluder = new CodegraphEnrichmentProvider({
        graphDb: client,
        symbolTable: new InMemoryGlobalSymbolTable(),
        ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
        composer: new DefaultSymbolIdComposer(),
        exclusion: { excludeTests: true, customPatterns: [] },
      });
      const overlays = await testExcluder.buildFileSignals(root);
      const keys = [...overlays.keys()].sort();
      // Only the production source survives; every test-shaped path is
      // filtered by CODEGRAPH_TEST_PATTERNS.
      expect(keys).toEqual(["src/service.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // tea-rags-mcp-tf1o — early dir-level skip is a perf optimisation but
  // also a behaviour contract: ignoreFilter dir matches must short-circuit
  // recursion. Synthetic: `_nuxt/` is a directory pattern in BUILTIN_IGNORE_PATTERNS;
  // dropping a deeply-nested .ts file inside must NOT be visited.
  it("discoverSupportedFiles short-circuits at the dir level when ignoreFilter matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-dir-skip-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      // Nested dir tree under _nuxt — provider MUST NOT recurse here.
      mkdirSync(join(root, "_nuxt", "static", "chunks"), { recursive: true });
      writeFileSync(join(root, "src", "main.ts"), "export const m = 1;\n");
      writeFileSync(join(root, "_nuxt", "static", "chunks", "deep.ts"), "export const skip = 1;");

      const ignoreFilter = ignore().add(BUILTIN_IGNORE_PATTERNS);
      const overlays = await provider.buildFileSignals(root, { ignoreFilter });
      const keys = [...overlays.keys()].sort();
      expect(keys).toEqual(["src/main.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // tea-rags-mcp-tf1o — custom user patterns layer on top of test
  // exclusion. The user supplies `CODEGRAPH_CUSTOM_EXCLUDE` via env;
  // patterns added to the codegraph filter alongside the test set.
  it("discoverSupportedFiles applies customPatterns from CodegraphExclusionOptions", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-custom-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "generated"), { recursive: true });
      writeFileSync(join(root, "src", "real.ts"), "export const r = 1;\n");
      writeFileSync(join(root, "generated", "stub.ts"), "export const stub = 1;");

      const customExcluder = new CodegraphEnrichmentProvider({
        graphDb: client,
        symbolTable: new InMemoryGlobalSymbolTable(),
        ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
        composer: new DefaultSymbolIdComposer(),
        exclusion: { excludeTests: false, customPatterns: ["generated/**"] },
      });
      const overlays = await customExcluder.buildFileSignals(root);
      const keys = [...overlays.keys()].sort();
      expect(keys).toEqual(["src/real.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("shouldEnrich", () => {
    const base = { isSource: true, isGenerated: false, isDocumentation: false, isTest: false };

    function buildProvider(excludeTests: boolean): CodegraphEnrichmentProvider {
      return new CodegraphEnrichmentProvider({
        graphDb: client,
        symbolTable: new InMemoryGlobalSymbolTable(),
        ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
        composer: new DefaultSymbolIdComposer(),
        exclusion: { excludeTests, customPatterns: [] },
      });
    }

    it("skips generated and test files when excludeTests is on", () => {
      const strict = buildProvider(true);
      expect(
        strict.shouldEnrich({ relPath: "db/schema.rb", classification: { ...base, isSource: false, isGenerated: true } }),
      ).toBe("none");
      expect(strict.shouldEnrich({ relPath: "spec/user_spec.rb", classification: { ...base, isTest: true } })).toBe(
        "none",
      );
      expect(strict.shouldEnrich({ relPath: "app/models/user.rb", classification: base })).toBe("full");
    });

    it("keeps test files when excludeTests is off, but generated stays none", () => {
      const loose = buildProvider(false);
      expect(loose.shouldEnrich({ relPath: "spec/user_spec.rb", classification: { ...base, isTest: true } })).toBe(
        "full",
      );
      expect(
        loose.shouldEnrich({ relPath: "db/schema.rb", classification: { ...base, isSource: false, isGenerated: true } }),
      ).toBe("none");
    });
  });

  // Real-world bug from the tea-rags self-test on 2026-05-21:
  // `coordinator.ts` declares a getter + setter pair for the same
  // property (`onChunkEnrichmentComplete`). Both AST nodes carry
  // identical names — without dedup the symbol-table upsert blew up on
  // the (rel_path, symbol_id) PK. Dedup at extraction time keeps the
  // first occurrence (earliest line — the getter, by convention).
  it("collectSymbols deduplicates same-name declarations within a class (get/set pair)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-getset-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "accessors.ts"),
        [
          "export class Coordinator {",
          "  private _cb?: () => void;",
          "  get onComplete(): (() => void) | undefined { return this._cb; }",
          "  set onComplete(cb: (() => void) | undefined) { this._cb = cb; }",
          "}",
          "",
        ].join("\n"),
      );

      await provider.buildFileSignals(root);

      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // Exactly one entry for the accessor name — get/set collapse.
      const entries = lookup.lookupByShortName("onComplete");
      expect(entries).toHaveLength(1);
      expect(entries[0].symbolId).toBe("Coordinator#onComplete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Real-world bug from the tea-rags self-test on 2026-05-21:
  // `benchmarks/lib/benchmarks.mjs` has four private `async function worker()`
  // helpers, each nested inside a different outer benchmark function.
  // collectSymbols used to push every nested function at the file's empty
  // scope, producing four `worker` rows with the same symbolId and
  // colliding on the (rel_path, symbol_id) PK of cg_symbols. The fix:
  // recurse into a matched node's children under the EXTENDED scope (the
  // matched name), regardless of `descendsInto`. Nested same-name
  // declarations now get distinct ids like `outer.worker`.
  it("collectSymbols qualifies nested same-name declarations under their enclosing scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-nested-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "bench.js"),
        [
          "export function outerA() {",
          "  async function worker() { return 1; }",
          "  return worker();",
          "}",
          "export function outerB() {",
          "  async function worker() { return 2; }",
          "  return worker();",
          "}",
          "",
        ].join("\n"),
      );

      // Should not throw; before the fix this would crash on the
      // symbol-table upsert when the cg_symbols PK rejected the
      // duplicate (rel_path, symbol_id) pair.
      await provider.buildFileSignals(root);

      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // Both nested workers are tracked under distinct qualified ids.
      const workers = lookup.lookupByShortName("worker");
      const ids = workers.map((s) => s.symbolId).sort();
      expect(ids).toEqual(["outerA.worker", "outerB.worker"]);
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
      expect(overlays.get("src/b.md")?.["fanIn"]).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Regression — production ingest threads its file set as
  // `options.paths` (so `discoverSupportedFiles` is bypassed entirely),
  // and the codegraph-layer exclusion MUST still apply on that branch.
  // Without filtering caller-supplied paths the live MCP path lets
  // conftest.py / tests/**/*_admin.py / config/.../test_*.py through —
  // observed on ugnest 2026-05-21 with `excludeTests:true` and 133+
  // test paths landing in cg_symbols_files.
  //
  // Assertion strategy: check the symbol-table side (the walker's
  // output that lands in cg_symbols_files in production). The overlay
  // map intentionally includes a zero-valued row for every caller-listed
  // path (consistent shape for EnrichmentApplier) — but the walker MUST
  // NOT touch excluded paths, so no entries should land in the symbol
  // table.
  it("buildFileSignals applies codegraph exclusion to CALLER-supplied paths (production ingest path)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-paths-excl-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "config", "tests"), { recursive: true });
      mkdirSync(join(root, "config", "management", "commands"), { recursive: true });
      mkdirSync(join(root, "domains", "engagement", "tests", "test_admin"), { recursive: true });
      writeFileSync(join(root, "src", "main.ts"), "export function main(): number { return 1; }\n");
      // Real ugnest-shaped test-file layout the regression report listed.
      writeFileSync(join(root, "conftest.py"), "import pytest\n");
      writeFileSync(join(root, "config", "tests", "test_settings.py"), "def test_x(): pass\n");
      writeFileSync(join(root, "config", "management", "commands", "test_vk_login.py"), "def test_y(): pass\n");
      writeFileSync(
        join(root, "domains", "engagement", "tests", "test_admin", "test_reaction_admin.py"),
        "def test_z(): pass\n",
      );

      const symbolTable = new InMemoryGlobalSymbolTable();
      const excluder = new CodegraphEnrichmentProvider({
        graphDb: client,
        symbolTable,
        ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
        composer: new DefaultSymbolIdComposer(),
        exclusion: { excludeTests: true, customPatterns: [] },
      });

      // Caller (EnrichmentCoordinator -> FilePhase) hands the full set of
      // walked files in options.paths. Without the fix, all 5 paths get
      // walked + recorded in cg_symbols. With the fix, only src/main.ts
      // is walked by extractOneFile + asExtractionSink.
      await excluder.buildFileSignals(root, {
        paths: [
          "src/main.ts",
          "conftest.py",
          "config/tests/test_settings.py",
          "config/management/commands/test_vk_login.py",
          "domains/engagement/tests/test_admin/test_reaction_admin.py",
        ],
      });

      // Walker output lives in the symbol table (the same data the
      // production path persists to cg_symbols_files via the sink).
      // Excluded test paths must NOT have produced any symbol rows.
      const allFiles = new Set((await client.listAllSymbols()).map((s) => s.relPath));
      expect(allFiles.has("src/main.ts")).toBe(true);
      expect(allFiles.has("conftest.py")).toBe(false);
      expect(allFiles.has("config/tests/test_settings.py")).toBe(false);
      expect(allFiles.has("config/management/commands/test_vk_login.py")).toBe(false);
      expect(allFiles.has("domains/engagement/tests/test_admin/test_reaction_admin.py")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Inverse: with excludeTests=false, caller-supplied test paths must
  // still get processed — codegraphExclusionFilter is a no-op then.
  it("buildFileSignals walks caller-supplied test paths when excludeTests=false", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-paths-no-excl-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "main.ts"), "export function main(): number { return 1; }\n");
      writeFileSync(join(root, "conftest.py"), "def configure(): return 1\n");

      const symbolTable = new InMemoryGlobalSymbolTable();
      const noExcluder = new CodegraphEnrichmentProvider({
        graphDb: client,
        symbolTable,
        ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
        composer: new DefaultSymbolIdComposer(),
        exclusion: { excludeTests: false, customPatterns: [] },
      });

      await noExcluder.buildFileSignals(root, {
        paths: ["src/main.ts", "conftest.py"],
      });

      const allFiles = new Set((await client.listAllSymbols()).map((s) => s.relPath));
      expect(allFiles.has("src/main.ts")).toBe(true);
      expect(allFiles.has("conftest.py")).toBe(true);
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
      expect(overlays.get("src/ok.ts")?.["fanIn"]).toBe(0);
      expect(overlays.get("src/missing.ts")?.["fanIn"]).toBe(0);
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
    expect(main?.["fanOut"]).toBe(1);
    const fooBar = overlays.get("src/foo.ts")?.get("chunk-foo-bar");
    expect(fooBar?.["fanIn"]).toBe(1);
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
    expect(head?.["fanIn"]).toBe(1);
    expect(tail?.["fanIn"]).toBe(1);
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
    // Slice 2 contract: recompute is driven via streamAdjacency + replaceCycles
    // + replacePageRanks. Stub streamAdjacency to throw so the metric
    // recompute path fails — finish() must still resolve because metric
    // failures are wrapped in CodegraphMetricsError and swallowed.
    const fakeGraphDb = {
      upsertFile: async () => undefined,
      upsertSymbols: async () => undefined,
      removeFile: async () => undefined,
      removeSymbolsForFile: async () => undefined,
      checkpoint: async () => undefined,
      streamAdjacency: (): AsyncIterableIterator<[string, string]> => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<IteratorResult<[string, string]>> {
          // Iterator throws on first .next() — exactly what the
          // recompute path hits when it iterates streamAdjacency.
          throw new Error("simulated cycle recompute failure");
        },
      }),
      listAdjacency: async () => new Map<string, string[]>(),
      replaceCycles: async () => undefined,
      replacePageRanks: async () => undefined,
      getPageRank: async () => 0,
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
      ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
      composer: new DefaultSymbolIdComposer(),
    });
    const sink = failingProvider.asExtractionSink();
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [] }],
      fileScope: [],
    });
    // streamAdjacency throws inside finish — wrapped as
    // CodegraphMetricsError and swallowed so the indexing pipeline
    // does not abort.
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
      checkpoint: async () => undefined,
      streamAdjacency: (): AsyncIterableIterator<[string, string]> => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<IteratorResult<[string, string]>> {
          throw new Error("debug-path cycle failure");
        },
      }),
      listAdjacency: async () => new Map<string, string[]>(),
      replaceCycles: async () => undefined,
      replacePageRanks: async () => undefined,
      getPageRank: async () => 0,
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
      ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
      composer: new DefaultSymbolIdComposer(),
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
      // Nested instance method — Python `def go(self)` inside class
      // is an instance method, joins to parent with `#` per
      // symbolid-convention.md.
      const goEntries = lookup.lookupByShortName("go");
      expect(goEntries.length).toBeGreaterThan(0);
      expect(goEntries[0].symbolId).toContain("Service#go");
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
      // Ruby `def find` is an instance method → joins to its class
      // with `#`. `def self.recent` is a singleton (class) method →
      // joins with `.`. Per symbolid-convention.md the separator
      // between class and method is universal (`#` instance / `.`
      // static) regardless of language — Ruby's `::` is only the
      // NAMESPACE separator (e.g. `Acme::Auth`).
      const findEntries = lookup.lookupByShortName("find");
      expect(findEntries[0].symbolId).toBe("User#find");
      // singleton_method branch in rbNameOf — class method via `.`.
      const recentEntries = lookup.lookupByShortName("recent");
      expect(recentEntries[0].symbolId).toBe("User.recent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits synthetic methods from Ruby DSL macros (attr_accessor / attr_reader / attr_writer)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-attr-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "user.rb"),
        ["class User", "  attr_accessor :name, :email", "  attr_reader :id", "  attr_writer :password", "end", ""].join(
          "\n",
        ),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // attr_accessor → reader + writer for each name.
      expect(lookup.lookupByShortName("name").some((s) => s.symbolId === "User#name")).toBe(true);
      expect(lookup.lookupByShortName("name=").some((s) => s.symbolId === "User#name=")).toBe(true);
      expect(lookup.lookupByShortName("email").some((s) => s.symbolId === "User#email")).toBe(true);
      expect(lookup.lookupByShortName("email=").some((s) => s.symbolId === "User#email=")).toBe(true);
      // attr_reader → reader only.
      expect(lookup.lookupByShortName("id").some((s) => s.symbolId === "User#id")).toBe(true);
      expect(lookup.lookupByShortName("id=").some((s) => s.symbolId === "User#id=")).toBe(false);
      // attr_writer → writer only.
      expect(lookup.lookupByShortName("password").some((s) => s.symbolId === "User#password")).toBe(false);
      expect(lookup.lookupByShortName("password=").some((s) => s.symbolId === "User#password=")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits synthetic methods from ActiveRecord associations (has_many / belongs_to / has_one)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-ar-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "user.rb"),
        ["class User", "  has_many :products", "  belongs_to :company", "  has_one :profile", "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // has_many :products → reader + writer.
      expect(lookup.lookupByShortName("products").some((s) => s.symbolId === "User#products")).toBe(true);
      expect(lookup.lookupByShortName("products=").some((s) => s.symbolId === "User#products=")).toBe(true);
      // belongs_to :company → name + name= + name_id + name_id=.
      expect(lookup.lookupByShortName("company").some((s) => s.symbolId === "User#company")).toBe(true);
      expect(lookup.lookupByShortName("company=").some((s) => s.symbolId === "User#company=")).toBe(true);
      expect(lookup.lookupByShortName("company_id").some((s) => s.symbolId === "User#company_id")).toBe(true);
      expect(lookup.lookupByShortName("company_id=").some((s) => s.symbolId === "User#company_id=")).toBe(true);
      // has_one :profile → reader + writer.
      expect(lookup.lookupByShortName("profile").some((s) => s.symbolId === "User#profile")).toBe(true);
      expect(lookup.lookupByShortName("profile=").some((s) => s.symbolId === "User#profile=")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits synthetic methods from has_and_belongs_to_many", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-habtm-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "post.rb"),
        ["class Post", "  has_and_belongs_to_many :tags", "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      expect(lookup.lookupByShortName("tags").some((s) => s.symbolId === "Post#tags")).toBe(true);
      expect(lookup.lookupByShortName("tags=").some((s) => s.symbolId === "Post#tags=")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits forwarder methods from `delegate :a, :b, to: :other`", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-delegate-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "user.rb"),
        ["class User", "  delegate :email, :name, to: :profile", "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      expect(lookup.lookupByShortName("email").some((s) => s.symbolId === "User#email")).toBe(true);
      expect(lookup.lookupByShortName("name").some((s) => s.symbolId === "User#name")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("indexes `define_method(:literal)` as if it were a regular def", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-dm-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "router.rb"),
        ["class Router", "  define_method(:get) { 1 }", '  define_method("post") { 2 }', "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      expect(lookup.lookupByShortName("get").some((s) => s.symbolId === "Router#get")).toBe(true);
      expect(lookup.lookupByShortName("post").some((s) => s.symbolId === "Router#post")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // bd tea-rags-mcp-y2z5 — `alias_method :new_name, :old_name` declares
  // the new name as a synthetic instance method on the enclosing class.
  // Exercises `rubyAliasMethodEmission` in provider.ts.
  it("emits synthetic instance method for `alias_method :new_name, :old_name` (bd y2z5)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-am-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "foo.rb"),
        ["class Foo", "  def old_name; end", "  alias_method :new_name, :old_name", "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      expect(lookup.lookupByShortName("new_name").some((s) => s.symbolId === "Foo#new_name")).toBe(true);
      // The target `old_name` is the regular def — still present.
      expect(lookup.lookupByShortName("old_name").some((s) => s.symbolId === "Foo#old_name")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The `alias` keyword form is a different AST node type than `call` —
  // exercises `rubyAliasKeywordEmission` in provider.ts.
  it("emits synthetic instance method for `alias new_name old_name` keyword form (bd y2z5)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-aliaskw-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "bar.rb"),
        ["class Bar", "  def old_name; end", "  alias new_name old_name", "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      expect(lookup.lookupByShortName("new_name").some((s) => s.symbolId === "Bar#new_name")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Negative: receiver-qualified `obj.alias_method :a, :b` is NOT a
  // class-body DSL — should NOT emit a synthetic symbol.
  it("does NOT emit synthetic from receiver-qualified `obj.alias_method :a, :b`", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-am-recv-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "baz.rb"),
        ["class Baz", "  def setup", "    obj.alias_method :a, :b", "  end", "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // No Baz#a from the receiver-qualified call.
      expect(lookup.lookupByShortName("a").some((s) => s.symbolId === "Baz#a")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT index `define_method(var)` with a dynamic argument", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-dm-dyn-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "router.rb"),
        ["class Router", "  [:get, :post].each do |verb|", "    define_method(verb) { 1 }", "  end", "end", ""].join(
          "\n",
        ),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // Dynamic arg — nothing named `verb` indexed.
      expect(lookup.lookupByShortName("verb")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `define_method()` with an empty argument list — the symbol-name slot
  // exists but `firstArg` is undefined. `rubyDefineMethodEmission` must
  // return null without crashing (covers the `if (!firstArg) return null;`
  // guard). The file should still build with no synthetic method named
  // `define_method` leaking into the symbol table.
  it("does NOT index `define_method()` with no arguments", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-dm-empty-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "router.rb"),
        ["class Router", "  define_method() { 1 }", "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // Nothing emitted under Router — the empty-arg form bails early.
      expect(lookup.lookupByShortName("define_method")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `define_method(123)` — first arg is neither `simple_symbol` nor
  // `string`/`string_literal`. Name stays null → emission returns null.
  // Covers the fall-through in `rubyDefineMethodEmission` past both
  // literal branches without matching.
  it("does NOT index `define_method(123)` with a numeric argument", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-dm-num-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "router.rb"),
        ["class Router", "  define_method(123) { 1 }", "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // Numeric arg is not a static method name.
      expect(lookup.lookupByShortName("123")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits a class method from `scope :active, -> { ... }`", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-scope-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "post.rb"),
        ["class Post", "  scope :active, -> { where(active: true) }", "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // scope creates a class method, hence `Post.active` not `Post#active`.
      expect(lookup.lookupByShortName("active").some((s) => s.symbolId === "Post.active")).toBe(true);
      expect(lookup.lookupByShortName("active").some((s) => s.symbolId === "Post#active")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT emit DSL symbols for non-macro method calls (regular code)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-non-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "user.rb"),
        ["class User", "  def something", "    save(:to_disk)", "    process(:other_arg)", "  end", "end", ""].join(
          "\n",
        ),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // `save(:to_disk)` is not a DSL macro — no symbol named `to_disk`
      // should appear.
      expect(lookup.lookupByShortName("to_disk")).toEqual([]);
      expect(lookup.lookupByShortName("other_arg")).toEqual([]);
      // The real method `something` remains.
      expect(lookup.lookupByShortName("something").some((s) => s.symbolId === "User#something")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT emit DSL symbols for receiver-qualified macro calls (`obj.attr_accessor :x`)", async () => {
    // Guard branch: rubyMacroEmission must skip nodes whose `receiver` field
    // is populated — those are regular method calls on an object, not the
    // class-body DSL form. Without this guard, `obj.attr_accessor :name`
    // would synthesize `User#name` accessors that don't exist at runtime.
    const root = mkdtempSync(join(tmpdir(), "cg-rb-receiver-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "user.rb"),
        [
          "class User",
          "  def configure(obj)",
          "    obj.attr_accessor :forwarded",
          "    obj.has_many :proxied",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // No synthetic accessors emitted — receiver guard rejected both
      // calls before the macro builder ran.
      expect(lookup.lookupByShortName("forwarded")).toEqual([]);
      expect(lookup.lookupByShortName("forwarded=")).toEqual([]);
      expect(lookup.lookupByShortName("proxied")).toEqual([]);
      // The real method `configure` is still extracted normally.
      expect(lookup.lookupByShortName("configure").some((s) => s.symbolId === "User#configure")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT emit DSL symbols when a macro is invoked with no arguments or with non-symbol args", async () => {
    // Two guards exercised here:
    //   1. `attr_accessor` standalone — no argument_list at all (line 1375
    //      fallback: `if (!args) return null`).
    //   2. `attr_accessor variable_name` — args present but none of them
    //      are `simple_symbol` nodes, so symbolBases stays empty (line
    //      1383: `if (symbolBases.length === 0) return null`).
    const root = mkdtempSync(join(tmpdir(), "cg-rb-no-args-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "user.rb"),
        [
          "class User",
          "  attr_accessor",
          "  attr_accessor variable_name",
          "  has_many @runtime_list",
          "  def real_method",
          "    @x",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // No synthetic accessors from any of the malformed macro calls.
      expect(lookup.lookupByShortName("variable_name")).toEqual([]);
      expect(lookup.lookupByShortName("variable_name=")).toEqual([]);
      expect(lookup.lookupByShortName("runtime_list")).toEqual([]);
      expect(lookup.lookupByShortName("runtime_list=")).toEqual([]);
      // The real method survives, confirming the file parsed and walked.
      expect(lookup.lookupByShortName("real_method").some((s) => s.symbolId === "User#real_method")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies `def foo` inside `class << self` block as a class method (Foo.foo, not Foo#foo)", async () => {
    // Two-channel singleton declaration: tree-sitter-ruby parses
    // `def self.bar` as `singleton_method` (handled by the existing
    // branch) AND `class << self / def bar / end` as a regular `method`
    // node wrapped in `singleton_class`. Both should produce the
    // class-method symbolId form `Class.method` per the convention.
    const root = mkdtempSync(join(tmpdir(), "cg-rb-singleton-"));
    try {
      mkdirSync(join(root, "app", "models"), { recursive: true });
      writeFileSync(
        join(root, "app", "models", "post.rb"),
        [
          "class Post",
          "  class << self",
          "    def recent",
          "      []",
          "    end",
          "    def published",
          "      []",
          "    end",
          "  end",
          "  def title",
          "    @title",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // Methods inside class << self → class form `.`.
      const recent = lookup.lookupByShortName("recent");
      expect(recent[0].symbolId).toBe("Post.recent");
      const published = lookup.lookupByShortName("published");
      expect(published[0].symbolId).toBe("Post.published");
      // Methods OUTSIDE the singleton block remain instance form `#`.
      const title = lookup.lookupByShortName("title");
      expect(title[0].symbolId).toBe("Post#title");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // bd tea-rags-mcp-08v2 — `extend self` in a module promotes every instance
  // method to ALSO be callable as a module-level method. Provider must emit
  // BOTH `M#foo` (instance) and `M.foo` (static) for each regular `def` in
  // the module body. The chunker emits the single instance form (it walks
  // each AST node once); the codegraph aliasing makes `M.foo(...)` call
  // sites resolve to the same source.
  it("emits both instance AND static form for methods in `module M; extend self` (bd 08v2)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-extend-self-"));
    try {
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(
        join(root, "lib", "logger.rb"),
        [
          "module Logger",
          "  extend self",
          "  def info(msg)",
          "    puts msg",
          "  end",
          "  def warn(msg)",
          "    puts msg",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // Each method emits TWO symbols: instance + static.
      const info = lookup.lookupByShortName("info");
      const infoIds = info.map((s) => s.symbolId).sort();
      expect(infoIds).toEqual(["Logger#info", "Logger.info"]);
      const warn = lookup.lookupByShortName("warn");
      const warnIds = warn.map((s) => s.symbolId).sort();
      expect(warnIds).toEqual(["Logger#warn", "Logger.warn"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Plain modules WITHOUT `extend self` must keep instance-only emission
  // (no static-form alias). Guard against the dual-emission firing on
  // every module.
  it("does NOT dual-emit for plain `module M` without `extend self`", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-plain-mod-"));
    try {
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(
        join(root, "lib", "helpers.rb"),
        ["module Helpers", "  def humanize(s)", "    s", "  end", "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      const ids = lookup
        .lookupByShortName("humanize")
        .map((s) => s.symbolId)
        .sort();
      // Only the instance form — no `Helpers.humanize` alias.
      expect(ids).toEqual(["Helpers#humanize"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `extend self` inside a CLASS body (rare, semantically different from
  // module form) must NOT trigger the dual-emit. The class form opens the
  // singleton class of the instance — `classifyMethod`'s singleton_class
  // detection handles those `def`s separately. Module-only is the
  // conventional case the dual-emit targets.
  it("does NOT dual-emit when `extend self` appears inside a class (not a module)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-extend-self-class-"));
    try {
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(
        join(root, "lib", "weird.rb"),
        ["class Weird", "  extend self", "  def foo", "    1", "  end", "end", ""].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      const ids = lookup
        .lookupByShortName("foo")
        .map((s) => s.symbolId)
        .sort();
      // Class container — instance-only emission.
      expect(ids).toEqual(["Weird#foo"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // `refine ClassName do ... def foo ... end end` — the refine block redefines
  // instance methods of ClassName but only within the refinement's lexical
  // scope (activated via `using Refinements`). Full refinement-aware
  // resolution is out of scope for this slice; at minimum the provider must
  // not crash AND must emit each `def` inside the refine block as a symbol
  // (it lands at the surrounding module's scope per the current walker logic).
  it("does not crash on `refine A do; def foo; end; end` and emits the method symbol", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rb-refine-"));
    try {
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(
        join(root, "lib", "refinements.rb"),
        [
          "module StringRefinements",
          "  refine String do",
          "    def shout",
          "      upcase + '!'",
          "    end",
          "  end",
          "end",
          "",
        ].join("\n"),
      );
      // The call must succeed — exercise the `do_block` interior walk path
      // without throwing.
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // The `def shout` symbol exists — exact symbolId form is an
      // implementation detail tracked in a follow-up bead (refine-aware
      // resolution). At minimum the short-name is reachable so callers
      // looking it up don't see zero rows.
      const shout = lookup.lookupByShortName("shout");
      expect(shout.length).toBeGreaterThan(0);
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
      // Method nested in class — JS class method without `static` is
      // an instance method, joins with `#`.
      const go = lookup.lookupByShortName("go");
      expect(go.length).toBeGreaterThan(0);
      expect(go[0].symbolId).toContain("Service#go");
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

  it("Go method_declaration emits Receiver#Method fqName so distinct receivers don't collide", async () => {
    // Per .claude/rules/symbolid-convention.md, Go instance methods are
    // Receiver#Method form. Without the receiver prefix, methods with the
    // same shortName (e.g. (*Context).Query vs (*Bind).Query) collapse in
    // the symbol table and fabricate false-positive cycles plus mis-routed
    // call edges (gin: false cycle Query↔GetQuery↔GetQueryArray↔initQueryCache).
    const root = mkdtempSync(join(tmpdir(), "cg-go-recv-"));
    try {
      mkdirSync(join(root, "pkg"), { recursive: true });
      writeFileSync(
        join(root, "pkg", "context.go"),
        [
          "package pkg",
          "",
          "type Context struct{}",
          "type Bind struct{}",
          "",
          'func (c *Context) Query() string { return "" }',
          'func (b *Bind) Query() string { return "" }',
          "",
        ].join("\n"),
      );
      const overlays = await provider.buildFileSignals(root);
      expect([...overlays.keys()]).toEqual(["pkg/context.go"]);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // Both qualified forms exist (no merge by shortName).
      expect(lookup.lookup("Context#Query").length).toBe(1);
      expect(lookup.lookup("Bind#Query").length).toBe(1);
      // Pointer-receiver `*Context` strips to bare `Context`.
      expect(lookup.lookup("Context#Query")[0]?.relPath).toBe("pkg/context.go");
      // shortName lookup still works (single shortName "Query" → 2 hits).
      expect(lookup.lookupByShortName("Query").length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extractGoReceiverType handles value and generic value receivers without collapsing into the same symbol", async () => {
    // Exercises the non-pointer (value-receiver) and generic_type branches
    // of extractGoReceiverType. Value receivers (`func (s Service) ...`)
    // skip the pointer_type wrapper and read type_identifier directly;
    // generic value receivers (`func (b Box[T]) ...`) carry typeNode as
    // a generic_type whose `type` field is the bare base name. Both must
    // compose as Receiver#Method (NOT Receiver[T]#Method) so distinct
    // receivers with the same method name do not collide.
    const root = mkdtempSync(join(tmpdir(), "cg-go-recv-variants-"));
    try {
      mkdirSync(join(root, "pkg"), { recursive: true });
      writeFileSync(
        join(root, "pkg", "variants.go"),
        [
          "package pkg",
          "",
          "type Service struct{}",
          "type Box[T any] struct{ v T }",
          "",
          // Value receiver — typeNode is type_identifier directly (no pointer_type wrap).
          'func (s Service) Open() string { return "" }',
          // Generic value receiver — typeNode is generic_type directly
          // (no pointer_type wrap). Drives the generic_type branch in
          // extractGoReceiverType which reads the base name via the
          // generic_type's `type` field.
          'func (b Box[T]) Open() string { return "" }',
          "",
        ].join("\n"),
      );
      const overlays = await provider.buildFileSignals(root);
      expect([...overlays.keys()]).toEqual(["pkg/variants.go"]);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // Value-receiver branch resolves to bare `Service` (no generic, no pointer).
      expect(lookup.lookup("Service#Open").length).toBe(1);
      // Generic value-receiver branch strips the type-parameter list to bare `Box`.
      expect(lookup.lookup("Box#Open").length).toBe(1);
      // Both Open methods exist as distinct qualified symbols.
      expect(lookup.lookupByShortName("Open").length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // bd tea-rags-mcp-iiq6 — `goNameOf` must emit ANY type_spec as a
  // top-level symbol regardless of the type expression kind (func, map,
  // slice, channel, pointer, array). Previously documented as struct-only
  // in the inline comment but covered only by the struct + interface tests
  // above. This test pins down the broader contract so future refactors
  // can't silently drop alias forms.
  it("goNameOf emits non-struct/interface type aliases (func, map, slice, channel) as top-level symbols", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-go-typespec-"));
    try {
      mkdirSync(join(root, "pkg"), { recursive: true });
      writeFileSync(
        join(root, "pkg", "aliases.go"),
        [
          "package pkg",
          "",
          "type HandlerFunc func(c *Context, payload interface{}) error",
          "type H map[string]any",
          "type Numbers []int",
          "type Ch chan int",
          "",
        ].join("\n"),
      );
      const overlays = await provider.buildFileSignals(root);
      expect([...overlays.keys()]).toEqual(["pkg/aliases.go"]);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      expect(lookup.lookupByShortName("HandlerFunc").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("H").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("Numbers").length).toBeGreaterThan(0);
      expect(lookup.lookupByShortName("Ch").length).toBeGreaterThan(0);
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
      // method_declaration nested → instance method joins with `#`.
      const go = lookup.lookupByShortName("go");
      expect(go.length).toBeGreaterThan(0);
      expect(go[0].symbolId).toContain("Service#go");
      // constructor_declaration is also instance-bound (`#`).
      expect(lookup.lookupByShortName("Service").some((s) => s.symbolId.includes("Service#Service"))).toBe(true);
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
      // handler.rs: impl_item descends; `fn go(&self)` is an instance
      // method (`&self` first param), joins to Handler with `#` per
      // symbolid-convention.md. Rust's `::` remains only for module /
      // type-name namespacing.
      const goEntries = lookup.lookupByShortName("go");
      expect(goEntries.length).toBeGreaterThan(0);
      expect(goEntries[0].symbolId).toBe("Handler#go");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // bd tea-rags-mcp-2hbd — `impl Trait for Type` must attribute methods
  // to the TYPE (the receiver implementing the trait), NOT to the trait.
  // Previously `impl Default for Searcher { fn default() }` registered
  // `Default#default` and find_symbol("Default") returned 10+ unrelated
  // chunks.
  it("attributes `impl Trait for Type` methods to the implementing Type, not the trait", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rs-trait-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "searcher.rs"),
        [
          "struct Searcher { count: usize }",
          "",
          "impl Default for Searcher {",
          "    fn default() -> Searcher {",
          "        return Searcher { count: 0 };",
          "    }",
          "}",
          "",
        ].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      // The implementing type (Searcher) must be in the table; the
      // trait name (Default) must NOT be registered as a class symbol.
      expect(lookup.lookupByShortName("Searcher").length).toBeGreaterThan(0);
      const defaultMethod = lookup.lookupByShortName("default");
      expect(defaultMethod.length).toBeGreaterThan(0);
      // `default` has no `self` param → associated function → `.`
      expect(defaultMethod[0].symbolId).toBe("Searcher.default");
      // The trait name should NOT appear as a class-level symbol — only
      // the implementing type owns the method scope.
      const defaultAsType = lookup.lookupByShortName("Default");
      expect(defaultAsType).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // bd tea-rags-mcp-h82m — generics + lifetimes must be stripped from
  // the impl type name in symbolId. `impl<'s> Worker<'s>` → `Worker#send`,
  // not `Worker<'s>#send`.
  it("strips generic parameters and lifetimes from Rust impl type name in symbolId", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rs-gen-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "worker.rs"),
        [
          "struct Worker<'s> { msg: &'s str }",
          "",
          "impl<'s> Worker<'s> {",
          "    pub fn send(&self, msg: &'s str) -> bool {",
          "        return msg.len() > 0;",
          "    }",
          "}",
          "",
        ].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      const send = lookup.lookupByShortName("send");
      expect(send.length).toBeGreaterThan(0);
      expect(send[0].symbolId).toBe("Worker#send");
      // The generic-laden form must NOT be in the table.
      expect(lookup.lookupByShortName("Worker<'s>")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // bd tea-rags-mcp-jyzb — Rust macro_rules! definitions must emit a
  // symbol so find_symbol("my_macro") resolves. Macros are common in
  // Rust crates and currently invisible to the codegraph.
  it("emits a symbol for Rust `macro_rules!` definitions", async () => {
    const root = mkdtempSync(join(tmpdir(), "cg-rs-macro-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "macros.rs"),
        [
          "macro_rules! my_macro {",
          "    () => {",
          '        println!("hi");',
          "    };",
          "}",
          "",
          "fn caller() {",
          "    my_macro!();",
          "}",
          "",
        ].join("\n"),
      );
      await provider.buildFileSignals(root);
      const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
      const macro = lookup.lookupByShortName("my_macro");
      expect(macro.length).toBeGreaterThan(0);
      expect(macro[0].symbolId).toBe("my_macro");
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

  // Slice-1 — classAncestors aggregation. sink.write merges per-file
  // `extraction.classAncestors` into a run-global `runAncestors` map so
  // pass-2 resolveExtraction sees ancestors keyed by target class
  // regardless of which file declared them. Two branches need coverage:
  //  - sink.write's `if (extraction.classAncestors)` truthy path
  //  - resolveExtraction's `Object.keys(runAncestors).length > 0` truthy
  //    path (falls back to per-file `extraction.classAncestors` otherwise)
  // Both are exercised by a multi-file run where at least one file
  // declares ancestors. Resolver receives the merged map via
  // CallContext.classAncestors. We use the TypeScript resolver because
  // the merge logic is language-agnostic — the map flows through the
  // provider regardless of which resolver consumes it downstream.
  it("sink.write aggregates classAncestors across files into a run-global map", async () => {
    const sink = provider.asExtractionSink();
    // File 1: declares an ancestor for class Foo. The merge loop body
    // (lines 587-588) executes here.
    await sink.write({
      relPath: "src/foo.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Foo.bar", scope: ["Foo"], calls: [] }],
      fileScope: ["Foo"],
      classAncestors: { Foo: ["BaseFoo"] },
    });
    // File 2: no classAncestors (undefined) — exercises the falsy branch
    // of `if (extraction.classAncestors)` without throwing.
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
    // Sanity: the run still produces a valid file edge, proving the
    // resolveExtraction path with runAncestors populated didn't break
    // resolver dispatch.
    expect(await client.getFanIn("src/foo.ts")).toBe(1);
  });

  // bd tea-rags-mcp-vw1u — Classes without an explicit `constructor() {}`
  // body must still expose a synthetic `Class#constructor` symbol in
  // cg_symbols / the global symbol table so `super()` resolution from a
  // subclass finds a target on the parent. Without this synthetic, the
  // resolver's `resolveSuper` walks `classExtends` to the parent, looks
  // up `Parent#constructor`, finds nothing, falls through to file-only
  // resolution, and `get_callers(Parent#constructor)` returns [].
  describe("synthetic Class#constructor (bd tea-rags-mcp-vw1u)", () => {
    it("emits a synthetic Class#constructor symbol for a class with NO explicit constructor", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-vw1u-implicit-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "base.ts"), `export class Base {\n  hello() { return 1; }\n}\n`);
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        const ctorHits = lookup.lookup("Base#constructor");
        expect(ctorHits.length).toBe(1);
        expect(ctorHits[0].relPath).toBe("src/base.ts");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("does NOT duplicate when an explicit constructor IS declared", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-vw1u-explicit-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "svc.ts"), `export class Svc {\n  constructor() {}\n  go() { return 1; }\n}\n`);
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        // Exactly one entry — explicit constructor only, no synthetic duplicate.
        expect(lookup.lookup("Svc#constructor").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("end-to-end: super() in child resolves to parent's synthetic constructor", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-vw1u-super-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // Base has NO explicit constructor — synthetic is the only target.
        writeFileSync(join(root, "src", "base.ts"), `export class Base {\n  hello() { return 1; }\n}\n`);
        // Child has explicit constructor that calls super().
        writeFileSync(
          join(root, "src", "child.ts"),
          `import { Base } from "./base.js";\nexport class Child extends Base {\n  constructor() { super(); }\n}\n`,
        );
        await provider.buildFileSignals(root);
        // Verify there is a method edge from Child#constructor → Base#constructor.
        expect(await client.getCalledByCount("Base#constructor")).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("multi-level inheritance: super() walks the chain to the topmost synthetic", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-vw1u-chain-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // Top of chain has no explicit constructor.
        writeFileSync(join(root, "src", "a.ts"), `export class A {\n  one() {}\n}\n`);
        // Middle: no explicit constructor either.
        writeFileSync(
          join(root, "src", "b.ts"),
          `import { A } from "./a.js";\nexport class B extends A {\n  two() {}\n}\n`,
        );
        // Leaf: calls super() — walks B → A, lands on A#constructor (synthetic).
        writeFileSync(
          join(root, "src", "c.ts"),
          `import { B } from "./b.js";\nexport class C extends B {\n  constructor() { super(); }\n}\n`,
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        // Both A and B contribute a synthetic constructor.
        expect(lookup.lookup("A#constructor").length).toBe(1);
        expect(lookup.lookup("B#constructor").length).toBe(1);
        // super() in C resolves to B#constructor (the first ancestor with a
        // matching constructor — synthetic is still a match).
        expect(await client.getCalledByCount("B#constructor")).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // bd tea-rags-mcp-q3o2 — super() in a child ctor must reach the
  // parent's EXPLICIT constructor in cg_symbols_edges_method. The vw1u
  // suite covers the synthetic-ctor case; this suite covers the path
  // where Parent HAS an explicit constructor (the BaseExploreStrategy
  // shape: abstract base, real ctor body, children call `super(...args)`).
  describe("super() to parent's EXPLICIT constructor (bd tea-rags-mcp-q3o2)", () => {
    it("super(arg) in child ctor produces edge to parent's explicit constructor", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-q3o2-explicit-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "base.ts"),
          `export class Base {\n  constructor(protected readonly dep: number) {}\n  hello() { return this.dep; }\n}\n`,
        );
        writeFileSync(
          join(root, "src", "child.ts"),
          `import { Base } from "./base.js";\nexport class Child extends Base {\n  constructor(dep: number) { super(dep); }\n}\n`,
        );
        await provider.buildFileSignals(root);
        expect(await client.getCalledByCount("Base#constructor")).toBeGreaterThan(0);
        const callers = await client.getCallers("Base#constructor");
        expect(callers.map((c) => c.sourceSymbolId)).toContain("Child#constructor");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("super(...args) spread in child ctor produces edge to parent's explicit constructor", async () => {
      // Mirrors ScrollRankStrategy / SymbolSearchStrategy shape: the
      // child forwards every constructor parameter to super via spread.
      // The walker must still emit a CallRef whose receiver is "super"
      // regardless of the argument shape.
      const root = mkdtempSync(join(tmpdir(), "cg-q3o2-spread-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "base.ts"),
          `export class Base {\n  constructor(protected readonly a: number, protected readonly b: string) {}\n}\n`,
        );
        writeFileSync(
          join(root, "src", "child.ts"),
          `import { Base } from "./base.js";\nexport class Child extends Base {\n  constructor(...args: ConstructorParameters<typeof Base>) { super(...args); }\n}\n`,
        );
        await provider.buildFileSignals(root);
        expect(await client.getCalledByCount("Base#constructor")).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("multiple children calling super to a shared explicit-ctor parent all produce edges", async () => {
      // Reproduces the BaseExploreStrategy shape (one base, four child
      // classes each calling super(...) in their own constructor).
      const root = mkdtempSync(join(tmpdir(), "cg-q3o2-many-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "base.ts"),
          `export abstract class Base {\n  abstract readonly type: string;\n  constructor(protected readonly dep: number) {}\n}\n`,
        );
        writeFileSync(
          join(root, "src", "child-a.ts"),
          `import { Base } from "./base.js";\nexport class ChildA extends Base {\n  readonly type = "a" as const;\n  constructor(...args: ConstructorParameters<typeof Base>) { super(...args); }\n}\n`,
        );
        writeFileSync(
          join(root, "src", "child-b.ts"),
          `import { Base } from "./base.js";\nexport class ChildB extends Base {\n  readonly type = "b" as const;\n  constructor(dep: number) { super(dep); }\n}\n`,
        );
        await provider.buildFileSignals(root);
        const callers = await client.getCallers("Base#constructor");
        const sources = new Set(callers.map((c) => c.sourceSymbolId));
        expect(sources).toContain("ChildA#constructor");
        expect(sources).toContain("ChildB#constructor");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // bd tea-rags-mcp-i252 — `new ClassName(args)` is a constructor call,
  // not just an expression. The walker must emit a CallRef so the
  // resolver routes it to ClassName#constructor.
  describe("new ClassName(args) as constructor-call edges (bd tea-rags-mcp-i252)", () => {
    it("'new RankModule(...)' produces a method edge to RankModule#constructor", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-i252-new-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "rank-module.ts"),
          `export class RankModule {\n  constructor(a: number) { this.a = a; }\n  a: number;\n}\n`,
        );
        writeFileSync(
          join(root, "src", "strategy.ts"),
          `import { RankModule } from "./rank-module.js";\nexport class Strategy {\n  build() { return new RankModule(1); }\n}\n`,
        );
        await provider.buildFileSignals(root);
        // The new call lands on RankModule#constructor.
        expect(await client.getCalledByCount("RankModule#constructor")).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("'new' on a class WITHOUT explicit constructor resolves to the synthetic constructor", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-i252-implicit-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "tag.ts"), `export class Tag {\n  label() { return "tag"; }\n}\n`);
        writeFileSync(
          join(root, "src", "owner.ts"),
          `import { Tag } from "./tag.js";\nexport class Owner {\n  make() { return new Tag(); }\n}\n`,
        );
        await provider.buildFileSignals(root);
        // Synthetic Tag#constructor catches the edge.
        expect(await client.getCalledByCount("Tag#constructor")).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // bd tea-rags-mcp-mwty — CommonJS assignment_expression definitions. The
  // JS walker used to only emit symbols for `function_declaration` /
  // `class_declaration` / `method_definition`. Express OSS's
  // `lib/application.js` has ~30 `app.X = function X()` definitions; the
  // walker extracted 2 of them. The fix wires a JS-specific nameOf
  // (jsNameOf) into LANGUAGES["{.js,.jsx,.mjs,.cjs}"] that recognises
  // assignment_expression + lexical_declaration shapes carrying a function
  // value, restoring the missing symbol surface.
  //
  // Patterns covered (per .claude/rules/symbolid-convention.md):
  //   #1  obj.method = function () {}                  → obj.method
  //   #2  Foo.prototype.bar = function () {}           → Foo#bar (instance)
  //   #3  exports.foo = function () {}                 → foo (top-level export)
  //   #4  module.exports = function name() {}          → name (or skip if anon)
  //   #5  const Foo = function () {} / arrow / let/var → Foo
  //   #6  res.a = res.b = function () {}               → both res.a AND res.b
  describe("JS assignment_expression definitions (bd tea-rags-mcp-mwty)", () => {
    it("#1 emits `obj.method` for `obj.method = function () {}`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-mwty-1-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "app.js"),
          [
            "var app = {};",
            "app.use = function () { return 1; };",
            "app.handle = function handle() { return 2; };",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("app.use").length).toBe(1);
        expect(lookup.lookup("app.handle").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("#2 emits `Foo#bar` for `Foo.prototype.bar = function () {}` (instance separator)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-mwty-2-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "foo.js"),
          [
            "function Foo() {}",
            "Foo.prototype.bar = function () { return 1; };",
            "Foo.prototype.baz = function baz() { return 2; };",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("Foo#bar").length).toBe(1);
        expect(lookup.lookup("Foo#baz").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("#3 emits top-level `foo` for `exports.foo = function () {}`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-mwty-3-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "mod.js"),
          ["exports.foo = function () { return 1; };", "exports.bar = function bar() { return 2; };", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("foo").length).toBe(1);
        expect(lookup.lookup("bar").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("#4 emits top-level `name` for `module.exports = function name() {}` (named only)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-mwty-4-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src", "named.js"), "module.exports = function createApp() { return {}; };\n");
        writeFileSync(
          join(root, "src", "anon.js"),
          // Anonymous module.exports has no useful name to emit — walker
          // skips it. Lookup must not fabricate a placeholder symbol.
          "module.exports = function () { return {}; };\n",
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("createApp").length).toBe(1);
        // Anonymous module.exports must NOT register a symbol — no
        // synthetic "module.exports" identifier should leak.
        expect(lookup.lookup("module.exports").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("#5 emits `Foo` for `const Foo = function () {}` / arrow / let / var", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-mwty-5-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "decl.js"),
          [
            "const Alpha = function () { return 1; };",
            "let Beta = function Beta() { return 2; };",
            "var Gamma = function () { return 3; };",
            "const Delta = () => 4;",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("Alpha").length).toBe(1);
        expect(lookup.lookup("Beta").length).toBe(1);
        expect(lookup.lookup("Gamma").length).toBe(1);
        expect(lookup.lookup("Delta").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("#6 emits BOTH targets of an alias chain `res.a = res.b = function () {}`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-mwty-6-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // Pattern straight from express's lib/response.js.
        writeFileSync(
          join(root, "src", "res.js"),
          ["var res = {};", "res.contentType = res.type = function (type) { return type; };", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("res.contentType").length).toBe(1);
        expect(lookup.lookup("res.type").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // bd tea-rags-mcp-d1f8 — JS getters declared via `Object.defineProperty`
  // and the project-specific `defineGetter` helper must surface as symbols.
  // Express `lib/request.js` declares 8 getters (`req.query`, `req.protocol`,
  // `req.secure`, `req.ip`, `req.ips`, `req.subdomains`, `req.path`,
  // `req.host`, `req.hostname`) via a local `defineGetter(req, name, fn)`
  // helper. Without these, `get_callers(req.query)` returns `[]` and agents
  // navigating express lose visibility into the request-attribute layer.
  //
  // Symbol convention:
  //   Object.defineProperty(obj, "name", { get: fn })  → `<obj>.name`
  //   defineGetter(obj, "name", fn)                    → `<obj>.name`
  //
  // The `obj` text is taken verbatim from the receiver expression. When
  // `obj` is `this`, the emitted name is `this.name` (out of scope:
  // resolving `this` to the enclosing class — documented as a known
  // limitation in the JS walker comment).
  describe("JS getter helpers — defineProperty / defineGetter (bd tea-rags-mcp-d1f8)", () => {
    it("Object.defineProperty(obj, 'name', { get: fn }) emits `obj.name`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-d1f8-defineProperty-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "app.js"),
          [
            "var app = {};",
            "Object.defineProperty(app, 'router', {",
            "  configurable: true,",
            "  enumerable: true,",
            "  get: function () { return this._router; },",
            "});",
            "Object.defineProperty(app, 'mountpath', {",
            "  configurable: true,",
            "  get: function () { return '/'; },",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("app.router").length).toBe(1);
        expect(lookup.lookup("app.mountpath").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("defineGetter(obj, 'name', fn) helper emits `obj.name`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-d1f8-defineGetter-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // Pattern straight from express's lib/request.js — the helper
        // is declared locally then used to install 8+ getters.
        writeFileSync(
          join(root, "src", "request.js"),
          [
            "var req = {};",
            "function defineGetter(obj, name, getter) {",
            "  Object.defineProperty(obj, name, {",
            "    configurable: true,",
            "    enumerable: true,",
            "    get: getter,",
            "  });",
            "}",
            "defineGetter(req, 'query', function query() { return this._query; });",
            "defineGetter(req, 'protocol', function protocol() { return 'http'; });",
            "defineGetter(req, 'secure', function secure() { return false; });",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("req.query").length).toBe(1);
        expect(lookup.lookup("req.protocol").length).toBe(1);
        expect(lookup.lookup("req.secure").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // bd tea-rags-mcp-mk45 — Pre-ES6 constructor functions in JS.
  // `function View(...) {}` followed by `View.prototype.X = ...` is the
  // canonical pre-class constructor idiom (express `lib/view.js`). Walker
  // already emits `View` (function_declaration) AND `View#X` (prototype
  // assignment, via mwty) but did NOT emit a synthetic `View#constructor`,
  // so `get_callers("View#constructor")` was empty despite `new View(...)`
  // call edges existing in cg_symbols_edges_method (the i252 new_expression
  // handler emits edges with `member: "constructor"`).
  //
  // Heuristic: function_declaration whose name starts uppercase AND the
  // file has at least one `<Name>.prototype.<M> = ...` sibling assignment
  // is treated as a constructor function — emit synthetic `<Name>#constructor`.
  describe("synthetic constructor for `function Foo() {}` constructor function (bd tea-rags-mcp-mk45)", () => {
    it("emits `View#constructor` for `function View(...) {}` with `View.prototype.X = fn` siblings", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-mk45-implicit-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // Pattern straight from express's lib/view.js.
        writeFileSync(
          join(root, "src", "view.js"),
          [
            "function View(name, options) {",
            "  this.name = name;",
            "  this.opts = options;",
            "}",
            "View.prototype.lookup = function lookup(name) { return name; };",
            "View.prototype.render = function render(options, callback) { return callback(null, ''); };",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("View#constructor").length).toBe(1);
        // Prototype methods still emit normally.
        expect(lookup.lookup("View#lookup").length).toBe(1);
        expect(lookup.lookup("View#render").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("end-to-end: `new View(...)` resolves to View#constructor", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-mk45-new-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "view.js"),
          [
            "function View(name) {",
            "  this.name = name;",
            "}",
            "View.prototype.lookup = function lookup() { return this.name; };",
            "module.exports = View;",
            "",
          ].join("\n"),
        );
        writeFileSync(
          join(root, "src", "application.js"),
          [
            "var View = require('./view.js');",
            "function makeView() {",
            "  return new View('default');",
            "}",
            "module.exports = makeView;",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        // `new View(...)` edge must reach View#constructor.
        expect(await client.getCalledByCount("View#constructor")).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    // bd tea-rags-mcp-z95o — express dispatches HTTP-verb installers via
    //   methods.forEach(function(method) { app[method] = function(){...} });
    // where `methods` is the npm `methods` package — a static list of
    // HTTP verbs. The LHS is `subscript_expression` (`app[method]`) which
    // jsNameOf's normal LHS classifier rejects (it requires
    // `member_expression` with a `property_identifier`). Without the
    // heuristic, walker emits 0 symbols for the 9 `app.get`/`app.post`/
    // ... handlers that express depends on.
    //
    // Heuristic (conservative — known-receivers allowlist):
    //   <pkg>.forEach(function(<param>) { <obj>[<param>] = <fn-expr>; });
    // where the file imports `<pkg>` from the npm `methods` package.
    // Emit `<obj>.<verb>` for each verb in the hardcoded HTTP-verb list.
    //
    // Generic case (arbitrary user array) is structurally unresolvable
    // without runtime info — out of scope.
    it("methods.forEach(method => app[method] = fn) emits app.<verb> for HTTP verbs (bd tea-rags-mcp-z95o)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-z95o-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // Pattern from express lib/application.js:471-482.
        writeFileSync(
          join(root, "src", "application.js"),
          [
            "var methods = require('methods');",
            "var app = {};",
            "methods.forEach(function (method) {",
            "  app[method] = function (path) {",
            "    return this;",
            "  };",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        // The 9 HTTP verbs from the npm `methods` package.
        expect(lookup.lookup("app.get").length).toBe(1);
        expect(lookup.lookup("app.post").length).toBe(1);
        expect(lookup.lookup("app.put").length).toBe(1);
        expect(lookup.lookup("app.delete").length).toBe(1);
        expect(lookup.lookup("app.head").length).toBe(1);
        expect(lookup.lookup("app.options").length).toBe(1);
        expect(lookup.lookup("app.patch").length).toBe(1);
        expect(lookup.lookup("app.connect").length).toBe(1);
        expect(lookup.lookup("app.trace").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("does NOT emit synthetic constructor for plain (non-constructor) function", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-mk45-plain-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // `helper` starts lowercase + no `helper.prototype.X` → NOT a constructor.
        writeFileSync(
          join(root, "src", "helper.js"),
          ["function helper(x) { return x + 1; }", "function Plain(x) { return x; }", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        // Plain has uppercase name but no prototype-assignment sibling → no
        // synthetic constructor (the prototype-sibling signal is the
        // strong indicator; uppercase alone is too weak — many factory
        // functions follow PascalCase).
        expect(lookup.lookup("helper#constructor").length).toBe(0);
        expect(lookup.lookup("Plain#constructor").length).toBe(0);
        // The function itself still emits as a top-level symbol.
        expect(lookup.lookup("helper").length).toBe(1);
        expect(lookup.lookup("Plain").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    // bd tea-rags-mcp-z95o widening — express does NOT do
    // `var methods = require('methods')`. It does
    // `var methods = require('./utils').methods` where `lib/utils.js`
    // re-exports `http.METHODS`. The original narrow allowlist missed
    // this case entirely. Widened heuristics:
    //   1. require('methods') (npm package) — original
    //   2. recv text === "methods" AND any import in the file is a local
    //      path containing "util" (e.g., `require('./utils')`)
    //   3. function body contains string-literal HTTP-verb comparisons
    //      (`method === 'get'`, `method === 'post'`, …) — STRONGEST signal.
    // The third heuristic catches express directly; the others are bonus
    // signals when the agent imports utilities by convention.
    it("methods.forEach with `method === 'get'` body emits app.<verb> (z95o-2)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-z95o-2-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // Pattern straight from express lib/application.js — `methods`
        // comes from a local re-export, NOT the npm `methods` package.
        // The HTTP-verb string-literal comparison inside the body is
        // the strongest signal that this iterates HTTP verbs.
        writeFileSync(
          join(root, "src", "application.js"),
          [
            "var methods = require('./utils').methods;",
            "var app = {};",
            "methods.forEach(function (method) {",
            "  app[method] = function (path) {",
            "    if (method === 'get' && arguments.length === 1) { return this; }",
            "    return this;",
            "  };",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("app.get").length).toBe(1);
        expect(lookup.lookup("app.post").length).toBe(1);
        expect(lookup.lookup("app.put").length).toBe(1);
        expect(lookup.lookup("app.delete").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    // bd tea-rags-mcp-z95o — swapped operand form: `'get' === method`
    // (string literal on the left, param on the right). The body-
    // comparison heuristic must match BOTH orientations.
    it("methods.forEach emits app.<verb> when body compares with swapped operand `'verb' === method`", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-z95o-swap-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "application.js"),
          [
            "var verbs = ['a', 'b'];",
            "var app = {};",
            "verbs.forEach(function (method) {",
            "  app[method] = function () {",
            // Operand-swapped form — string-literal on the LEFT.
            "    if ('get' === method) return this;",
            "    return null;",
            "  };",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("app.get").length).toBe(1);
        expect(lookup.lookup("app.post").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    // bd tea-rags-mcp-z95o — anyImportPathContainsUtil branch: the
    // receiver is named `methods` AND the file imports a LOCAL utility
    // module (`require('./utils')`), but the body has NO HTTP-verb
    // string comparisons. The util-import heuristic alone is sufficient
    // to fire the HTTP-verb expansion.
    it("methods.forEach emits app.<verb> from util-import signal alone (no body verb comparisons)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-z95o-util-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "application.js"),
          [
            // Local relative require whose path contains `util` — the
            // util-import heuristic recognises this as the express
            // `lib/utils.js` re-export pattern.
            "var methods = require('./lib/utils').methods;",
            "var app = {};",
            "methods.forEach(function (method) {",
            // NO `method === 'verb'` comparisons in the body — the
            // util-require signal must carry the dispatch on its own.
            "  app[method] = function (path) {",
            "    return this;",
            "  };",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        expect(lookup.lookup("app.get").length).toBe(1);
        expect(lookup.lookup("app.post").length).toBe(1);
        expect(lookup.lookup("app.trace").length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    // Negative: the util-import heuristic requires a RELATIVE path —
    // bare `require('util')` (node built-in) does NOT trigger the
    // dispatch. Tests the startsWith('./')/startsWith('../') guard.
    it("methods.forEach does NOT emit when require source is the bare 'util' built-in (not relative)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-z95o-bareutil-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "application.js"),
          [
            "var methods = ['a', 'b'];",
            // `require('util')` is the node built-in; the heuristic
            // requires a relative path. Should NOT fire.
            "var util = require('util');",
            "var app = {};",
            "methods.forEach(function (method) {",
            "  app[method] = function () {};",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        // No HTTP-verb expansion — only literal `app.a`, `app.b` would
        // appear if any symbolic detection misfired. The walker emits
        // nothing because `methods` is not a `require('methods')` chain
        // and no util-RELATIVE import exists.
        expect(lookup.lookup("app.get").length).toBe(0);
        expect(lookup.lookup("app.a").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("forEach without HTTP-verb body markers does NOT emit (z95o-3 no false-positive)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-z95o-3-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // A generic forEach over user-data: no HTTP-verb string literals
        // in the body and `things` is not imported via `require('methods')`
        // nor is it `methods` with a utility import. Should NOT emit.
        writeFileSync(
          join(root, "src", "config.js"),
          [
            "var things = ['alpha', 'beta', 'gamma'];",
            "var obj = {};",
            "things.forEach(function (thing) {",
            "  obj[thing] = function () {",
            "    return thing.length;",
            "  };",
            "});",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        // No HTTP verbs — must not emit obj.get / obj.post / etc.
        expect(lookup.lookup("obj.get").length).toBe(0);
        expect(lookup.lookup("obj.post").length).toBe(0);
        expect(lookup.lookup("obj.alpha").length).toBe(0);
        expect(lookup.lookup("obj.beta").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    // bd tea-rags-mcp-d1f8 this-resolution — when
    // `Object.defineProperty(this, 'name', { get: fn })` appears inside
    // a function_expression that is the RHS of an outer `app.method = fn`
    // assignment, `this` binds to `app` at call time. Emit `app.name`,
    // NOT the literal `app.init.this.router` chain. Express's
    // `app.init = function init() { Object.defineProperty(this, 'router', ...) }`
    // is the canonical case — without this resolution agents see a
    // misleading `app.init.this.router` symbol that doesn't correspond
    // to any real call site.
    it("Object.defineProperty(this, ...) inside app.method = fn resolves `this` to outer receiver", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-d1f8-this-resolve-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        // Pattern straight from express lib/application.js `app.init`.
        writeFileSync(
          join(root, "src", "application.js"),
          [
            "var app = {};",
            "app.init = function init() {",
            "  Object.defineProperty(this, 'router', {",
            "    configurable: true,",
            "    enumerable: true,",
            "    get: function () { return this._router; },",
            "  });",
            "};",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        // Resolved form — `this` rewritten to outer receiver `app`.
        expect(lookup.lookup("app.router").length).toBe(1);
        // Negative — the literal-this chain must NOT appear.
        expect(lookup.lookup("app.init.this.router").length).toBe(0);
        expect(lookup.lookup("this.router").length).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // bd tea-rags-mcp-d4ab — Duplicate top-level symbolId for overloaded
  // Python decorators (functools.singledispatch / typing.overload). Two
  // `def stream_with_context` declarations at module top-level emit the
  // same symbolId. The dedup in `collectSymbols` (last line of the walk)
  // keeps the FIRST occurrence; in singledispatch the LAST def is the
  // real implementation. Per `.claude/rules/symbolid-convention.md` we
  // expect a single canonical symbol entry — the chunker/codegraph keep
  // the longest body (real impl), drop empty stubs.
  describe("Python duplicate top-level function deduplication (bd d4ab)", () => {
    it("keeps a single symbolId for two top-level defs sharing a name", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-py-d4ab-"));
      try {
        writeFileSync(
          join(root, "helpers.py"),
          [
            "import functools",
            "",
            "@functools.singledispatch",
            "def stream_with_context(generator_or_function):",
            "    pass",
            "",
            "@stream_with_context.register",
            "def stream_with_context(generator_or_function):",
            "    body = list(generator_or_function)",
            "    return body",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        const matches = lookup.lookupByShortName("stream_with_context");
        // Codegraph emits exactly ONE canonical symbol per top-level name in
        // the same file. Without dedup at the chunker/codegraph layer, two
        // collisions would land at the same Qdrant point id and silently
        // overwrite — making `find_symbol` non-deterministic.
        const inHelpers = matches.filter((m) => m.relPath === "helpers.py");
        expect(inHelpers.length).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // bd tea-rags-mcp-a466 — Java overload disambiguation. Multiple
  // `method_declaration` nodes sharing a name composed under the same
  // class produce identical symbolIds (e.g. two `upperCase` overloads →
  // both compose as `StringUtils.upperCase`). The previous dedup in
  // `collectSymbols` kept the first occurrence and dropped the rest,
  // silently collapsing overloads. The codegraph must emit a distinct
  // symbolId per overload — suffix the N-th occurrence (1-based, first
  // unchanged) with `~N`. Mirrors the chunker convention so cg_symbols
  // and Qdrant payload stay in lockstep.
  describe("Java overload disambiguation (bd a466)", () => {
    it("emits a distinct symbolId per overload via `~N` suffix", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-java-overload-"));
      try {
        writeFileSync(
          join(root, "StringUtils.java"),
          [
            "package com.example;",
            "",
            "public class StringUtils {",
            "  public static String upperCase(String value) {",
            "    return value == null ? null : value.toUpperCase();",
            "  }",
            "  public static String upperCase(String value, java.util.Locale locale) {",
            "    return value == null ? null : value.toUpperCase(locale);",
            "  }",
            "  public static String upperCase(String value, java.util.Locale locale, boolean strict) {",
            "    return value == null ? null : value.toUpperCase(locale);",
            "  }",
            "}",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        const matches = lookup.lookupByShortName("upperCase");
        // All three overloads MUST be present with distinct symbolIds.
        const ids = matches.map((m) => m.symbolId).sort();
        expect(ids).toEqual(["StringUtils.upperCase", "StringUtils.upperCase~2", "StringUtils.upperCase~3"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("preserves a single symbolId when there is no overload (no spurious suffix)", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-java-no-overload-"));
      try {
        writeFileSync(
          join(root, "Solo.java"),
          ["public class Solo {", "  public String only(String v) { return v; }", "}", ""].join("\n"),
        );
        await provider.buildFileSignals(root);
        const lookup = (provider as unknown as { deps: { symbolTable: InMemoryGlobalSymbolTable } }).deps.symbolTable;
        const matches = lookup.lookupByShortName("only");
        expect(matches.length).toBe(1);
        expect(matches[0].symbolId).toBe("Solo#only");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Lookup-table dispatch (bd tea-rags-mcp-n0zj) — run-global aggregation
  // of dispatchTables / callbackParams + fan-out edges through the resolver.
  // ───────────────────────────────────────────────────────────────────
  describe("dispatch tables (n0zj)", () => {
    it("fans an in-file dynamic-key dispatch out to every candidate walker", async () => {
      const sink = provider.asExtractionSink();
      // The walker functions live in another file (cross-file candidate
      // resolution) — mirrors LANGUAGES referencing extractFromXFile.
      await sink.write({
        relPath: "src/walkers.ts",
        language: "typescript",
        imports: [],
        chunks: [
          { symbolId: "extractTs", scope: [], calls: [] },
          { symbolId: "extractRb", scope: [], calls: [] },
        ],
        fileScope: [],
      });
      await sink.write({
        relPath: "src/provider.ts",
        language: "typescript",
        imports: [],
        dispatchTables: {
          LANGUAGES: { entries: { ".ts": { walker: "extractTs" }, ".rb": { walker: "extractRb" } } },
        },
        chunks: [
          {
            symbolId: "dispatch",
            scope: [],
            calls: [
              {
                callText: "LANGUAGES[ext].walker(input)",
                receiver: null,
                member: "walker",
                startLine: 5,
                dispatch: { table: "LANGUAGES", field: "walker", key: null },
              },
            ],
          },
        ],
        fileScope: [],
      });
      await sink.finish();
      // Both orphaned walkers now have the dispatcher as a caller.
      expect(await client.getCalledByCount("extractTs")).toBe(1);
      expect(await client.getCalledByCount("extractRb")).toBe(1);
      expect(await client.getCallSiteCount("dispatch")).toBe(2);
    });

    it("joins a callback-param: collectSymbols fans out to the passed nameOf candidates", async () => {
      const sink = provider.asExtractionSink();
      await sink.write({
        relPath: "src/names.ts",
        language: "typescript",
        imports: [],
        chunks: [
          { symbolId: "tsNameOf", scope: [], calls: [] },
          { symbolId: "rbNameOf", scope: [], calls: [] },
        ],
        fileScope: [],
      });
      await sink.write({
        relPath: "src/provider.ts",
        language: "typescript",
        imports: [],
        dispatchTables: {
          LANGUAGES: { entries: { ".ts": { nameOf: "tsNameOf" }, ".rb": { nameOf: "rbNameOf" } } },
        },
        // collectSymbols invokes its 2nd param (index 1).
        callbackParams: { collectSymbols: [1] },
        chunks: [
          { symbolId: "collectSymbols", scope: [], calls: [] },
          {
            symbolId: "dispatch",
            scope: [],
            calls: [
              {
                callText: "collectSymbols(tree, LANGUAGES[ext].nameOf)",
                receiver: null,
                member: "collectSymbols",
                startLine: 7,
                dispatchArgs: [{ argIndex: 1, candidate: { table: "LANGUAGES", field: "nameOf", key: null } }],
              },
            ],
          },
        ],
        fileScope: [],
      });
      await sink.finish();
      // The callee (collectSymbols), not the dispatcher, is the source of
      // the nameOf edges — that is where the parameter is invoked.
      const tsCallers = await client.getCallers("tsNameOf");
      expect(tsCallers.map((c) => c.sourceSymbolId).sort()).toEqual(["collectSymbols"]);
      expect(await client.getCalledByCount("rbNameOf")).toBe(1);
      // The normal dispatcher → collectSymbols edge still exists.
      expect(await client.getCalledByCount("collectSymbols")).toBe(1);
    });

    it("aggregates dispatch tables run-global so a cross-file dispatch resolves", async () => {
      const sink = provider.asExtractionSink();
      // Table defined in registry.ts, dispatched from caller.ts (imports it).
      await sink.write({
        relPath: "src/handlers.ts",
        language: "typescript",
        imports: [],
        chunks: [{ symbolId: "handleA", scope: [], calls: [] }],
        fileScope: [],
      });
      await sink.write({
        relPath: "src/registry.ts",
        language: "typescript",
        imports: [],
        dispatchTables: { CMD: { entries: { a: { run: "handleA" } } } },
        chunks: [],
        fileScope: [],
      });
      await sink.write({
        relPath: "src/caller.ts",
        language: "typescript",
        imports: [{ importText: "./registry", startLine: 1, importedNames: ["CMD"] }],
        chunks: [
          {
            symbolId: "dispatch",
            scope: [],
            calls: [
              {
                callText: "CMD[k].run(x)",
                receiver: null,
                member: "run",
                startLine: 3,
                dispatch: { table: "CMD", field: "run", key: null },
              },
            ],
          },
        ],
        fileScope: [],
      });
      await sink.finish();
      expect(await client.getCalledByCount("handleA")).toBe(1);
    });

    it("re-walking the same file replaces its table def (idempotent across reindex)", async () => {
      const sink = provider.asExtractionSink();
      // Candidate functions live in their own file.
      await sink.write({
        relPath: "src/handlers.ts",
        language: "typescript",
        imports: [],
        chunks: [
          { symbolId: "handleA", scope: [], calls: [] },
          { symbolId: "handleB", scope: [], calls: [] },
        ],
        fileScope: [],
      });
      // registry.ts declares CMD. It is written TWICE for the same relPath —
      // simulating an incremental reindex re-walking the file. The run-global
      // aggregation must dedup by relPath (replace, not append) so the second
      // definition (which adds entry `b`) wins without leaving a stale `a`-only
      // duplicate that would double-count candidates.
      const registry = (entries: Record<string, { run: string }>) => ({
        relPath: "src/registry.ts",
        language: "typescript",
        imports: [],
        dispatchTables: { CMD: { entries } },
        chunks: [],
        fileScope: [],
      });
      await sink.write(registry({ a: { run: "handleA" } }));
      await sink.write(registry({ a: { run: "handleA" }, b: { run: "handleB" } }));
      await sink.write({
        relPath: "src/caller.ts",
        language: "typescript",
        imports: [{ importText: "./registry", startLine: 1, importedNames: ["CMD"] }],
        chunks: [
          {
            symbolId: "dispatch",
            scope: [],
            calls: [
              {
                callText: "CMD[k].run(x)",
                receiver: null,
                member: "run",
                startLine: 3,
                dispatch: { table: "CMD", field: "run", key: null },
              },
            ],
          },
        ],
        fileScope: [],
      });
      await sink.finish();
      // The replacement (not append) means each candidate has exactly ONE
      // caller edge — no duplicate from the first, superseded def.
      expect(await client.getCalledByCount("handleA")).toBe(1);
      expect(await client.getCalledByCount("handleB")).toBe(1);
    });

    // End-to-end through the REAL TypeScript walker + provider aggregation +
    // resolver — not the synthetic FileExtraction sink. A single registry
    // file declares a const lookup table, a dispatcher that fans a dynamic
    // key over it, and a higher-order `forEachLang` whose invoked callback
    // param receives a table candidate-set. Verifies the whole chain wires
    // up: collectDispatchTables / collectCallbackParams in the walker →
    // run-global aggregation → resolveDispatch fan-out → graph edges.
    it("walks a real .ts dispatch table file end-to-end and fans edges to every candidate", async () => {
      const root = mkdtempSync(join(tmpdir(), "cg-ts-disp-e2e-"));
      try {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(
          join(root, "src", "walkers.ts"),
          ["export function walkTs() {}", "export function walkRb() {}", ""].join("\n"),
        );
        writeFileSync(
          join(root, "src", "registry.ts"),
          [
            "import { walkTs, walkRb } from './walkers';",
            // S1 wrapper-object table keyed by extension (quoted string keys).
            "const LANGUAGES = { '.ts': { walker: walkTs }, '.rb': { walker: walkRb } };",
            // Higher-order helper that INVOKES its 2nd param (index 1) — makes
            // it a callback-param target for the inter-proc join below.
            "function forEachLang(input, walker) {",
            "  return walker(input);",
            "}",
            "function dispatch(ext) {",
            // dynamic-key dispatch — fans to BOTH walkers.
            "  const fn = LANGUAGES[ext].walker;",
            "  fn(0);",
            // dispatch candidate-set passed at forEachLang's callback position.
            "  forEachLang(0, LANGUAGES[ext].walker);",
            "}",
            // Typed destructured param — exercises paramName's null path
            // (object_pattern inside required_parameter has no single name).
            "function withOpts({ verbose }: { verbose: boolean }, run) {",
            "  run();",
            "}",
            "",
          ].join("\n"),
        );
        await provider.buildFileSignals(root);
        // Both walker candidates are reached: once from the direct dynamic
        // dispatch (source = dispatch) and once from the inter-proc join
        // (source = forEachLang, the callee whose param is invoked).
        expect(await client.getCalledByCount("walkTs")).toBeGreaterThanOrEqual(1);
        expect(await client.getCalledByCount("walkRb")).toBeGreaterThanOrEqual(1);
        const tsCallers = (await client.getCallers("walkTs")).map((c) => c.sourceSymbolId).sort();
        // The dispatcher chunk and the invoked-callback callee both appear.
        expect(tsCallers).toContain("dispatch");
        expect(tsCallers).toContain("forEachLang");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

// Task 7 — write routing through the daemon + version-suffix removal.
// These exercise the provider's private store-resolution + metric-recompute
// paths directly (cast via `as unknown as { ... }`) in DIRECT mode so no pool
// or DuckDB file is needed.
describe("CodegraphEnrichmentProvider — daemon write routing (Task 7)", () => {
  it("recompute step delegates to graphDb.computeAndPersistCyclesAndSignals when present", async () => {
    const calls: string[] = [];
    const fakeGraphDb = {
      computeAndPersistCyclesAndSignals: async () => {
        calls.push("rpc");
      },
    } as unknown as GraphDbClient;
    const provider = new CodegraphEnrichmentProvider({
      graphDb: fakeGraphDb,
      symbolTable: new InMemoryGlobalSymbolTable(),
      resolvers: new Map(),
    });
    await (
      provider as unknown as { recomputeGraphMetricsStreaming: (c?: string) => Promise<void> }
    ).recomputeGraphMetricsStreaming("code_x_v1");
    expect(calls).toEqual(["rpc"]);
  });

  it("getStore acquires the FULL versioned collection name (no strip)", async () => {
    const acquired: string[] = [];
    const fakePool = {
      acquireWrite: async (c: string) => {
        acquired.push(c);
        return { graphDb: {} as GraphDbClient, symbolTable: new InMemoryGlobalSymbolTable() };
      },
    };
    const provider = new CodegraphEnrichmentProvider({ pool: fakePool as never, resolvers: new Map() });
    await (provider as unknown as { getStore: (c?: string) => Promise<unknown> }).getStore("code_x_v6");
    expect(acquired).toEqual(["code_x_v6"]); // NOT "code_x"
  });
});
