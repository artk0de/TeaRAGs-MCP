/**
 * TypeScript type member census (bd tea-rags-mcp-ffxfc) —
 * `FileExtraction.typeMemberCensus`, read through the seam production runs:
 * materialize, `collectSymbols`, then the COMPOSED `walker.walk`.
 *
 * Per class, interface and object-type alias: how many distinct members are
 * BEHAVIOUR (`method`) and how many are DATA (`field`). A member is a method
 * when it is callable — a method, an overload / abstract signature, a call or
 * construct signature, a property or field whose type or value is a function —
 * and a field otherwise. An accessor pair (`get x` / `set x`) is ONE field: it
 * reads and writes a value. A constructor is construction, not a member; its
 * parameter properties (`constructor(private readonly s: S)`) are fields.
 * Index signatures and static blocks are neither. A type whose members are not
 * written in its declaration (a union alias, an enum, a namespace, a constant)
 * has no census entry — unknown, never zero.
 */
import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

const grammar = (TsLang as unknown as { typescript: unknown }).typescript;

function censusOf(src: string): FileExtraction["typeMemberCensus"] {
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
  return language.walker.walk({ tree, code: src, relPath: "a.ts", language: "typescript", chunks }).typeMemberCensus;
}

describe("TypeScript walker — type member census", () => {
  it("counts an interface's method signature as a method and its property signature as a field", () => {
    const src = ["export interface CacheStore {", "  get(key: string): string;", "  size: number;", "}", ""].join("\n");
    expect(censusOf(src)).toEqual([{ typeId: "CacheStore", line: 1, methodCount: 1, fieldCount: 1 }]);
  });

  it("reads a function-typed property, a call and a construct signature as methods, an accessor pair as one field", () => {
    const src = [
      "interface Port {",
      "  upsert: (row: Row) => Promise<void>;",
      "  onClose?: (() => void) | undefined;",
      "  (x: number): string;",
      "  new (): Port;",
      "  get label(): string;",
      "  set label(v: string);",
      "  readonly id?: string;",
      "  [key: string]: unknown;",
      "}",
      "",
    ].join("\n");
    expect(censusOf(src)).toEqual([{ typeId: "Port", line: 1, methodCount: 4, fieldCount: 2 }]);
  });

  it("counts a class's methods and fields, parameter properties included, the constructor excluded", () => {
    const src = [
      "export abstract class Store {",
      "  constructor(private readonly session: Session, plain: number, public limit = 1) {}",
      "  get size() { return 1; }",
      "  set size(v) {}",
      "  read() {}",
      "  static create() {}",
      "  count = 1;",
      "  handler = () => 1;",
      "  callback: (a: number) => void;",
      "  abstract flush(): void;",
      "  #secret = 2;",
      "  load(): void;",
      "  load(x?: number) {}",
      "  static {}",
      "  [key: string]: any;",
      "}",
      "",
    ].join("\n");
    // methods: read, create, handler, callback, flush, load (overloads merged)
    // fields: session, limit, size (accessor pair), count, #secret
    expect(censusOf(src)).toEqual([{ typeId: "Store", line: 1, methodCount: 6, fieldCount: 5 }]);
  });

  it("counts an object-type alias and a const-bound class expression; other declarations have no census", () => {
    const src = [
      "type Shape = { area(): number; name: string };",
      "type Id = string | number;",
      "enum Color { Red }",
      "namespace Ns { export const X = 1; }",
      "export const Recorder = class { record() {} };",
      "export const LIMIT = 10;",
      "",
    ].join("\n");
    expect(censusOf(src)).toEqual([
      { typeId: "Shape", line: 1, methodCount: 1, fieldCount: 1 },
      { typeId: "Recorder", line: 5, methodCount: 1, fieldCount: 0 },
    ]);
  });

  it("gives a memberless class and interface a zero census, not an absent one", () => {
    const src = ["class Empty {}", "interface Marker {}", ""].join("\n");
    expect(censusOf(src)).toEqual([
      { typeId: "Empty", line: 1, methodCount: 0, fieldCount: 0 },
      { typeId: "Marker", line: 2, methodCount: 0, fieldCount: 0 },
    ]);
  });
});
