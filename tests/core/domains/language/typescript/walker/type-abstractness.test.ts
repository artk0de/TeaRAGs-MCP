/**
 * TypeScript type-abstractness census (bd tea-rags-mcp-r8hme.8). Abstract = a
 * declaration of behaviour a dependent can program against: an abstract class,
 * or an EXPORTED interface / object-type alias that declares a method, call or
 * construct signature or consists mostly of function-typed properties.
 * Concrete = a class that declares behaviour of its own. A class whose members
 * are only a constructor, property fields and getters/setters declares no
 * behaviour — an Error subclass, a data-only record shape — and counts as
 * neither (bd tea-rags-mcp-44cpv, decision c-1=a). A data shape, a props shape
 * whose behaviour is a callback or two among data, a contract the file keeps to
 * itself, a function-type alias, a union and an enum count as neither too.
 */
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { typeAbstractnessOf } from "../../__helpers__/type-abstractness.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";

const grammar = (TsLang as unknown as { typescript: unknown }).typescript;
const censusOf = (src: string) => typeAbstractnessOf(new TypeScriptLanguage(), grammar, src, "a.ts", "typescript");

describe("TypeScript walker — type-abstractness census", () => {
  it("counts exported behaviour contracts and abstract classes as abstract, classes as concrete", () => {
    const src = [
      "export interface Store { get(key: string): string }",
      "export interface Callable { (x: number): void }",
      "export interface Factory { new (): Store }",
      "export interface GraphStore { readonly name: string; read: () => Promise<string>; write: (row: string) => void }",
      "export type Port = { send(message: string): void };",
      "abstract class Base { abstract run(): void }",
      "export class Impl extends Base { run() {} }",
      "class Other {}",
      "",
    ].join("\n");

    // `Other` is behaviour-free (44cpv c-1): an empty class declares no
    // behaviour, so only `Impl` counts as concrete.
    expect(censusOf(src)).toEqual({ abstractTypeCount: 6, concreteTypeCount: 1 });
  });

  it("leaves data shapes, props with callbacks, file-local contracts, function-type aliases, unions and enums out", () => {
    const src = [
      "export interface Options { limit: number; name?: string }",
      "export interface ButtonProps { label: string; disabled: boolean; onClick: () => void }",
      "type Props = { onClose: () => void };",
      "interface LocalStore { get(key: string): string }",
      "export type Listener = (e: string) => void;",
      "export type Id = string | number;",
      "export enum Kind { A, B }",
      "",
    ].join("\n");

    expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
  });

  it("counts a class declared inside a function on its own, and no class expression", () => {
    // `Local` is empty — behaviour-free (44cpv c-1) — so only `Outer` counts.
    expect(censusOf("class Outer { make() { return class Inner {}; } }\nfunction f() { class Local {} }\n")).toEqual({
      abstractTypeCount: 0,
      concreteTypeCount: 1,
    });
  });

  describe("behaviour-free classes (bd tea-rags-mcp-44cpv, decision c-1=a)", () => {
    it("counts an Error subclass of constructor, fields and accessors as neither bucket", () => {
      const src = [
        "export class PipelineError extends Error {",
        "  readonly kind = 'pipeline';",
        "  constructor(public code: string) {",
        "    super(code);",
        "    this.detail = code;",
        "  }",
        "  detail: string = '';",
        '  get name() { return "PipelineError:" + this.code; }',
        "}",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("counts a data-only class, an empty class and accessor-only members as neither", () => {
      const src = [
        "export class Row { readonly id: number; label = ''; }",
        "class Unit {}",
        "class Box { private v = 1; get value() { return this.v; } set value(n: number) { this.v = n; } }",
        "class Sig { [key: string]: unknown; static readonly LIMIT = 5; }",
        "declare class Deferred { ready: boolean; }",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("keeps counting a class as concrete for every form of behaviour a member can take", () => {
      const src = [
        "class WithMethod { run() {} }",
        "class WithStaticMethod { static make() { return new WithStaticMethod(); } }",
        "class WithArrowField { handler = async (x: number) => x; }",
        "class WithFunctionField { fn = function () { return 1; }; }",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 4 });
    });

    it("keeps an abstract class abstract whatever its members", () => {
      expect(censusOf("export abstract class Shape { constructor(public kind: string) {} }\n")).toEqual({
        abstractTypeCount: 1,
        concreteTypeCount: 0,
      });
    });
  });
});
