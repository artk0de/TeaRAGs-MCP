import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import type { CallContext, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * A local assigned a call's result (`config := config.Load()`) is typed
 * through the callee's declared return type — but only where the local is in
 * SCOPE: after its declaring statement, up to the end of its block. The call
 * binding used to be chunk-wide, so it spoke for every `config` in the
 * function — the right-hand side's own `config.Load()` and any `config.X()`
 * above the declaration included, both calls of the imported package. Walker
 * and resolver together, the context built the way the runner builds it.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

function projectTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  const cfg = "app/config/config.go";
  t.upsertFile(cfg, [
    sym("Config", cfg),
    sym("Config#Validate", cfg),
    sym("Load", cfg),
    sym("LoadAny", cfg),
    sym("Merge", cfg),
    sym("Default", cfg),
    sym("Validate", cfg),
    sym("Ready", cfg),
  ]);
  t.upsertFile("app/engine.go", [
    sym("Engine", "app/engine.go"),
    sym("Engine#Use", "app/engine.go"),
    sym("Engine#Ready", "app/engine.go"),
    sym("New", "app/engine.go"),
    sym("NewEngine", "app/engine.go"),
    sym("Plugin", "app/engine.go"),
    sym("Plugin#Use", "app/engine.go"),
  ]);
  t.upsertFile("app/iter.go", [
    sym("Iterator", "app/iter.go"),
    sym("Iterator#Valid", "app/iter.go"),
    sym("Iterator#Next", "app/iter.go"),
    sym("NewIterator", "app/iter.go"),
  ]);
  return t;
}

const HEADER = ["package app", "", 'import "app/config"'];

/** Resolve the single function in `body`; keys are `<offset from the func line>:<receiver>.<member>`. */
function resolveAll(body: string[]): Map<string, string | null> {
  const lines = [...HEADER, ...body];
  const src = `${lines.join("\n")}\n`;
  const parser = new Parser();
  parser.setLanguage(GoLang);
  const startLine = HEADER.length + 1;
  const go = new GoLanguage();
  const extraction = go.walker.walk({
    tree: parser.parse(src),
    code: src,
    relPath: "app/app.go",
    language: "go",
    chunks: [{ symbolId: "f", scope: [], startLine, endLine: lines.length }],
  });
  const chunk = extraction.chunks[0];
  const ctx: CallContext = {
    callerFile: "app/app.go",
    callerScope: [],
    imports: extraction.imports,
    symbolTable: projectTable(),
    localBindings: chunk.localBindings,
    localCallBindings: chunk.localCallBindings,
    callResultBindings: chunk.callResultBindings,
    // Run-global in production: declared in other files.
    functionReturnTypes: {
      Load: "Config",
      Merge: "Config",
      New: "Engine",
      NewEngine: "Engine",
      NewIterator: "Iterator",
    },
  };
  const out = new Map<string, string | null>();
  for (const call of chunk.calls) {
    const target = go.resolver.resolve(call, ctx);
    out.set(
      `${call.startLine - startLine}:${call.receiver}.${call.member}`,
      target ? `${target.targetSymbolId} @ ${target.targetRelPath}` : null,
    );
  }
  return out;
}

describe("Go call bindings are in scope after their statement, within their block", () => {
  it("the declaring statement's right-hand side still calls the package; later calls use the local", () => {
    const resolved = resolveAll(["func f() {", "\tconfig := config.Load()", "\tconfig.Validate()", "}"]);
    expect(resolved.get("1:config.Load")).toBe("Load @ app/config/config.go");
    expect(resolved.get("2:config.Validate")).toBe("Config#Validate @ app/config/config.go");
  });

  it("a call above the declaration still calls the package", () => {
    const resolved = resolveAll([
      "func f() {",
      "\tconfig.Validate()",
      "\tconfig := config.Load()",
      "\tconfig.Validate()",
      "}",
    ]);
    expect(resolved.get("1:config.Validate")).toBe("Validate @ app/config/config.go");
    expect(resolved.get("3:config.Validate")).toBe("Config#Validate @ app/config/config.go");
  });

  it("a multi-line right-hand side names the package on every one of its lines", () => {
    const resolved = resolveAll([
      "func f() {",
      "\tconfig := config.Merge(",
      "\t\tconfig.Default(),",
      "\t)",
      "\tconfig.Validate()",
      "}",
    ]);
    expect(resolved.get("2:config.Default")).toBe("Default @ app/config/config.go");
    expect(resolved.get("4:config.Validate")).toBe("Config#Validate @ app/config/config.go");
  });

  it("NEGATIVE: a call-bound local of unknown type is not the package it shadows", () => {
    const resolved = resolveAll(["func f() {", "\tconfig := config.LoadAny()", "\tconfig.Validate()", "}"]);
    expect(resolved.get("1:config.LoadAny")).toBe("LoadAny @ app/config/config.go");
    expect(resolved.get("2:config.Validate")).toBeNull();
  });

  it("a call binding in a nested block does not outlive it; the outer binding is back after it", () => {
    const resolved = resolveAll([
      "func f(e *Plugin, ok bool) {",
      "\tif ok {",
      "\t\te := New()",
      "\t\te.Use()",
      "\t}",
      "\te.Use()",
      "}",
    ]);
    expect(resolved.get("3:e.Use")).toBe("Engine#Use @ app/engine.go");
    expect(resolved.get("5:e.Use")).toBe("Plugin#Use @ app/engine.go");
  });
});

/**
 * An init declaration in an `if` / `switch` / `for` header is in scope for the
 * REST of that header — `if e := NewEngine(); e.Ready() {` calls `Ready` on the
 * local, on the declaration's own line. A call site carries a line and no
 * column, so the statement-end rule above can only be applied where it is
 * needed: when the right-hand side names the very identifier being declared
 * (`config := config.Load()`). Anywhere else the local is visible from its line.
 */
describe("Go header init declarations are visible on their own line", () => {
  it("`if e := NewEngine(); e.Ready() {` types the condition's receiver", () => {
    const resolved = resolveAll(["func f() {", "\tif e := NewEngine(); e.Ready() {", "\t\te.Use()", "\t}", "}"]);
    expect(resolved.get("1:e.Ready")).toBe("Engine#Ready @ app/engine.go");
    expect(resolved.get("2:e.Use")).toBe("Engine#Use @ app/engine.go");
  });

  it("`switch e := NewEngine(); e.Ready() {` types the tag's receiver", () => {
    const resolved = resolveAll([
      "func f() {",
      "\tswitch e := NewEngine(); e.Ready() {",
      "\tcase true:",
      "\t\te.Use()",
      "\t}",
      "}",
    ]);
    expect(resolved.get("1:e.Ready")).toBe("Engine#Ready @ app/engine.go");
    expect(resolved.get("3:e.Use")).toBe("Engine#Use @ app/engine.go");
  });

  it("the iterator idiom types both the condition and the post statement", () => {
    const resolved = resolveAll(["func f() {", "\tfor it := NewIterator(); it.Valid(); it.Next() {", "\t}", "}"]);
    expect(resolved.get("1:it.Valid")).toBe("Iterator#Valid @ app/iter.go");
    expect(resolved.get("1:it.Next")).toBe("Iterator#Next @ app/iter.go");
  });

  it("NEGATIVE: a header local shadowing an import is the local on its own line, never the package", () => {
    const resolved = resolveAll([
      "func f() {",
      "\tif config, err := loadTwo(); config.Ready() {",
      "\t\t_ = err",
      "\t}",
      "}",
    ]);
    expect(resolved.get("1:config.Ready")).toBeNull();
  });
});
