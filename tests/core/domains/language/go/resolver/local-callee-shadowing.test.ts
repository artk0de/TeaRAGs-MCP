import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * A bare call through a LOCAL is a call of a function value, never of the
 * package-level declaration it shadows: `helper := func() {}; helper()` and
 * `func f(loadAll []func()) { loadAll[0]() }` call what the local holds.
 * `globalShortName` had no shadow check at all, and `genericInstantiation`
 * checked only the bindings the walker happened to record — none for a
 * slice, map or func parameter, or a local assigned a function literal. And
 * `loadAll[0]` is no instantiation to begin with: `0` is not a type.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

function packageTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("app/helpers.go", [
    sym("helper", "app/helpers.go"),
    sym("loadAll", "app/helpers.go"),
    sym("fs", "app/helpers.go"),
    sym("getTyped", "app/helpers.go"),
  ]);
  return t;
}

interface Walked {
  calls: CallRef[];
  resolved: Map<string, string | null>;
}

/** Walk and resolve the single function in `body`; keys are `<offset from the func line>:<member>`. */
function walkAndResolve(body: string[]): Walked {
  const lines = ["package app", "", ...body];
  const src = `${lines.join("\n")}\n`;
  const parser = new Parser();
  parser.setLanguage(GoLang);
  const startLine = 3;
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
    symbolTable: packageTable(),
    localBindings: chunk.localBindings,
    localCallBindings: chunk.localCallBindings,
  };
  const resolved = new Map<string, string | null>();
  for (const call of chunk.calls) {
    resolved.set(
      `${call.startLine - startLine}:${call.member}`,
      go.resolver.resolve(call, ctx)?.targetSymbolId ?? null,
    );
  }
  return { calls: chunk.calls, resolved };
}

describe("Go bare calls through a local function value", () => {
  it("NEGATIVE: a local assigned a function literal shadows the package func it names", () => {
    const { resolved } = walkAndResolve(["func f() {", "\thelper := func() {}", "\thelper()", "}"]);
    expect(resolved.get("2:helper")).toBeNull();
  });

  it("a bare call before the local is declared still names the package func", () => {
    const { resolved } = walkAndResolve(["func f() {", "\thelper()", "\thelper := func() {}", "\thelper()", "}"]);
    expect(resolved.get("1:helper")).toBe("helper");
    expect(resolved.get("3:helper")).toBeNull();
  });

  it("NEGATIVE: an indexed call through a slice parameter is no call of the package func", () => {
    const { resolved } = walkAndResolve(["func f(loadAll []func()) {", "\tloadAll[0]()", "}"]);
    expect(resolved.get("1:loadAll[0]")).toBeNull();
  });

  it("NEGATIVE: an index that may be a type still yields no edge when the operand is a local", () => {
    const { resolved } = walkAndResolve(["func f(fs []func(int), i int) {", "\tfs[i](1)", "}"]);
    expect(resolved.get("1:fs[i]")).toBeNull();
  });

  it("marks a call whose index is a literal as statically undeterminable, not an instantiation", () => {
    const { calls } = walkAndResolve(["func f(loadAll []func()) {", "\tloadAll[0]()", "}"]);
    expect(calls.find((c) => c.member === "loadAll[0]")?.dynamicSend).toBe(true);
  });

  it("keeps an instantiation with a type argument resolvable", () => {
    const { calls, resolved } = walkAndResolve(["func f(c int) {", "\tgetTyped[string](c, 1)", "}"]);
    expect(calls.find((c) => c.member === "getTyped[string]")?.dynamicSend).toBeUndefined();
    expect(resolved.get("1:getTyped[string]")).toBe("getTyped");
  });
});
