/**
 * JavaScript assignment-filter hook tests — directly exercise the
 * `filterNode` predicate that narrows which expression_statement /
 * lexical_declaration / variable_declaration nodes the chunker treats
 * as chunkable. See `src/core/domains/language/javascript/chunking/assignment-filter.ts`.
 *
 * Invariant: only nodes that CARRY a function value survive the
 * filter. This avoids chunks for `const x = 1` / `foo()` / bare
 * literals — they have no symbolId and would clutter the index.
 *
 * Tests cover both positive (`true`) and negative (`false`) returns
 * for every recognised shape, plus the `undefined` no-opinion return
 * for unrelated node types.
 */

import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import { jsAssignmentFilterHook } from "../../../../../../src/core/domains/language/javascript/chunking/assignment-filter.js";

function parse(src: string): Parser.Tree {
  const p = new Parser();
  p.setLanguage(JsLang as unknown as Parser.Language);
  return p.parse(src);
}

function topLevelOfType(src: string, type: string): Parser.SyntaxNode {
  const tree = parse(src);
  const node = tree.rootNode.namedChildren.find((c) => c.type === type);
  if (!node) throw new Error(`No ${type} found in:\n${src}`);
  return node;
}

const filter = jsAssignmentFilterHook.filterNode;
if (!filter) throw new Error("jsAssignmentFilterHook must define filterNode");

describe("jsAssignmentFilterHook.filterNode — expression_statement", () => {
  it("keeps `obj.method = function () {}`", () => {
    const node = topLevelOfType("obj.method = function () {};\n", "expression_statement");
    expect(filter(node)).toBe(true);
  });

  it("keeps `Foo.prototype.bar = () => {}`", () => {
    const node = topLevelOfType("Foo.prototype.bar = () => {};\n", "expression_statement");
    expect(filter(node)).toBe(true);
  });

  it("keeps `Object.defineProperty(obj, 'name', { get: fn })` (descriptor shape only)", () => {
    const node = topLevelOfType(
      "Object.defineProperty(obj, 'name', { get: function () {} });\n",
      "expression_statement",
    );
    expect(filter(node)).toBe(true);
  });

  it("keeps `defineGetter(obj, 'name', fn)`", () => {
    const node = topLevelOfType("defineGetter(obj, 'name', function () {});\n", "expression_statement");
    expect(filter(node)).toBe(true);
  });

  it("keeps `methods.forEach(method => app[method] = fn)` (permissive — resolver decides later)", () => {
    const node = topLevelOfType(
      "methods.forEach(function (method) { app[method] = function () {}; });\n",
      "expression_statement",
    );
    expect(filter(node)).toBe(true);
  });

  it("drops `x = 42` (non-function RHS)", () => {
    const node = topLevelOfType("x = 42;\n", "expression_statement");
    expect(filter(node)).toBe(false);
  });

  it("drops bare call `foo();` (not a getter helper or forEach dispatch)", () => {
    const node = topLevelOfType("foo();\n", "expression_statement");
    expect(filter(node)).toBe(false);
  });

  it("drops `import.meta.url` (no assignment, no recognised call)", () => {
    const node = topLevelOfType("import.meta.url;\n", "expression_statement");
    expect(filter(node)).toBe(false);
  });

  it("drops `Object.defineProperty(obj, 'name', notAnObjectLiteral)` (descriptor must be an object literal)", () => {
    const node = topLevelOfType("Object.defineProperty(obj, 'name', getDescriptor());\n", "expression_statement");
    expect(filter(node)).toBe(false);
  });

  it("drops `defineGetter(obj, 'name', notAFunction)`", () => {
    const node = topLevelOfType("defineGetter(obj, 'name', 42);\n", "expression_statement");
    expect(filter(node)).toBe(false);
  });

  it("drops `foo.bar(args)` (not a recognised helper)", () => {
    // Not defineProperty, not defineGetter, has 3 args but member.prop != defineProperty.
    const node = topLevelOfType("util.other(a, b, c);\n", "expression_statement");
    expect(filter(node)).toBe(false);
  });

  it("drops `forEach(fn)` (forEach called without member-expression receiver)", () => {
    const node = topLevelOfType("forEach(function (x) { obj[x] = function () {}; });\n", "expression_statement");
    expect(filter(node)).toBe(false);
  });
});

describe("jsAssignmentFilterHook.filterNode — declarations", () => {
  it("keeps `const Foo = function () {}`", () => {
    const node = topLevelOfType("const Foo = function () {};\n", "lexical_declaration");
    expect(filter(node)).toBe(true);
  });

  it("keeps `const Foo = () => {}` (arrow form)", () => {
    const node = topLevelOfType("const Foo = () => {};\n", "lexical_declaration");
    expect(filter(node)).toBe(true);
  });

  it("keeps multi-declarator where ANY value is function-valued", () => {
    const node = topLevelOfType("const x = 1, Foo = function () {};\n", "lexical_declaration");
    expect(filter(node)).toBe(true);
  });

  it("drops `const x = 1` (no function-valued declarator)", () => {
    const node = topLevelOfType("const x = 1;\n", "lexical_declaration");
    expect(filter(node)).toBe(false);
  });

  it("drops `var x;` (declarator without value)", () => {
    const node = topLevelOfType("var x;\n", "variable_declaration");
    expect(filter(node)).toBe(false);
  });
});

describe("jsAssignmentFilterHook.filterNode — unrelated node types", () => {
  it("returns undefined for an unrelated node type (e.g. function_declaration)", () => {
    const node = topLevelOfType("function foo () {}\n", "function_declaration");
    expect(filter(node)).toBeUndefined();
  });

  it("returns undefined for a class declaration", () => {
    const node = topLevelOfType("class Foo {}\n", "class_declaration");
    expect(filter(node)).toBeUndefined();
  });
});
