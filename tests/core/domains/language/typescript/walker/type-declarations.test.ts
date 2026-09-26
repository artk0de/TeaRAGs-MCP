/**
 * TypeScript type and constant declarations (bd tea-rags-mcp-vi0wx, spec §1b) —
 * `FileExtraction.typeDeclarations`, read through the seam production runs:
 * materialize, `collectSymbols(tree, walker.nameOf, …)`, then the COMPOSED
 * `walker.walk`.
 *
 * One fact per class, interface, type alias, enum, namespace / module, and
 * module-level `const` that is not function-valued — whether or not it is a
 * chunk. A function-valued `const` is a function symbol already, and a local
 * inside a function or a class body is not file-level, so neither is a fact.
 */
import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";
import { extractFromTypescriptFile } from "../../../../../../src/core/domains/language/typescript/walker/walker.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

const grammar = (TsLang as unknown as { typescript: unknown }).typescript;

function extract(src: string): { composed: FileExtraction; native: FileExtraction } {
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
  const input = { tree, code: src, relPath: "a.ts", language: "typescript", chunks };
  return { composed: language.walker.walk(input), native: extractFromTypescriptFile(input) };
}

function typeDeclarationsOf(src: string): FileExtraction["typeDeclarations"] {
  return extract(src).composed.typeDeclarations;
}

describe("TypeScript walker — type declarations", () => {
  it("emits classes, interfaces, type aliases and enums with their supertypes in clause order", () => {
    const src = [
      "export class Svc extends Base<T> implements Runner, ns.Named<X> {}",
      "abstract class Shape {}",
      "export interface Runner extends Named, ns.Tagged<Y> {}",
      "export type Id = string;",
      "enum Color { Red }",
      "export const enum Mode { A }",
      "export default class {}",
      "",
    ].join("\n");

    expect(typeDeclarationsOf(src)).toEqual([
      { typeId: "Svc", symbolKind: "class", line: 1, reopens: false, conforms: ["Base", "Runner", "ns.Named"] },
      { typeId: "Shape", symbolKind: "class", line: 2, reopens: false },
      { typeId: "Runner", symbolKind: "interface", line: 3, reopens: false, conforms: ["Named", "ns.Tagged"] },
      { typeId: "Id", symbolKind: "type_alias", line: 4, reopens: false },
      { typeId: "Color", symbolKind: "enum", line: 5, reopens: false },
      { typeId: "Mode", symbolKind: "enum", line: 6, reopens: false },
    ]);
  });

  it("emits module-level non-function consts, a class expression as a class and a const-object namespace as a module", () => {
    const src = [
      "export const LIMIT = 10;",
      "const a = 1, b = compute();",
      "export const Recorder = class extends Base {};",
      "export const Grouper = { group() {} };",
      "export const DEFAULTS = { timeout: 1 } as const;",
      "let mutable = 1;",
      "var legacy = 2;",
      "const { x, y } = pair;",
      "",
    ].join("\n");

    expect(typeDeclarationsOf(src)).toEqual([
      { typeId: "LIMIT", symbolKind: "constant", line: 1, reopens: false },
      { typeId: "a", symbolKind: "constant", line: 2, reopens: false },
      { typeId: "b", symbolKind: "constant", line: 2, reopens: false },
      { typeId: "Recorder", symbolKind: "class", line: 3, reopens: false, conforms: ["Base"] },
      { typeId: "Grouper", symbolKind: "module", line: 4, reopens: false },
      { typeId: "DEFAULTS", symbolKind: "constant", line: 5, reopens: false },
    ]);
  });

  it("does not emit a function-valued const: it is a function symbol already", () => {
    const src = [
      "export const handler = () => 1;",
      "const legacy = function () {};",
      "function* gen() {}",
      "export const Panel = memo(PanelBase);",
      "",
    ].join("\n");

    expect(typeDeclarationsOf(src)).toBeUndefined();
  });

  it("does not emit locals inside a function or a class body", () => {
    const src = [
      "function run() {",
      "  const LOCAL = 1;",
      "  class Inner {}",
      "  type Local = number;",
      "}",
      "class Svc {",
      "  static LIMIT = 1;",
      "  run() { const x = 2; }",
      "}",
      "",
    ].join("\n");

    expect(typeDeclarationsOf(src)).toEqual([{ typeId: "Svc", symbolKind: "class", line: 6, reopens: false }]);
  });

  it("emits namespaces as modules and what they declare unprefixed, the way symbol ids compose; a string-named ambient module is no fact", () => {
    const src = [
      "namespace Outer.Inner {",
      "  export class Deep {}",
      "  export const MAX = 1;",
      "}",
      "module Legacy { interface Shape {} }",
      "declare namespace Ambient { const z: number; }",
      'declare module "pkg" { interface Request {} }',
      "declare global { interface Window {} }",
      "declare const Q: number;",
      "declare class Declared {}",
      "",
    ].join("\n");

    expect(typeDeclarationsOf(src)).toEqual([
      { typeId: "Outer.Inner", symbolKind: "module", line: 1, reopens: false },
      { typeId: "Deep", symbolKind: "class", line: 2, reopens: false },
      { typeId: "MAX", symbolKind: "constant", line: 3, reopens: false },
      { typeId: "Legacy", symbolKind: "module", line: 5, reopens: false },
      { typeId: "Shape", symbolKind: "interface", line: 5, reopens: false },
      { typeId: "Ambient", symbolKind: "module", line: 6, reopens: false },
      { typeId: "z", symbolKind: "constant", line: 6, reopens: false },
      { typeId: "Request", symbolKind: "interface", line: 7, reopens: false },
      { typeId: "Window", symbolKind: "interface", line: 8, reopens: false },
      { typeId: "Q", symbolKind: "constant", line: 9, reopens: false },
      { typeId: "Declared", symbolKind: "class", line: 10, reopens: false },
    ]);
  });

  it("leaves chunks, symbols and calls byte-identical: the composed walk differs from the native one only by facets", () => {
    const src = [
      'import { helper } from "./helper.js";',
      "export const LIMIT = 3;",
      "export interface Port { run(): void }",
      "export class Svc implements Port {",
      "  run(): void { helper(LIMIT); }",
      "}",
      "",
    ].join("\n");
    const { composed, native } = extract(src);

    expect(composed.typeDeclarations).toHaveLength(3);
    expect(native.typeDeclarations).toBeUndefined();
    expect(composed.imports).toEqual(native.imports);
    expect(composed.chunks.map((c) => [c.symbolId, c.scope, c.startLine, c.endLine, c.calls])).toEqual(
      native.chunks.map((c) => [c.symbolId, c.scope, c.startLine, c.endLine, c.calls]),
    );
  });
});
