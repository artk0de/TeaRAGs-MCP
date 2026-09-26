/**
 * The call-return stage end to end (bd tea-rags-mcp-4p3sb.21): TypeScript
 * source → the COMPOSED walker → `buildIdentifierRows` → `cg_identifiers` on an
 * in-process DuckDB → `aggregateIdentifiersByType`.
 *
 * Invariant: an untyped local bound to a call is typed by the TARGET's `return`
 * row, which a TypeScript function now publishes from its return annotation —
 * the join the lexicon had for Ruby alone. An async function's `Promise<T>`
 * types an awaited local as `T`, and a Rust fn's `Result<T, E>` types a local
 * bound through `?` as `T`; bound without the `await` / `?`, the local holds
 * the `Promise` / `Result` itself (bd tea-rags-mcp-bjzaf).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Parser from "tree-sitter";
import RustLang from "tree-sitter-rust";
import TsLang from "tree-sitter-typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { IdentifierRow } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { WalkInput } from "../../../../../../src/core/contracts/types/language.js";
import { RustLanguage } from "../../../../../../src/core/domains/language/rust/index.js";
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

function rustRowsOf(relPath: string, code: string, chunks: WalkInput["chunks"]): IdentifierRow[] {
  const parser = new Parser();
  parser.setLanguage(RustLang);
  const extraction = new RustLanguage().walker.walk({
    tree: parser.parse(code),
    code,
    relPath,
    language: "rust",
    chunks,
  });
  return buildIdentifierRows(extraction);
}

const LOADER = "src/loader.ts";
const CONSUMER = "src/consumer.ts";

/** A migrated in-process graph DB per test, and an exact edge from `run` in `consumer` to a `loader` target. */
function useGraphDb(loader: string, consumer: string) {
  const state: { dir: string; db: DuckDbGraphClient } = { dir: "", db: undefined as unknown as DuckDbGraphClient };

  beforeEach(async () => {
    state.dir = mkdtempSync(join(tmpdir(), "cg-call-return-"));
    state.db = new DuckDbGraphClient({ path: join(state.dir, "g.duckdb") });
    await state.db.init();
    await runMigrations(state.db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await state.db.close();
    rmSync(state.dir, { recursive: true, force: true });
  });

  async function insertExactEdge(targetSymbolId: string, callExpression: string): Promise<void> {
    await state.db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_rel_path, call_expression, target_symbol_key,
          target_symbol_id, edge_kind, confidence)
       VALUES (?, ?, ?, ?, ?, ?, 'exact', 1.0)`,
      ["run", consumer, loader, callExpression, targetSymbolId, targetSymbolId],
    );
  }

  return { state, insertExactEdge };
}

describe("call-return typing of a TypeScript local", () => {
  const { state, insertExactEdge } = useGraphDb(LOADER, CONSUMER);

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
        "  const pending = fetchDocument(id);",
        "}",
      ].join("\n"),
      [{ symbolId: "run", startLine: 1, endLine: 5, scope: [] }],
    );
    const bound = new Map(consumerRows.map((r) => [r.name, r.boundCallExpression]));
    expect(bound.get("doc")).toBeDefined();
    expect(bound.get("fetched")).toBeDefined();

    await state.db.replaceIdentifiersBulk([
      { relPath: LOADER, rows: loaderRows },
      { relPath: CONSUMER, rows: consumerRows },
    ]);
    await insertExactEdge("loadDocument", bound.get("doc") ?? "");
    await insertExactEdge("fetchDocument", bound.get("fetched") ?? "");
    // `pending` binds the same call text as `fetched`: one edge serves both.
    expect(bound.get("pending")).toBe(bound.get("fetched"));

    const locals = (await state.db.aggregateIdentifiersByType({ types: ["Document", "Promise"] })).filter(
      (r) => r.kind === "local",
    );
    // Not awaited, `pending` holds the Promise (bd tea-rags-mcp-bjzaf).
    expect(locals).toEqual([
      { typeName: "Document", kind: "local", name: "doc", typeSource: "call-return", n: 1, exampleOwner: "run" },
      { typeName: "Document", kind: "local", name: "fetched", typeSource: "call-return", n: 1, exampleOwner: "run" },
      { typeName: "Promise", kind: "local", name: "pending", typeSource: "call-return", n: 1, exampleOwner: "run" },
    ]);
  });

  // bd tea-rags-mcp-bjzaf — an async `Promise<void>` resolves to nothing, yet is a Promise until awaited.
  it("types `const p = save()` as Promise for an async `Promise<void>` and leaves `await save()` untyped", async () => {
    const loaderRows = rowsOf(
      LOADER,
      [
        "export async function saveDocument(id: string): Promise<void> {}",
        "export function scheduleDocument(id: string): Promise<void> { return q(id); }",
      ].join("\n"),
      [
        { symbolId: "saveDocument", startLine: 1, endLine: 1, scope: [] },
        { symbolId: "scheduleDocument", startLine: 2, endLine: 2, scope: [] },
      ],
    );
    const consumerRows = rowsOf(
      CONSUMER,
      [
        "export async function run(id: string) {",
        "  const done = await saveDocument(id);",
        "  const saving = saveDocument(id);",
        "  const scheduled = scheduleDocument(id);",
        "}",
      ].join("\n"),
      [{ symbolId: "run", startLine: 1, endLine: 5, scope: [] }],
    );
    const bound = new Map(consumerRows.map((r) => [r.name, r.boundCallExpression]));
    expect(bound.get("saving")).toBe(bound.get("done"));

    await state.db.replaceIdentifiersBulk([
      { relPath: LOADER, rows: loaderRows },
      { relPath: CONSUMER, rows: consumerRows },
    ]);
    await insertExactEdge("saveDocument", bound.get("done") ?? "");
    await insertExactEdge("scheduleDocument", bound.get("scheduled") ?? "");

    // A non-async `Promise<void>` keeps its head, as before: a Promise returned as a value.
    expect(await state.db.identifierNameTypes(["done", "saving", "scheduled"])).toEqual([
      { name: "done", typeName: null, n: 1 },
      { name: "saving", typeName: "Promise", n: 1 },
      { name: "scheduled", typeName: "Promise", n: 1 },
    ]);
  });
});

// bd tea-rags-mcp-1hj3o — a Result is consumed through `?`, the way an async fn's value is through `.await`.
describe("call-return typing of a Rust local", () => {
  const RS_LOADER = "src/loader.rs";
  const RS_CONSUMER = "src/consumer.rs";
  const { state, insertExactEdge } = useGraphDb(RS_LOADER, RS_CONSUMER);

  it("types `let doc = load()?` as the T of `load`'s `Result<T, E>` and `let attempt = load()` as the Result", async () => {
    const loaderRows = rustRowsOf(
      RS_LOADER,
      [
        "pub fn load_document(id: u32) -> Result<Document, Error> { todo!() }",
        "pub fn find_document(id: u32) -> Option<Document> { todo!() }",
      ].join("\n"),
      [
        { symbolId: "load_document", startLine: 1, endLine: 1, scope: [] },
        { symbolId: "find_document", startLine: 2, endLine: 2, scope: [] },
      ],
    );
    const consumerRows = rustRowsOf(
      RS_CONSUMER,
      [
        "pub fn run(id: u32) -> Result<(), Error> {",
        "    let doc = load_document(id)?;",
        "    let found = find_document(id)?;",
        "    let attempt = load_document(id);",
        "    Ok(())",
        "}",
      ].join("\n"),
      [{ symbolId: "run", startLine: 1, endLine: 6, scope: [] }],
    );
    const bound = new Map(consumerRows.map((r) => [r.name, r.boundCallExpression]));
    expect(bound.get("doc")).toBeDefined();
    expect(bound.get("found")).toBeDefined();
    // With and without `?` the local binds the SAME call expression — the edge
    // join key — so the `?` travels beside it, on the local's own row.
    expect(bound.get("attempt")).toBe(bound.get("doc"));

    await state.db.replaceIdentifiersBulk([
      { relPath: RS_LOADER, rows: loaderRows },
      { relPath: RS_CONSUMER, rows: consumerRows },
    ]);
    await insertExactEdge("load_document", bound.get("doc") ?? "");
    await insertExactEdge("find_document", bound.get("found") ?? "");

    const locals = (await state.db.aggregateIdentifiersByType({ types: ["Document", "Result"] })).filter(
      (r) => r.kind === "local",
    );
    // `attempt` holds the Result itself (bd tea-rags-mcp-bjzaf). An `Option<T>`
    // stays read as `T` either way, as its annotation is.
    expect(locals).toEqual([
      { typeName: "Document", kind: "local", name: "doc", typeSource: "call-return", n: 1, exampleOwner: "run" },
      { typeName: "Document", kind: "local", name: "found", typeSource: "call-return", n: 1, exampleOwner: "run" },
      { typeName: "Result", kind: "local", name: "attempt", typeSource: "call-return", n: 1, exampleOwner: "run" },
    ]);
  });

  // bd tea-rags-mcp-bjzaf — a `Result<(), E>` has no T to name, yet binding it without `?` holds a Result.
  it("types `let r = save()` as Result for a `Result<(), E>` fn and leaves `let x = save()?` untyped", async () => {
    const loaderRows = rustRowsOf(RS_LOADER, "pub fn save_document(id: u32) -> Result<(), Error> { Ok(()) }", [
      { symbolId: "save_document", startLine: 1, endLine: 1, scope: [] },
    ]);
    const consumerRows = rustRowsOf(
      RS_CONSUMER,
      [
        "pub fn run(id: u32) -> Result<(), Error> {",
        "    let saved = save_document(id)?;",
        "    let pending = save_document(id);",
        "    Ok(())",
        "}",
      ].join("\n"),
      [{ symbolId: "run", startLine: 1, endLine: 5, scope: [] }],
    );
    const bound = new Map(consumerRows.map((r) => [r.name, r.boundCallExpression]));
    expect(bound.get("pending")).toBe(bound.get("saved"));

    await state.db.replaceIdentifiersBulk([
      { relPath: RS_LOADER, rows: loaderRows },
      { relPath: RS_CONSUMER, rows: consumerRows },
    ]);
    await insertExactEdge("save_document", bound.get("saved") ?? "");

    expect(await state.db.identifierNameTypes(["saved", "pending"])).toEqual([
      { name: "pending", typeName: "Result", n: 1 },
      { name: "saved", typeName: null, n: 1 },
    ]);
    const pending = (await state.db.aggregateIdentifiersByType({ types: ["Result"] })).filter(
      (r) => r.kind === "local",
    );
    expect(pending).toEqual([
      { typeName: "Result", kind: "local", name: "pending", typeSource: "call-return", n: 1, exampleOwner: "run" },
    ]);
    // The wrapper-only return rows (`save_document`, and `run`'s own) serve the join
    // alone: no identifier read lists them as an untyped declaration.
    expect(await state.db.identifierNameTypes(["save_document", "run"])).toEqual([]);
  });
});

// bd tea-rags-mcp-bjzaf — the wrapper facts are additive columns: a row written before them reads as it did.
describe("call-return typing across rows written before the unwrap facts", () => {
  const { state, insertExactEdge } = useGraphDb(LOADER, CONSUMER);

  /**
   * The target's `return` row and the caller's bound local, written as raw rows
   * so either fact can be NULL — the state a pre-036 row is in.
   */
  async function localTypes(returnWrapper: string | null, boundCallUnwrapped: boolean | null): Promise<string[]> {
    await state.db.run(
      `INSERT INTO cg_identifiers (rel_path, owner_symbol_id, kind, name, type_name, type_source, line, return_wrapper)
       VALUES (?, 'loadDocument', 'return', 'loadDocument', 'Document', 'return-type', 1, ?)`,
      [LOADER, returnWrapper],
    );
    await state.db.run(
      `INSERT INTO cg_identifiers (rel_path, owner_symbol_id, kind, name, line, bound_member, bound_call_expression,
                                   bound_call_unwrapped)
       VALUES (?, 'run', 'local', 'doc', 2, 'loadDocument', 'loadDocument(id)', ?)`,
      [CONSUMER, boundCallUnwrapped],
    );
    await insertExactEdge("loadDocument", "loadDocument(id)");
    const rows = await state.db.aggregateIdentifiersByType({ types: ["Document", "Promise"] });
    return rows.filter((r) => r.kind === "local").map((r) => r.typeName);
  }

  it("types a local as the target's T when neither row carries a fact (both NULL)", async () => {
    expect(await localTypes(null, null)).toEqual(["Document"]);
  });

  it("types a pre-036 local (bound_call_unwrapped NULL) as the T of a target that records its wrapper", async () => {
    expect(await localTypes("Promise", null)).toEqual(["Document"]);
  });

  it("types a local that did not unwrap as the target's wrapper", async () => {
    expect(await localTypes("Promise", false)).toEqual(["Promise"]);
  });

  it("types a local that unwrapped as the target's T", async () => {
    expect(await localTypes("Promise", true)).toEqual(["Document"]);
  });

  it("types a local that did not unwrap as the T of a target with no wrapper", async () => {
    expect(await localTypes(null, false)).toEqual(["Document"]);
  });

  // A wrapper-only row (`Result<(), E>`) has no type_name: count(DISTINCT type_name) ignores it, so it
  // never turns a target whose typed rows agree into a disagreeing one.
  it("keeps a target typed when a wrapper-only return row sits beside its typed one", async () => {
    await state.db.run(
      `INSERT INTO cg_identifiers (rel_path, owner_symbol_id, kind, name, line, return_wrapper)
       VALUES (?, 'loadDocument', 'return', 'loadDocument', 1, 'Promise')`,
      [LOADER],
    );
    expect(await localTypes("Promise", true)).toEqual(["Document"]);
  });
});
