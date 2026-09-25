/**
 * TypeScript type-abstractness census (bd tea-rags-mcp-r8hme.8). Abstract = a
 * declaration of behaviour a dependent can program against: an abstract class,
 * or an EXPORTED interface / object-type alias that declares a method, call or
 * construct signature or consists mostly of function-typed properties.
 * Concrete = a class. A data shape, a props shape whose behaviour is a callback
 * or two among data, a contract the file keeps to itself, a function-type
 * alias, a union and an enum count as neither.
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

    expect(censusOf(src)).toEqual({ abstractTypeCount: 6, concreteTypeCount: 2 });
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
    expect(censusOf("class Outer { make() { return class Inner {}; } }\nfunction f() { class Local {} }\n")).toEqual({
      abstractTypeCount: 0,
      concreteTypeCount: 2,
    });
  });
});
