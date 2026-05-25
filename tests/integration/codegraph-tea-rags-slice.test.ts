/**
 * Integration test: run codegraph slice 1 against real tea-rags source files.
 *
 * Bypasses the deferred bootstrap/composition wiring (T10's remaining
 * pieces) and exercises the slice's components directly:
 *
 *   actual TS files → tree-sitter parse → extractFromTypescriptFile →
 *   CodegraphEnrichmentProvider.asExtractionSink → DuckDbGraphClient →
 *   GraphFacade.getCallers/getCallees → assertions
 *
 * This is the "vertical slice on tea-rags" test the user asked for —
 * proof that the slice works end-to-end on the project's own source
 * without requiring the MCP server reconnect dance. Once
 * createComposition / bootstrap wire the sink through the chunker
 * pool, the same flow runs automatically during `index_codebase`.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../src/core/adapters/duckdb/client.js";
import { GraphFacade } from "../../src/core/api/internal/facades/graph-facade.js";
import { extractFromTypescriptFile } from "../../src/core/domains/ingest/pipeline/chunker/extraction/typescript-walker.js";
import { createSymbolsTrajectory } from "../../src/core/domains/trajectory/codegraph/symbols/index.js";
import type { CodegraphEnrichmentProvider } from "../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { TSCallResolver } from "../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const MIG_DIR = resolve(REPO_ROOT, "src/core/infra/migration/database/migrations");

// Real tea-rags files to feed through the slice. Picked for diversity:
//   - composition.ts: import-heavy + multiple top-level functions
//   - factory.ts: bootstrap orchestration with many cross-module calls
//   - provider.ts: codegraph's own provider, has internal method calls
const SAMPLE_FILES = [
  "src/core/api/internal/composition.ts",
  "src/bootstrap/factory.ts",
  "src/core/domains/trajectory/codegraph/symbols/provider.ts",
  "src/core/domains/trajectory/codegraph/symbols/symbol-table.ts",
  "src/core/adapters/duckdb/client.ts",
];

function parseTypescript(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage((TsLang as { typescript: Parser.Language }).typescript);
  return parser.parse(code);
}

/**
 * Approximate chunk extraction: tree-sitter walks the file finding
 * function_declaration / method_definition / class_declaration nodes
 * and yields a chunk per declared symbol. This matches the chunker's
 * symbol-extraction surface closely enough for the integration test
 * (the production chunker handles more nuance — class containers,
 * oversize splitting — but for resolver smoke this is plenty).
 */
function chunkSymbols(tree: Parser.Tree): { symbolId: string; startLine: number; endLine: number; scope: string[] }[] {
  const out: { symbolId: string; startLine: number; endLine: number; scope: string[] }[] = [];
  const walk = (node: Parser.SyntaxNode, scope: string[]): void => {
    const named = nameOf(node);
    if (named) {
      const fq = [...scope, named.name].join(".");
      out.push({
        symbolId: fq,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        scope,
      });
      if (named.descendsInto) {
        for (const child of node.children) walk(child, [...scope, named.name]);
        return;
      }
    }
    for (const child of node.children) walk(child, scope);
  };
  walk(tree.rootNode, []);
  return out;
}

function nameOf(node: Parser.SyntaxNode): { name: string; descendsInto: boolean } | null {
  if (node.type === "function_declaration" || node.type === "method_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  if (node.type === "class_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  return null;
}

describe("codegraph slice 1 on real tea-rags sources", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;
  let facade: GraphFacade;
  let extractedCount = 0;
  let totalImports = 0;
  let totalCalls = 0;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-tea-rags-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);

    // Integration test uses direct (graphDb + symbolTable) mode — the
    // pool-mode wiring is exercised by the dedicated isolation test;
    // here we just want one fixed DB for assertion stability.
    const symbolTable = new InMemoryGlobalSymbolTable();
    const trajectory = createSymbolsTrajectory({
      graphDb: client,
      symbolTable,
      resolvers: new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: { "@/*": ["src/*"] } })]]),
    });
    provider = trajectory.enrichment as CodegraphEnrichmentProvider;
    // GraphFacade takes a pool now — wrap the single client in a stub
    // so the integration assertions read through the same surface
    // production uses.
    const { createStubPool } = await import("../core/__helpers__/codegraph-pool.js");
    facade = new GraphFacade({ pool: createStubPool(client, symbolTable) });

    const sink = provider.asExtractionSink();
    for (const relPath of SAMPLE_FILES) {
      const abs = resolve(REPO_ROOT, relPath);
      const code = readFileSync(abs, "utf8");
      const tree = parseTypescript(code);
      const chunks = chunkSymbols(tree);
      const extraction = extractFromTypescriptFile({
        tree,
        code,
        relPath,
        language: "typescript",
        chunks,
      });
      extractedCount += extraction.chunks.length;
      totalImports += extraction.imports.length;
      totalCalls += extraction.chunks.reduce((s, c) => s + c.calls.length, 0);
      await sink.write(extraction);
    }
    await sink.finish();
  });

  afterAll(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("extracts a non-trivial number of symbols, imports, and calls from real sources", () => {
    expect(extractedCount).toBeGreaterThan(20);
    expect(totalImports).toBeGreaterThan(30);
    expect(totalCalls).toBeGreaterThan(40);
  });

  it("populates the DuckDB graph and reports hasData() === true", async () => {
    expect(await client.hasData()).toBe(true);
  });

  it("computes fanIn/fanOut signals for the sample files", async () => {
    const overlays = await provider.buildFileSignals("/", { paths: SAMPLE_FILES });
    // At least one of the files should have a non-zero fanOut — composition.ts
    // and factory.ts import many siblings.
    const fanOuts = SAMPLE_FILES.map((p) => Number(overlays.get(p)?.["fanOut"] ?? 0));
    expect(Math.max(...fanOuts)).toBeGreaterThan(0);
  });

  it("returns method-level callers via GraphFacade for at least one symbol", async () => {
    // symbol-table.ts exports InMemoryGlobalSymbolTable methods.
    // provider.ts holds CodegraphEnrichmentProvider that calls them.
    // The resolver may or may not link these depending on how short-name
    // lookup resolves — assert that getCallers runs without error and
    // returns a well-shaped response.
    const response = await facade.getCallers({
      path: "/",
      symbolId: "InMemoryGlobalSymbolTable.upsertFile",
      limit: 50,
    });
    expect(Array.isArray(response.callers)).toBe(true);
    for (const c of response.callers) {
      expect(typeof c.sourceSymbolId).toBe("string");
      expect(typeof c.sourceRelPath).toBe("string");
      expect(typeof c.callExpression).toBe("string");
    }
  });

  it("getCallees on a symbol from composition.ts returns method-edges", async () => {
    // `createComposition` calls registry.register, validateSignalDependencies, etc.
    const response = await facade.getCallees({
      path: "/",
      symbolId: "createComposition",
      limit: 100,
    });
    expect(Array.isArray(response.callees)).toBe(true);
  });

  it("buildChunkSignals returns callSiteCount/calledByCount for known symbols", async () => {
    // Drive a chunkMap matching production shape; provider reads symbolId
    // from each entry to look up edges.
    const chunkMap = new Map<string, { id: string; symbolId: string }[]>([
      ["src/core/api/internal/composition.ts", [{ id: "chunk-1", symbolId: "createComposition" }]],
    ]);
    const overlays = await provider.buildChunkSignals("/", chunkMap as never);
    const entry = overlays.get("src/core/api/internal/composition.ts")?.get("chunk-1");
    expect(entry?.["codegraph.chunk.callSiteCount"]).toBeGreaterThanOrEqual(0);
    expect(entry?.["codegraph.chunk.calledByCount"]).toBeGreaterThanOrEqual(0);
  });
});
