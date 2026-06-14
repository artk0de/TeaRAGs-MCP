import Parser from "tree-sitter";
import { typescript as TsLang } from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { extractFromTypescriptFile } from "../../../../../src/core/domains/language/typescript/walker/walker.js";

function edges(src: string): string[] {
  const parser = new Parser();
  parser.setLanguage(TsLang as unknown as Parser.Language);
  const tree = parser.parse(src);
  const out = extractFromTypescriptFile({ tree, code: src, relPath: "x.ts", language: "typescript", chunks: [] });
  return (out.inheritanceEdges ?? []).map((e) => `${e.source}:${e.ancestor}:${e.kind}`);
}

describe("TS walker inheritanceEdges", () => {
  it("captures class extends as kind super and implements as kind implements", () => {
    expect(edges(`class Dog extends Animal implements Pet, Trackable {}`).sort()).toEqual(
      ["Dog:Animal:super", "Dog:Pet:implements", "Dog:Trackable:implements"].sort(),
    );
  });

  it("captures interface extends as implements-kind edges", () => {
    expect(edges(`interface Writable extends Closeable, Flushable {}`).sort()).toEqual(
      ["Writable:Closeable:implements", "Writable:Flushable:implements"].sort(),
    );
  });

  it("ordinal reflects declaration order of the implements list", () => {
    const parser = new Parser();
    parser.setLanguage(TsLang as unknown as Parser.Language);
    const src = `class C implements A, B {}`;
    const out = extractFromTypescriptFile({
      tree: parser.parse(src),
      code: src,
      relPath: "x.ts",
      language: "typescript",
      chunks: [],
    });
    const impl = (out.inheritanceEdges ?? [])
      .filter((e) => e.kind === "implements")
      .sort((a, b) => a.ordinal - b.ordinal);
    expect(impl.map((e) => e.ancestor)).toEqual(["A", "B"]);
  });

  it("strips generic type args from the base name (extends Base<T>)", () => {
    expect(edges(`class Repo extends BaseRepo<User> {}`)).toEqual(["Repo:BaseRepo:super"]);
  });

  it("emits nothing for a class with no heritage", () => {
    expect(edges(`class Plain {}`)).toEqual([]);
  });

  it("captures implements without extends (no super edge)", () => {
    expect(edges(`class Service implements Runnable {}`)).toEqual(["Service:Runnable:implements"]);
  });

  it("captures heritage on abstract classes", () => {
    expect(edges(`abstract class Base extends Core implements Lifecycle {}`).sort()).toEqual(
      ["Base:Core:super", "Base:Lifecycle:implements"].sort(),
    );
  });

  it("still populates the legacy classExtends Record (phased — not removed)", () => {
    const parser = new Parser();
    parser.setLanguage(TsLang as unknown as Parser.Language);
    const src = `class Dog extends Animal {}`;
    const out = extractFromTypescriptFile({
      tree: parser.parse(src),
      code: src,
      relPath: "x.ts",
      language: "typescript",
      chunks: [],
    });
    expect(out.classExtends).toEqual({ Dog: "Animal" });
  });
});
