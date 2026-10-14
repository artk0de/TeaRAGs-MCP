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

    it("counts an ambient class whose members are method signatures as concrete (bd tea-rags-mcp-89k7k.38)", () => {
      expect(censusOf("declare class A { foo(): void; static bar(x: number): string; }\n")).toEqual({
        abstractTypeCount: 0,
        concreteTypeCount: 1,
      });
    });

    it("keeps an ambient class of constructor and accessor signatures out of both buckets", () => {
      const src = [
        "declare class Point {",
        "  constructor(x: number);",
        "  get x(): number;",
        "  set x(value: number);",
        "  readonly y: number;",
        "}",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("keeps an abstract class abstract whatever its members", () => {
      expect(censusOf("export abstract class Shape { constructor(public kind: string) {} }\n")).toEqual({
        abstractTypeCount: 1,
        concreteTypeCount: 0,
      });
    });
  });

  // bd tea-rags-mcp-mqaj7: a strategy object — a top-level `const` typed by a
  // named contract whose literal supplies the behaviour — implements that
  // contract exactly as a class would. Cut V2 (measured): behaviour members are
  // at least half of the non-spread members, and at least one.
  describe("object-literal implementations (bd tea-rags-mcp-mqaj7)", () => {
    it("counts an exported const typed by a named contract whose literal holds methods as concrete", () => {
      const src = [
        "export interface Detector { family: string; judge(x: number): boolean }",
        'export const sizeDetector: Detector = { family: "size", judge(x) { return x > 1; } };',
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 1, concreteTypeCount: 1 });
    });

    it("counts a pair whose value is an arrow or a function expression as behaviour", () => {
      const src = [
        'export const a: Detector = { family: "a", judge: (x: number) => x > 1 };',
        'export const b: Detector = { family: "b", judge: function (x: number) { return x > 1; } };',
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 2 });
    });

    it("counts a literal that `satisfies` a named contract", () => {
      expect(censusOf("export const hook = { run() {} } satisfies ChunkingHook;\n")).toEqual({
        abstractTypeCount: 0,
        concreteTypeCount: 1,
      });
    });

    it("counts a file-local const too, as it counts a file-local class", () => {
      expect(censusOf("const pass: Pass = { run() {} };\n")).toEqual({ abstractTypeCount: 0, concreteTypeCount: 1 });
    });

    it("leaves a literal whose behaviour members are fewer than half out (a props or options object)", () => {
      expect(
        censusOf("export const props: ButtonProps = { label: 'x', disabled: false, onClick: () => {} };\n"),
      ).toEqual({
        abstractTypeCount: 0,
        concreteTypeCount: 0,
      });
    });

    it("reads accessors as data and leaves spreads out of the member count", () => {
      const src = [
        "export const view: View = { get size() { return 1; }, set size(v) {}, name: 'v' };",
        "export const extended: Pass = { ...base, ...other, run() {} };",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 1 });
    });

    it("does not read a TypeScript utility generic as a named contract, but does a project generic", () => {
      const src = [
        "export const handlers: Record<string, Handler> = { a: () => 1, b: () => 2 };",
        "export const partial: Partial<Port> = { send() {} };",
        "export const typed: Handler<Event> = { handle() {} };",
        "export const nested: ns.Port = { send() {} };",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 2 });
    });

    it("leaves an unannotated literal out — nothing names the contract it implements", () => {
      expect(censusOf("export const registry = { run() {}, stop() {} };\n")).toEqual({
        abstractTypeCount: 0,
        concreteTypeCount: 0,
      });
    });

    it("leaves a function initializer out — a typed function is a value, not a type", () => {
      const src = [
        "export const handle: Handler = () => {};",
        "export const make: Factory = function () { return 1; };",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("counts only a top-level const: neither a nested declaration nor a let", () => {
      const src = [
        "export function build() { const pass: Pass = { run() {} }; return pass; }",
        "export let current: Pass = { run() {} };",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });
  });
});
