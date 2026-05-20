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
    expect(provider.signals.map((s) => s.key)).toContain("codegraph.chunk.callSiteCount");
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

  it("buildChunkSignals attaches calledByCount and callSiteCount per chunk by symbolId", async () => {
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
    const chunkMap = new Map([
      ["src/main.ts", [{ id: "chunk-main", symbolId: "main" } as never]],
      ["src/foo.ts", [{ id: "chunk-foo-bar", symbolId: "Foo.bar" } as never]],
    ]);
    const overlays = await provider.buildChunkSignals("/", chunkMap);
    const main = overlays.get("src/main.ts")?.get("chunk-main");
    expect(main?.["codegraph.chunk.callSiteCount"]).toBe(1);
    const fooBar = overlays.get("src/foo.ts")?.get("chunk-foo-bar");
    expect(fooBar?.["codegraph.chunk.calledByCount"]).toBe(1);
  });
});
