/**
 * Guard / rejection paths of the JavaScript chunker symbol resolver. Companion
 * to `symbol-resolver.test.ts` (happy paths): every case here feeds a realistic
 * source snippet and asserts the resolver agrees with codegraph `jsNameOf`
 * (which emits nothing for these shapes) or resolves via the documented
 * fallbacks.
 */

import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import {
  extractJsAssignmentSymbol,
  extractJsForEachDispatchSymbols,
  extractJsNestedDefinePropertyThisSymbols,
} from "../../../../../../src/core/domains/language/javascript/chunking/symbol-resolver.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(JsLang);
  return parser.parse(src);
}

/** First expression_statement (at any depth) whose text starts with `prefix`. */
function stmt(src: string, prefix: string): Parser.SyntaxNode {
  let found: Parser.SyntaxNode | null = null;
  const visit = (n: Parser.SyntaxNode): void => {
    if (found) return;
    if (n.type === "expression_statement" && n.text.startsWith(prefix)) {
      found = n;
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(parse(src).rootNode);
  if (!found) throw new Error(`No statement starting with ${prefix} in:\n${src}`);
  return found;
}

function decl(src: string): Parser.SyntaxNode {
  const node = parse(src).rootNode.namedChildren.find(
    (c) => c.type === "lexical_declaration" || c.type === "variable_declaration",
  );
  if (!node) throw new Error("no declaration");
  return node;
}

describe("extractJsAssignmentSymbol — declarations and non-function values", () => {
  it("returns null for a declaration without an initializer", () => {
    expect(extractJsAssignmentSymbol(decl("var x;\n"))).toBeNull();
  });

  it("returns null when the assigned value is not function-valued", () => {
    expect(extractJsAssignmentSymbol(stmt("obj.count = 5;\n", "obj"))).toBeNull();
  });

  it("returns null for a bare-identifier reassignment of a function", () => {
    expect(extractJsAssignmentSymbol(stmt("handler = function () {};\n", "handler"))).toBeNull();
  });

  it("returns null for a private-field LHS (`other.#x = fn`)", () => {
    const src = "class A {\n  m(other) {\n    other.#x = function () {};\n  }\n}\n";
    expect(extractJsAssignmentSymbol(stmt(src, "other"))).toBeNull();
  });

  it("returns null for a non-identifier receiver (`this.run = fn`)", () => {
    expect(extractJsAssignmentSymbol(stmt("this.run = function () {};\n", "this"))).toBeNull();
  });

  it("returns null for an expression statement that is neither an assignment nor a call", () => {
    expect(extractJsAssignmentSymbol(stmt("value;\n", "value"))).toBeNull();
  });
});

describe("extractJsAssignmentSymbol — getter helper rejection paths", () => {
  it("resolves a template-literal property name without interpolation", () => {
    const s = stmt("Object.defineProperty(app, `router`, { get: function () {} });\n", "Object");
    expect(extractJsAssignmentSymbol(s)).toEqual({ symbolId: "app.router", name: "app.router" });
  });

  it("rejects a template-literal property name with interpolation", () => {
    const name = ["r", "{n}"].join("$");
    const s = stmt(`Object.defineProperty(app, \`${name}\`, { get: function () {} });\n`, "Object");
    expect(extractJsAssignmentSymbol(s)).toBeNull();
  });

  it("rejects a non-object descriptor", () => {
    expect(extractJsAssignmentSymbol(stmt("Object.defineProperty(app, 'x', descriptor);\n", "Object"))).toBeNull();
  });

  it("ignores shorthand methods in the descriptor and finds a later `get:` pair", () => {
    const s = stmt("Object.defineProperty(app, 'x', { toString() {}, get: function () {} });\n", "Object");
    expect(extractJsAssignmentSymbol(s)).toEqual({ symbolId: "app.x", name: "app.x" });
  });

  it("rejects a descriptor with only data members", () => {
    expect(extractJsAssignmentSymbol(stmt("Object.defineProperty(app, 'x', { value: 1 });\n", "Object"))).toBeNull();
  });

  it("renders a member chain rooted at `this` verbatim", () => {
    const s = stmt("Object.defineProperty(this.proto, 'x', { get: function () {} });\n", "Object");
    expect(extractJsAssignmentSymbol(s)).toEqual({ symbolId: "this.proto.x", name: "this.proto.x" });
  });

  it("rejects receivers that are call results or chains rooted at a call", () => {
    expect(
      extractJsAssignmentSymbol(stmt("Object.defineProperty(make(), 'x', { get: function () {} });\n", "Object")),
    ).toBeNull();
    expect(
      extractJsAssignmentSymbol(stmt("Object.defineProperty(make().inner, 'x', { get: function () {} });\n", "Object")),
    ).toBeNull();
  });

  it("rejects a member-chain receiver with a private property", () => {
    const src = "class A {\n  m() {\n    Object.defineProperty(this.#p, 'x', { get: function () {} });\n  }\n}\n";
    expect(extractJsAssignmentSymbol(stmt(src, "Object"))).toBeNull();
  });

  it("rejects a free-floating `this` receiver", () => {
    const s = stmt("Object.defineProperty(this, 'x', { get: function () {} });\n", "Object");
    expect(extractJsAssignmentSymbol(s)).toBeNull();
  });

  it("rejects `this` inside a plain function declaration (no receiver-rooted assignment)", () => {
    const src = "function init() {\n  Object.defineProperty(this, 'x', { get: function () {} });\n}\n";
    expect(extractJsAssignmentSymbol(stmt(src, "Object"))).toBeNull();
  });

  it("resolves `this` through an enclosing `app.init = function` assignment", () => {
    const src = "app.init = function () {\n  Object.defineProperty(this, 'router', { get: function () {} });\n};\n";
    expect(extractJsAssignmentSymbol(stmt(src, "Object"))).toEqual({ symbolId: "app.router", name: "app.router" });
  });

  it("rejects defineGetter with a non-literal name, a non-function value, or an unresolvable receiver", () => {
    expect(extractJsAssignmentSymbol(stmt("defineGetter(req, name, function () {});\n", "defineGetter"))).toBeNull();
    expect(extractJsAssignmentSymbol(stmt("defineGetter(req, 'a', 5);\n", "defineGetter"))).toBeNull();
    expect(extractJsAssignmentSymbol(stmt("defineGetter(this, 'b', function () {});\n", "defineGetter"))).toBeNull();
  });

  it("ignores unrelated three-argument calls", () => {
    expect(extractJsAssignmentSymbol(stmt("configure(a, 'b', function () {});\n", "configure"))).toBeNull();
  });
});

describe("extractJsNestedDefinePropertyThisSymbols — guards and rebinding", () => {
  it("returns [] for a call statement without an assignment", () => {
    expect(extractJsNestedDefinePropertyThisSymbols(stmt("run();\n", "run"))).toEqual([]);
  });

  it("returns [] when the outer receiver is not renderable (`make().init = function`)", () => {
    const s = stmt("make().init = function () {\n  defineGetter(this, 'x', function () {});\n};\n", "make");
    expect(extractJsNestedDefinePropertyThisSymbols(s)).toEqual([]);
  });

  it("ignores nested installs whose descriptor is not an object literal", () => {
    const s = stmt("app.init = function () {\n  Object.defineProperty(this, 'x', descriptor);\n};\n", "app");
    expect(extractJsNestedDefinePropertyThisSymbols(s)).toEqual([]);
  });

  it("ignores unrelated three-argument calls taking `this` first", () => {
    const s = stmt("app.init = function () {\n  configure(this, 'x', function () {});\n};\n", "app");
    expect(extractJsNestedDefinePropertyThisSymbols(s)).toEqual([]);
  });

  it("collects defineGetter installs and skips those inside a deeper non-arrow function", () => {
    const src =
      "app.init = function () {\n" +
      "  defineGetter(this, 'a', function () {});\n" +
      "  function inner() {\n    defineGetter(this, 'b', function () {});\n  }\n" +
      "};\n";
    expect(extractJsNestedDefinePropertyThisSymbols(stmt(src, "app")).map((s) => s.symbolId)).toEqual(["app.a"]);
  });
});

describe("extractJsForEachDispatchSymbols — signal heuristics and guards", () => {
  const verbs = ["get", "post", "put", "delete", "head", "options", "patch", "connect", "trace"];

  it("accepts a reversed `'get' === m` comparison as the verb signal", () => {
    const src = "items.forEach(function (m) {\n  if ('get' === m) {}\n  app[m] = function () {};\n});\n";
    expect(extractJsForEachDispatchSymbols(stmt(src, "items"))?.map((s) => s.symbolId)).toEqual(
      verbs.map((v) => `app.${v}`),
    );
  });

  it("rejects a numeric comparison on the parameter when no other signal exists", () => {
    const src = "items.forEach(function (m) {\n  if (m === 5) {}\n  app[m] = function () {};\n});\n";
    expect(extractJsForEachDispatchSymbols(stmt(src, "items"))).toBeNull();
  });

  it("accepts `methods` required from a local util module", () => {
    const src =
      "var methods = require('./utils').methods;\n" +
      "methods.forEach(function (m) {\n  if (m === 5) {}\n  app[m] = function () {};\n});\n";
    expect(extractJsForEachDispatchSymbols(stmt(src, "methods.forEach"))).toHaveLength(9);
  });

  it("accepts `methods` required from the npm package", () => {
    const src = "var methods = require('methods');\nmethods.forEach(function (m) {\n  app[m] = function () {};\n});\n";
    expect(extractJsForEachDispatchSymbols(stmt(src, "methods.forEach"))).toHaveLength(9);
  });

  it("rejects `methods` required from a non-util local module", () => {
    const src = "var methods = require('./verbs');\nmethods.forEach(function (m) {\n  app[m] = function () {};\n});\n";
    expect(extractJsForEachDispatchSymbols(stmt(src, "methods.forEach"))).toBeNull();
  });

  it("rejects a single-parameter arrow callback (no parenthesised parameter list)", () => {
    const src = "methods.forEach(m => {\n  app[m] = function () {};\n});\n";
    expect(extractJsForEachDispatchSymbols(stmt(src, "methods.forEach"))).toBeNull();
  });

  it("rejects a dispatch whose object is not a plain identifier", () => {
    const src = "items.forEach(function (m) {\n  if (m === 'get') {}\n  this.routes[m] = function () {};\n});\n";
    expect(extractJsForEachDispatchSymbols(stmt(src, "items"))).toBeNull();
  });

  it("returns null for an expression statement that is not a call", () => {
    expect(extractJsForEachDispatchSymbols(stmt("value;\n", "value"))).toBeNull();
  });
});
