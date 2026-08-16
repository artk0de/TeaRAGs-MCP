/**
 * The class-property function gate (bd tea-rags-mcp-5ldqu).
 *
 * Same reason `const-bound-function.test.ts` exists next door: a shared gate
 * that decides which physical AST nodes become addressable symbols is tested
 * directly, so every caller is pinned by ONE set of examples rather than by
 * whichever caller happened to get a test.
 *
 * Two halves are asserted here and nowhere else:
 *   - the SHAPE half — which fields carry a callable VALUE (as opposed to a
 *     type, a datum, or a call's return);
 *   - the KIND half — `static` makes it class-level, everything else instance,
 *     which is what decides `.` vs `#` downstream.
 */

import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { AstNode } from "../../../../src/core/contracts/types/ast.js";
import { classPropertyFunction } from "../../../../src/core/infra/symbolid/class-property-function.js";
import { materializeTree } from "../../../../src/core/infra/materialize.js";

function parse(src: string): AstNode {
  const parser = new Parser();
  parser.setLanguage(TsLang.typescript as unknown as Parser.Language);
  return materializeTree(parser.parse(src).rootNode, src);
}

/** Every node of `type`, in source order. */
function nodesOfType(root: AstNode, type: string): AstNode[] {
  const out: AstNode[] = [];
  const walk = (n: AstNode): void => {
    if (n.type === type) out.push(n);
    for (const child of n.children) walk(child);
  };
  walk(root);
  return out;
}

/** What the gate makes of every class field in `src`, in source order. */
function gateOf(src: string): (string | null)[] {
  return nodesOfType(parse(src), "public_field_definition").map((field) => {
    const recognized = classPropertyFunction(field);
    return recognized === null ? null : `${recognized.methodKind}:${recognized.name}`;
  });
}

/** One class field, wrapped in the minimum class that parses. */
const inClass = (field: string): string => `class Fetcher {\n  ${field}\n}\n`;

describe("classPropertyFunction — the shape half", () => {
  it("recognises the arrow-bound property, the shape the bead is for", () => {
    // `class AdminentrypointPostFetcher { request = async () => {…} }` — a
    // generated-client idiom, and the reason `fetcher.request()` could not be
    // pinned: the checker knew the declaration, cg_symbols had no row for it.
    expect(gateOf(inClass("request = async (url: string) => fetch(url);"))).toEqual(["instance:request"]);
  });

  it("recognises a property bound to a function expression", () => {
    expect(gateOf(inClass("handle = function (value: number) { return value; };"))).toEqual(["instance:handle"]);
  });

  it("recognises a property bound to a generator function", () => {
    expect(gateOf(inClass("walk = function* () { yield 1; };"))).toEqual(["instance:walk"]);
  });

  it("reads past leading modifiers to the name and value", () => {
    // `private` is an `accessibility_modifier`, `readonly` an unnamed keyword —
    // both sit BEFORE the name, so a gate that reads positionally rather than by
    // field would name the modifier.
    expect(gateOf(inClass("private readonly send = () => 1;"))).toEqual(["instance:send"]);
  });

  it("reads through a type annotation to the initializer", () => {
    // `arrowTyped: (a: number) => number = (a) => a` carries BOTH a
    // `type_annotation` and a value; the value is what declares the function.
    expect(gateOf(inClass("apply: (a: number) => number = (a) => a;"))).toEqual(["instance:apply"]);
  });

  it("declines a data-only property", () => {
    expect(gateOf(inClass("retries = 3;"))).toEqual([null]);
  });

  it("declines a property bound to a CALL, which declares nothing here", () => {
    // Same reason `functionValuedDeclaratorName` declines `const t =
    // useTranslation()`: the function is declared wherever the callee is, and
    // naming this site would fabricate a declaration.
    expect(gateOf(inClass("translate = useTranslation('ns');"))).toEqual([null]);
  });

  it("declines a value-less declaration, however function-shaped its TYPE is", () => {
    // `declare later: () => void` and `abstract shape: () => void` are the
    // oracle's `FunctionType` class: a type, not a value. Nothing is declared.
    expect(gateOf(inClass("declare later: () => void;"))).toEqual([null]);
    expect(gateOf("abstract class Fetcher {\n  abstract shape: () => void;\n}\n")).toEqual([null]);
  });

  it("declines a COMPUTED property name — there is no static name to address", () => {
    expect(gateOf(inClass('["computed"] = () => 3;'))).toEqual([null]);
  });

  it("declines a #private field, which no cross-file call can reach", () => {
    // Out of scope deliberately, not by omission: `#secret` is unreachable from
    // outside the class, so naming it buys no edge the enclosing chunk lacks,
    // while `##` ids would need the resolver to speak a shape it does not.
    expect(gateOf(inClass("#secret = () => 2;"))).toEqual([null]);
  });

  it("declines every node that is not a class field", () => {
    const root = parse("const handler = () => 1;\nclass F { m() { return 1; } }\n");
    for (const type of ["variable_declarator", "method_definition", "class_declaration", "program"]) {
      for (const node of nodesOfType(root, type)) expect(classPropertyFunction(node)).toBeNull();
    }
  });
});

describe("classPropertyFunction — the kind half", () => {
  it("marks a plain arrow property as instance-bound", () => {
    expect(gateOf(inClass("request = () => 1;"))).toEqual(["instance:request"]);
  });

  it("marks a `static` arrow property as class-level", () => {
    expect(gateOf(inClass("static build = () => new Fetcher();"))).toEqual(["static:build"]);
  });

  it("does NOT mistake a property NAMED `static` for a static one", () => {
    // `class X { static = () => 1 }` parses as a `property_identifier` whose
    // TEXT is "static" and carries no modifier child. A kind test that matches
    // on child text rather than on an unnamed keyword node reads it backwards,
    // and the id flips from `Fetcher#static` to `Fetcher.static`.
    expect(gateOf(inClass("static = () => 1;"))).toEqual(["instance:static"]);
  });
});
