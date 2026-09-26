/**
 * TypeScript symbol kind (bd tea-rags-mcp-vi0wx) — the declaration kind each
 * chunk the walker emits carries on `ChunkExtraction.symbolKind`, read through
 * the seam production runs: materialize, `collectSymbols(tree, walker.nameOf, …)`,
 * then the COMPOSED `walker.walk`, so the join against real chunk ids is what is
 * asserted.
 *
 * Interfaces, enums, type aliases and plain-valued constants are not symbols
 * today (`tsNameOf` names none of them), so no chunk exists to tag; the mapping
 * still answers for them, pinned by the `symbolKindOf` unit cases.
 */
import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";
import { symbolKindOf } from "../../../../../../src/core/domains/language/typescript/walker/symbol-kind.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

const grammar = (TsLang as unknown as { typescript: unknown }).typescript;

function symbolKinds(src: string): Record<string, string | undefined> {
  const language = new TypeScriptLanguage();
  const parser = new Parser();
  parser.setLanguage(grammar as Parser.Language);
  const tree = { rootNode: materializeTree(parser.parse(src).rootNode, src) };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  const extraction = language.walker.walk({ tree, code: src, relPath: "a.ts", language: "typescript", chunks });
  const out: Record<string, string | undefined> = {};
  for (const chunk of extraction.chunks) out[chunk.symbolId] = chunk.symbolKind;
  return out;
}

describe("TypeScript walker — symbol kind", () => {
  it("tags classes, functions and methods", () => {
    const src = [
      "export class A {",
      "  constructor() {}",
      "  run() {}",
      "  static make() {}",
      "  handle = () => 1;",
      "}",
      "abstract class B {}",
      "function f() {}",
      "",
    ].join("\n");
    expect(symbolKinds(src)).toEqual({
      A: "class",
      "A#constructor": "method",
      "A#run": "method",
      "A.make": "method",
      "A#handle": "method",
      B: "class",
      "B#constructor": "method",
      f: "function",
    });
  });

  it("tags a named function-valued declarator as a function, not a constant", () => {
    const src = ["export const f = () => {};", "const g = function () {};", ""].join("\n");
    expect(symbolKinds(src)).toEqual({ f: "function", g: "function" });
  });

  it("tags a class expression as a class and a const-object namespace as a module", () => {
    const src = ["export const Recorder = class { record() {} };", "export const Grouper = { group() {} };", ""].join(
      "\n",
    );
    expect(symbolKinds(src)).toEqual({
      Recorder: "class",
      "Recorder#record": "method",
      "Recorder#constructor": "method",
      Grouper: "module",
      "Grouper.group": "method",
    });
  });

  it("tags a wrapper-exported component as a function", () => {
    const src = [
      'import { memo } from "react";',
      "const PanelBase = () => null;",
      "export const Panel = memo(PanelBase);",
      "",
    ].join("\n");
    expect(symbolKinds(src)).toMatchObject({ PanelBase: "function", Panel: "function" });
  });

  it("emits no chunk for an interface, enum, type alias or plain constant — none is a symbol yet", () => {
    const src = ["interface I {}", "enum E { A }", "type T = { a: number };", "export const MAX = 3;", ""].join("\n");
    expect(symbolKinds(src)).toEqual({});
  });
});

describe("symbolKindOf", () => {
  const top = { atTopLevel: true };
  it.each([
    ["class_declaration", top, "class"],
    ["abstract_class_declaration", top, "class"],
    ["class", top, "class"],
    ["interface_declaration", top, "interface"],
    ["enum_declaration", top, "enum"],
    ["type_alias_declaration", top, "type_alias"],
    ["function_declaration", top, "function"],
    ["generator_function_declaration", top, "function"],
    ["method_definition", top, "method"],
    ["public_field_definition", top, "method"],
    ["variable_declarator", { atTopLevel: true, valueType: "arrow_function" }, "function"],
    ["variable_declarator", { atTopLevel: false, valueType: "function_expression" }, "function"],
    ["variable_declarator", { atTopLevel: true, valueType: "call_expression" }, "function"],
    ["variable_declarator", { atTopLevel: true, valueType: "object" }, "module"],
    ["variable_declarator", { atTopLevel: true, valueType: "number" }, "constant"],
    ["assignment_expression", { atTopLevel: true, memberTarget: true }, "method"],
    ["assignment_expression", { atTopLevel: true, memberTarget: false }, "function"],
    ["call_expression", { atTopLevel: true, memberTarget: true }, "method"],
  ] as const)("%s %j → %s", (nodeType, context, kind) => {
    expect(symbolKindOf(nodeType, context)).toBe(kind);
  });

  it("answers nothing for a nested plain-valued declarator or an unknown node", () => {
    expect(symbolKindOf("variable_declarator", { atTopLevel: false, valueType: "number" })).toBeUndefined();
    expect(symbolKindOf("identifier", top)).toBeUndefined();
  });
});
