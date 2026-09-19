import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallContext, FileExtraction, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-7h6j0 — the run-global `functionReturnTypes` channel is keyed
 * by the DECLARING PACKAGE (`<package dir>::<name>`), not the bare name. Keyed
 * bare, two packages each declaring `New()` crossed return types: package `a`'s
 * bare `x := New(); x.Run()` and main's `p := a.New(); p.Run()` both typed the
 * receiver through whichever package's `New` the absorb had seen LAST, so both
 * landed on `Pump#Run` in `b` — and which one won depended on which files the
 * run walked, making an incremental index resolve differently from a full one.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

const A_USER = [
  "package a",
  "",
  "type Runner struct{}",
  "",
  "func (r *Runner) Run() {}",
  "",
  "func New() *Runner { return &Runner{} }",
  "",
  "func bareCall() {",
  "\tx := New()",
  "\tx.Run()",
  "}",
];

const B_FACTORY = [
  "package b",
  "",
  "type Pump struct{}",
  "",
  "func (p *Pump) Run() {}",
  "",
  "func New() *Pump { return &Pump{} }",
];

const MAIN_CALLER = [
  "package main",
  "",
  'import "example.com/names/a"',
  "",
  "func qualifiedCall() {",
  "\tp := a.New()",
  "\tp.Run()",
  "}",
];

function walk(relPath: string, lines: string[]): FileExtraction {
  const src = `${lines.join("\n")}\n`;
  const parser = new Parser();
  parser.setLanguage(GoLang);
  const tree = parser.parse(src);
  const chunks = tree.rootNode.children
    .filter((node) => node.type === "function_declaration" || node.type === "method_declaration")
    .map((node) => ({
      symbolId: node.childForFieldName("name")?.text ?? "",
      scope: [],
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    }));
  return new GoLanguage().walker.walk({ tree, code: src, relPath, language: "go", chunks });
}

function corpus(): { a: FileExtraction; b: FileExtraction; main: FileExtraction; table: InMemoryGlobalSymbolTable } {
  const a = walk("a/user.go", A_USER);
  const b = walk("b/new.go", B_FACTORY);
  const main = walk("main/main.go", MAIN_CALLER);
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile(
    "a/user.go",
    ["Runner", "Runner#Run", "New", "bareCall"].map((id) => sym(id, "a/user.go")),
  );
  table.upsertFile(
    "b/new.go",
    ["Pump", "Pump#Run", "New"].map((id) => sym(id, "b/new.go")),
  );
  table.upsertFile("main/main.go", [sym("qualifiedCall", "main/main.go")]);
  return { a, b, main, table };
}

/** Resolve every call of `extraction` against `returnTypes` absorbed in `order`. */
function resolveCalls(
  extraction: FileExtraction,
  order: readonly FileExtraction[],
  table: InMemoryGlobalSymbolTable,
  root: string,
): Map<string, string | null> {
  const go = new GoLanguage();
  go.resolver.prepareResolvePass?.({ expectedFileCount: 3, projectRoot: root });
  const out = new Map<string, string | null>();
  for (const chunk of extraction.chunks) {
    const ctx: CallContext = {
      callerFile: extraction.relPath,
      callerScope: [],
      imports: extraction.imports,
      symbolTable: table,
      projectRoot: root,
      localBindings: chunk.localBindings,
      callResultBindings: chunk.callResultBindings,
      // Run-global in production: every file's return types, merged in `order`.
      functionReturnTypes: Object.assign({}, ...order.map((e) => e.functionReturnTypes ?? {})),
      classFieldTypesByClassKey: {},
    };
    for (const call of chunk.calls) {
      const target = go.resolver.resolve(call, ctx);
      out.set(
        `${chunk.symbolId}:${call.receiver}.${call.member}`,
        target ? `${target.targetSymbolId} @ ${target.targetRelPath}` : null,
      );
    }
  }
  return out;
}

describe("a namesake constructor resolves within its own package", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tea-rags-go-namesake-"));
    writeFileSync(join(root, "go.mod"), "module example.com/names\n\ngo 1.22\n", "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("types a BARE call through the caller's own package's New", () => {
    const { a, b, main, table } = corpus();
    // b absorbed LAST — under bare keys it would win `New` and speak for a's call.
    const resolved = resolveCalls(a, [a, b, main], table, root);
    expect(resolved.get("bareCall:x.Run")).toBe("Runner#Run @ a/user.go");
  });

  it("types a PACKAGE-QUALIFIED call through the import's package's New", () => {
    const { a, b, main, table } = corpus();
    const resolved = resolveCalls(main, [a, b, main], table, root);
    expect(resolved.get("qualifiedCall:p.Run")).toBe("Runner#Run @ a/user.go");
  });

  it("keys a declared function and a func-valued var under the declaring package", () => {
    const { a } = corpus();
    expect(a.functionReturnTypes?.["a::New"]).toBe("Runner");
  });
});

describe("return-type resolution is identical under either absorb order", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tea-rags-go-namesake-order-"));
    writeFileSync(join(root, "go.mod"), "module example.com/names\n\ngo 1.22\n", "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves the bare call to the same target whether a or b absorbed last", () => {
    const { a, b, table } = corpus();
    const aLast = resolveCalls(a, [b, a], table, root).get("bareCall:x.Run");
    const bLast = resolveCalls(a, [a, b], table, root).get("bareCall:x.Run");
    expect(aLast).toBe("Runner#Run @ a/user.go");
    expect(bLast).toBe(aLast);
  });

  it("resolves the qualified call to the same target whether a or b absorbed last", () => {
    const { a, b, main, table } = corpus();
    const aLast = resolveCalls(main, [b, a], table, root).get("qualifiedCall:p.Run");
    const bLast = resolveCalls(main, [a, b], table, root).get("qualifiedCall:p.Run");
    expect(aLast).toBe("Runner#Run @ a/user.go");
    expect(bLast).toBe(aLast);
  });
});
