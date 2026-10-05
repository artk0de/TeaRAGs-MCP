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
  p.setLanguage(JsLang);
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

/** Run the hook over the first top-level node of `type`, passing the source
 * text and a stable file path as the contract's second and third arguments. */
const filterTop = (src: string, type: string): boolean | undefined => filter(topLevelOfType(src, type), src, "spec.js");

describe("jsAssignmentFilterHook.filterNode — expression_statement", () => {
  it("keeps `obj.method = function () {}`", () => {
    expect(filterTop("obj.method = function () {};\n", "expression_statement")).toBe(true);
  });

  it("keeps `Foo.prototype.bar = () => {}`", () => {
    expect(filterTop("Foo.prototype.bar = () => {};\n", "expression_statement")).toBe(true);
  });

  it("keeps `Object.defineProperty(obj, 'name', { get: fn })` (descriptor shape only)", () => {
    expect(filterTop("Object.defineProperty(obj, 'name', { get: function () {} });\n", "expression_statement")).toBe(
      true,
    );
  });

  it("keeps `defineGetter(obj, 'name', fn)`", () => {
    expect(filterTop("defineGetter(obj, 'name', function () {});\n", "expression_statement")).toBe(true);
  });

  it("keeps `methods.forEach(method => app[method] = fn)` (permissive — resolver decides later)", () => {
    expect(
      filterTop("methods.forEach(function (method) { app[method] = function () {}; });\n", "expression_statement"),
    ).toBe(true);
  });

  it("drops `x = 42` (non-function RHS)", () => {
    expect(filterTop("x = 42;\n", "expression_statement")).toBe(false);
  });

  it("drops bare call `foo();` (not a getter helper or forEach dispatch)", () => {
    expect(filterTop("foo();\n", "expression_statement")).toBe(false);
  });

  it("drops `import.meta.url` (no assignment, no recognised call)", () => {
    expect(filterTop("import.meta.url;\n", "expression_statement")).toBe(false);
  });

  it("drops `Object.defineProperty(obj, 'name', notAnObjectLiteral)` (descriptor must be an object literal)", () => {
    expect(filterTop("Object.defineProperty(obj, 'name', getDescriptor());\n", "expression_statement")).toBe(false);
  });

  it("drops `defineGetter(obj, 'name', notAFunction)`", () => {
    expect(filterTop("defineGetter(obj, 'name', 42);\n", "expression_statement")).toBe(false);
  });

  it("drops `foo.bar(args)` (not a recognised helper)", () => {
    // Not defineProperty, not defineGetter, has 3 args but member.prop != defineProperty.
    expect(filterTop("util.other(a, b, c);\n", "expression_statement")).toBe(false);
  });

  it("drops `forEach(fn)` (forEach called without member-expression receiver)", () => {
    expect(filterTop("forEach(function (x) { obj[x] = function () {}; });\n", "expression_statement")).toBe(false);
  });
});

describe("jsAssignmentFilterHook.filterNode — declarations", () => {
  it("keeps `const Foo = function () {}`", () => {
    expect(filterTop("const Foo = function () {};\n", "lexical_declaration")).toBe(true);
  });

  it("keeps `const Foo = () => {}` (arrow form)", () => {
    expect(filterTop("const Foo = () => {};\n", "lexical_declaration")).toBe(true);
  });

  it("keeps multi-declarator where ANY value is function-valued", () => {
    expect(filterTop("const x = 1, Foo = function () {};\n", "lexical_declaration")).toBe(true);
  });

  it("drops `const x = 1` (no function-valued declarator)", () => {
    expect(filterTop("const x = 1;\n", "lexical_declaration")).toBe(false);
  });

  it("drops `var x;` (declarator without value)", () => {
    expect(filterTop("var x;\n", "variable_declaration")).toBe(false);
  });
});

describe("jsAssignmentFilterHook.filterNode — unrelated node types", () => {
  it("returns undefined for an unrelated node type (e.g. function_declaration)", () => {
    expect(filterTop("function foo () {}\n", "function_declaration")).toBeUndefined();
  });

  it("returns undefined for a class declaration", () => {
    expect(filterTop("class Foo {}\n", "class_declaration")).toBeUndefined();
  });
});
