/**
 * The walker-scope mirror (bd tea-rags-mcp-lvlwc): for a declaration node the
 * checker hands back, the names of the enclosing nodes `tsNameOf` names,
 * outermost first — or `null` where the mirror cannot reproduce the walker's
 * name, so the pin declines instead of guessing.
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { CallContext, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  isFunctionValuedInitializer,
  pinFunctionByWalkerScope,
  sameWalkerScope,
  walkerScopeOf,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-walker-scope.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("a.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** The first node of the tree for which `pick` answers true. */
function find(root: ts.Node, pick: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (pick(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (found === undefined) throw new Error("fixture node not found");
  return found;
}

const declaratorNamed = (root: ts.Node, name: string): ts.Node =>
  find(root, (n) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name);

describe("sameWalkerScope", () => {
  it("compares scopes by length and element, outermost first", () => {
    expect(sameWalkerScope(["A", "run"], ["A", "run"])).toBe(true);
    expect(sameWalkerScope(["A", "run"], ["A"])).toBe(false);
    expect(sameWalkerScope(["A", "run"], ["A", "stop"])).toBe(false);
  });
});

describe("isFunctionValuedInitializer", () => {
  it("accepts arrow and function expressions only", () => {
    const sf = parse("const a = () => 1; const b = function () {}; const c = 1;");
    const init = (name: string): ts.Expression | undefined =>
      (declaratorNamed(sf, name) as ts.VariableDeclaration).initializer;
    expect(isFunctionValuedInitializer(init("a"))).toBe(true);
    expect(isFunctionValuedInitializer(init("b"))).toBe(true);
    expect(isFunctionValuedInitializer(init("c"))).toBe(false);
    expect(isFunctionValuedInitializer(undefined)).toBe(false);
  });
});

describe("walkerScopeOf", () => {
  it("names every enclosing node the walker names, outermost first", () => {
    const sf = parse(
      [
        "class Widget {",
        "  render() {",
        "    function format() { const inner = 1; }",
        "  }",
        "  get size() { const g = 1; return g; }",
        "  set size(v) { const s = 1; }",
        "  constructor() { const c = 1; }",
        "  #secret() { const p = 1; }",
        "  handler = () => { const h = 1; };",
        "  plain = 5;",
        "}",
        "const Expr = class { m() { const e = 1; } };",
        "const Named = class Inner { m() { const n = 1; } };",
        "const holder = { Slot: class { m() { const q = 1; } } };",
        "const wrapped = (class { m() { const w = 1; } }) as unknown;",
        "const ns = { run() { const r = 1; } };",
        "const fn = function () { const f = 1; };",
      ].join("\n"),
    );
    expect(walkerScopeOf(declaratorNamed(sf, "inner"))).toEqual(["Widget", "render", "format"]);
    expect(walkerScopeOf(declaratorNamed(sf, "g"))).toEqual(["Widget", "size"]);
    expect(walkerScopeOf(declaratorNamed(sf, "s"))).toEqual(["Widget", "size"]);
    expect(walkerScopeOf(declaratorNamed(sf, "c"))).toEqual(["Widget", "constructor"]);
    expect(walkerScopeOf(declaratorNamed(sf, "p"))).toEqual(["Widget", "#secret"]);
    expect(walkerScopeOf(declaratorNamed(sf, "h"))).toEqual(["Widget", "handler"]);
    expect(walkerScopeOf(declaratorNamed(sf, "e"))).toEqual(["Expr", "m"]);
    expect(walkerScopeOf(declaratorNamed(sf, "n"))).toEqual(["Inner", "m"]);
    expect(walkerScopeOf(declaratorNamed(sf, "q"))).toEqual(["Slot", "m"]);
    expect(walkerScopeOf(declaratorNamed(sf, "w"))).toEqual(["wrapped", "m"]);
    expect(walkerScopeOf(declaratorNamed(sf, "r"))).toEqual(["ns", "run"]);
    expect(walkerScopeOf(declaratorNamed(sf, "f"))).toEqual(["fn"]);
  });

  it("answers null for a computed member name, and skips an unnamed generator or anonymous class", () => {
    const sf = parse(
      [
        "class K { [Symbol.iterator]() { const z = 1; } }",
        "function* gen() { const y = 1; }",
        "export default class { m() { const x = 1; } }",
        "const bag = { value: 1 }; const top = 1;",
      ].join("\n"),
    );
    expect(walkerScopeOf(declaratorNamed(sf, "z"))).toBeNull();
    expect(walkerScopeOf(declaratorNamed(sf, "y"))).toEqual([]);
    expect(walkerScopeOf(declaratorNamed(sf, "x"))).toEqual(["m"]);
    expect(walkerScopeOf(declaratorNamed(sf, "top"))).toEqual([]);
  });
});

describe("pinFunctionByWalkerScope", () => {
  const def = (symbolId: string, scope: string[], relPath = "a.ts"): SymbolDefinition => ({
    symbolId,
    fqName: symbolId,
    shortName: "send",
    relPath,
    scope,
  });

  const ctxWith = (defs: SymbolDefinition[]): CallContext => {
    const table = new InMemoryGlobalSymbolTable();
    const byFile = new Map<string, SymbolDefinition[]>();
    for (const d of defs) byFile.set(d.relPath, [...(byFile.get(d.relPath) ?? []), d]);
    for (const [file, rows] of byFile) table.upsertFile(file, rows);
    return { callerFile: "b.ts", callerScope: [], imports: [], symbolTable: table };
  };

  const code = [
    "function outerA() { function send() {} }",
    "function outerB() { const send = () => 1; }",
    "function* gen() {}",
    "const top = function () {};",
    "const tuple = 1;",
  ].join("\n");

  it("pins the one row whose short name and walker scope both match", () => {
    const sf = parse(code);
    const ctx = ctxWith([def("outerA.send", ["outerA"]), def("outerB.send", ["outerB"])]);
    const inA = find(sf, (n) => ts.isFunctionDeclaration(n) && n.name?.text === "send");
    const inB = find(sf, (n) => ts.isArrowFunction(n));
    expect(pinFunctionByWalkerScope(inA, "a.ts", ctx)).toBe("outerA.send");
    expect(pinFunctionByWalkerScope(inB, "a.ts", ctx)).toBe("outerB.send");
    expect(pinFunctionByWalkerScope(declaratorNamed(sf, "send"), "a.ts", ctx)).toBe("outerB.send");
  });

  it("declines a row outside the target file, an ambiguous scope, and a declaration the walker names differently", () => {
    const sf = parse(code);
    const inA = find(sf, (n) => ts.isFunctionDeclaration(n) && n.name?.text === "send");
    expect(pinFunctionByWalkerScope(inA, "other.ts", ctxWith([def("outerA.send", ["outerA"])]))).toBeNull();
    const twice = ctxWith([def("outerA.send", ["outerA"]), def("outerA.send#2", ["outerA"])]);
    expect(pinFunctionByWalkerScope(inA, "a.ts", twice)).toBeNull();
    const ctx = ctxWith([def("outerA.send", ["outerA"])]);
    const generator = find(sf, (n) => ts.isFunctionDeclaration(n) && n.asteriskToken !== undefined);
    expect(pinFunctionByWalkerScope(generator, "a.ts", ctx)).toBeNull();
    expect(pinFunctionByWalkerScope(declaratorNamed(sf, "tuple"), "a.ts", ctx)).toBeNull();
    // A top-level function-valued declarator has an empty walker scope: nothing to disambiguate.
    expect(pinFunctionByWalkerScope(declaratorNamed(sf, "top"), "a.ts", ctx)).toBeNull();
    const detached = find(sf, (n) => ts.isFunctionExpression(n));
    expect(pinFunctionByWalkerScope(detached, "a.ts", ctx)).toBeNull();
    const bare = parse("foo(function () {});");
    expect(
      pinFunctionByWalkerScope(
        find(bare, (n) => ts.isFunctionExpression(n)),
        "a.ts",
        ctx,
      ),
    ).toBeNull();
  });
});
