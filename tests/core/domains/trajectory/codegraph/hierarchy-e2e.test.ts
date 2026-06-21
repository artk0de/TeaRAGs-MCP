import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Parser from "tree-sitter";
import { typescript as TsLang } from "tree-sitter-typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import type { FileExtraction } from "../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { extractFromTypescriptFile } from "../../../../../src/core/domains/language/typescript/walker/walker.js";
import { CodegraphEnrichmentProvider } from "../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../src/core/infra/migration/database/runner.js";
import { buildTestCodegraphDeps } from "./__helpers__/language-factory.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../src/core/infra/migration/database/migrations");

// Real TS source → real walker capture → provider persistence → reverse index.
// Each top-level class/interface is fed to the walker as one chunk so the
// symbol reaches cg_symbols; the walker extracts inheritanceEdges from the parse.
function walk(relPath: string, src: string): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(TsLang as unknown as Parser.Language);
  const tree = parser.parse(src);
  const name = /(?:class|interface)\s+(\w+)/.exec(src)?.[1] ?? "X";
  return extractFromTypescriptFile({
    tree,
    code: src,
    relPath,
    language: "typescript",
    chunks: [{ symbolId: name, scope: [], startLine: 1, endLine: src.split("\n").length }],
  });
}

describe("hierarchy graph E2E", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-hier-e2e-"));
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

  it("interface with N implementers → reverse index returns all N", async () => {
    const files: Record<string, string> = {
      "embedding-provider.ts": `export interface EmbeddingProvider { embed(): number[]; }`,
      "onnx.ts": `export class Onnx implements EmbeddingProvider { embed() { return []; } }`,
      "remote.ts": `export class Remote implements EmbeddingProvider { embed() { return []; } }`,
      "jina.ts": `export class Jina implements EmbeddingProvider { embed() { return []; } }`,
    };
    const sink = provider.asExtractionSink();
    for (const [relPath, src] of Object.entries(files)) await sink.write(walk(relPath, src));
    await sink.finish();

    const subs = await client.getSubtypes("EmbeddingProvider");
    expect(subs.map((e) => e.sourceFqName).sort()).toEqual(["Jina", "Onnx", "Remote"]);
    expect(subs.every((e) => e.kind === "implements")).toBe(true);
  });

  it("walks a multi-level class chain transitively", async () => {
    const files: Record<string, string> = {
      "animal.ts": `export class Animal {}`,
      "dog.ts": `export class Dog extends Animal {}`,
      "puppy.ts": `export class Puppy extends Dog {}`,
    };
    const sink = provider.asExtractionSink();
    for (const [relPath, src] of Object.entries(files)) await sink.write(walk(relPath, src));
    await sink.finish();

    const direct = await client.getSubtypes("Animal");
    expect(direct.map((e) => e.sourceFqName)).toEqual(["Dog"]);
    const trans = await client.getTransitiveSubtypes("Animal");
    expect(trans.map((e) => e.sourceFqName).sort()).toEqual(["Dog", "Puppy"]);
  });
});
