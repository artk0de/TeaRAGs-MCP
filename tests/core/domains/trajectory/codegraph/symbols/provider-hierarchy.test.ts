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
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

describe("CodegraphEnrichmentProvider — hierarchy persistence (f10y)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-prov-hier-"));
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

  it("persists inheritanceEdges through the sink into the reverse index", async () => {
    const sink = provider.asExtractionSink();
    for (const impl of ["Onnx", "Remote"]) {
      await sink.write({
        relPath: `src/${impl.toLowerCase()}.ts`,
        language: "typescript",
        imports: [],
        chunks: [{ symbolId: impl, scope: [], calls: [] }],
        fileScope: [],
        inheritanceEdges: [{ source: impl, ancestor: "EmbeddingProvider", kind: "implements", ordinal: 0 }],
      });
    }
    await sink.finish();

    const subs = await client.getSubtypes("EmbeddingProvider");
    expect(subs.map((e) => e.sourceFqName).sort()).toEqual(["Onnx", "Remote"]);
    expect(subs.every((e) => e.kind === "implements")).toBe(true);
  });

  it("resolves the source class to its symbol_id when present in the table", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/dog.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Dog", scope: [], calls: [] }],
      fileScope: [],
      inheritanceEdges: [{ source: "Dog", ancestor: "Animal", kind: "super", ordinal: 0 }],
    });
    await sink.finish();

    const snap = await client.loadHierarchySnapshot();
    expect(snap.ancestorsBySource["Dog"][0]).toMatchObject({
      ancestorFqName: "Animal",
      sourceSymbolId: "Dog", // class chunk symbol was upserted in pass-1, so it resolves
    });
  });

  it("removeFile drops the file's inheritance rows", async () => {
    const sink = provider.asExtractionSink();
    await sink.write({
      relPath: "src/onnx.ts",
      language: "typescript",
      imports: [],
      chunks: [{ symbolId: "Onnx", scope: [], calls: [] }],
      fileScope: [],
      inheritanceEdges: [{ source: "Onnx", ancestor: "EmbeddingProvider", kind: "implements", ordinal: 0 }],
    });
    await sink.finish();
    await provider.handleDeletedPaths(["src/onnx.ts"]);

    expect(await client.getSubtypes("EmbeddingProvider")).toEqual([]);
  });
});
