/**
 * The call-return stage end to end (bd tea-rags-mcp-4p3sb.21): TypeScript
 * source → the COMPOSED walker → `buildIdentifierRows` → `cg_identifiers` on an
 * in-process DuckDB → `aggregateIdentifiersByType`.
 *
 * Invariant: an untyped local bound to a call is typed by the TARGET's `return`
 * row, which a TypeScript function now publishes from its return annotation —
 * the join the lexicon had for Ruby alone. An async function's `Promise<T>`
 * types an awaited local as `T`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { IdentifierRow } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";
import { DATABASE_MIGRATIONS } from "../../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { buildIdentifierRows } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/identifier-rows.js";

function rowsOf(relPath: string, code: string, chunks: WalkInput["chunks"]): IdentifierRow[] {
  const parser = new Parser();
  parser.setLanguage(TsLang.typescript);
  const extraction = new TypeScriptLanguage().walker.walk({
    tree: parser.parse(code),
    code,
    relPath,
    language: "typescript",
    chunks,
  });
  return buildIdentifierRows(extraction);
}

const LOADER = "src/loader.ts";
const CONSUMER = "src/consumer.ts";

describe("call-return typing of a TypeScript local", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-call-return-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function insertExactEdge(targetSymbolId: string, callExpression: string): Promise<void> {
    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_rel_path, call_expression, target_symbol_key,
          target_symbol_id, edge_kind, confidence)
       VALUES (?, ?, ?, ?, ?, ?, 'exact', 1.0)`,
      ["run", CONSUMER, LOADER, callExpression, targetSymbolId, targetSymbolId],
    );
  }

  it("types `const doc = loadDocument(id)` as the callee's declared return, reported as call-return", async () => {
    const loaderRows = rowsOf(
      LOADER,
      [
        "export function loadDocument(id: string): Document { return find(id); }",
        "export async function fetchDocument(id: string): Promise<Document> { return find(id); }",
      ].join("\n"),
      [
        { symbolId: "loadDocument", startLine: 1, endLine: 1, scope: [] },
        { symbolId: "fetchDocument", startLine: 2, endLine: 2, scope: [] },
      ],
    );
    const consumerRows = rowsOf(
      CONSUMER,
      [
        "export async function run(id: string) {",
        "  const doc = loadDocument(id);",
        "  const fetched = await fetchDocument(id);",
        "}",
      ].join("\n"),
      [{ symbolId: "run", startLine: 1, endLine: 4, scope: [] }],
    );
    const bound = new Map(consumerRows.map((r) => [r.name, r.boundCallExpression]));
    expect(bound.get("doc")).toBeDefined();
    expect(bound.get("fetched")).toBeDefined();

    await db.replaceIdentifiersBulk([
      { relPath: LOADER, rows: loaderRows },
      { relPath: CONSUMER, rows: consumerRows },
    ]);
    await insertExactEdge("loadDocument", bound.get("doc") ?? "");
    await insertExactEdge("fetchDocument", bound.get("fetched") ?? "");

    const locals = (await db.aggregateIdentifiersByType({ types: ["Document"] })).filter((r) => r.kind === "local");
    expect(locals).toEqual([
      { typeName: "Document", kind: "local", name: "doc", typeSource: "call-return", n: 1, exampleOwner: "run" },
      { typeName: "Document", kind: "local", name: "fetched", typeSource: "call-return", n: 1, exampleOwner: "run" },
    ]);
  });
});
