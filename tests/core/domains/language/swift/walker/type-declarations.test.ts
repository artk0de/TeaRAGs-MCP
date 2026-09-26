/**
 * Swift `typealias` declarations as naming facts (bd tea-rags-mcp-vi0wx, spec
 * §1b): every alias declared at file scope or directly in a type body — an
 * extension's included — publishes a `type_alias` fact whose id is composed
 * like every other Swift type fact. An alias declared inside a function,
 * computed property or closure is a local and publishes nothing.
 *
 * The facts reach the naming lexicon only; the resolver's read side skips them
 * (`tests/core/domains/language/swift/resolver/swift-typealias-facts.test.ts`).
 */

import Parser from "tree-sitter";
import SwiftLang from "tree-sitter-swift";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromSwiftFile } from "../../../../../../src/core/domains/language/swift/walker/walker.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

function parse(src: string) {
  const p = new Parser();
  p.setLanguage((SwiftLang as { default?: unknown }).default ?? SwiftLang);
  return p.parse(src);
}

function wholeFileChunk(src: string) {
  return [{ symbolId: "f", scope: [] as string[], startLine: 1, endLine: src.split("\n").length }];
}

/** The extraction off the raw tree and off the MATERIALIZED tree the pipeline walks. */
function bothExtractions(src: string): FileExtraction[] {
  const input = { code: src, relPath: "Sources/Sample.swift", language: "swift", chunks: wholeFileChunk(src) };
  return [
    extractFromSwiftFile({ ...input, tree: parse(src) }),
    extractFromSwiftFile({ ...input, tree: { rootNode: materializeTree(parse(src).rootNode, src) } }),
  ];
}

function aliasFacts(extraction: FileExtraction) {
  return (extraction.typeDeclarations ?? []).filter((fact) => fact.symbolKind === "type_alias");
}

describe("swift walker — typealias declarations as naming facts", () => {
  it("publishes a top-level typealias as an own type_alias declaration", () => {
    const src = ["typealias Handler = (Int) -> Void", "public typealias Pair<T> = (T, T)", ""].join("\n");
    for (const extraction of bothExtractions(src)) {
      expect(extraction.typeDeclarations).toEqual([
        { typeId: "Handler", symbolKind: "type_alias", line: 1, reopens: false },
        { typeId: "Pair", symbolKind: "type_alias", line: 2, reopens: false },
      ]);
    }
  });

  it("composes an alias nested in a type under every enclosing type", () => {
    const src = [
      "struct Outer {",
      "  typealias Inner = String",
      "  enum State {",
      "    typealias Raw = Int",
      "    case idle",
      "  }",
      "}",
      "protocol Source {",
      "  typealias Element = Int",
      "}",
      "",
    ].join("\n");
    for (const extraction of bothExtractions(src)) {
      expect(aliasFacts(extraction)).toEqual([
        { typeId: "Outer.Inner", symbolKind: "type_alias", line: 2, reopens: false },
        { typeId: "Outer.State.Raw", symbolKind: "type_alias", line: 4, reopens: false },
        { typeId: "Source.Element", symbolKind: "type_alias", line: 9, reopens: false },
      ]);
    }
  });

  it("composes an alias nested in an extension under the extended type's written path", () => {
    const src = [
      "extension Request {",
      "  typealias Validation = (Int) -> Bool",
      "}",
      "extension Outer.Inner {",
      "  typealias Key = String",
      "}",
      "",
    ].join("\n");
    for (const extraction of bothExtractions(src)) {
      expect(aliasFacts(extraction)).toEqual([
        { typeId: "Request.Validation", symbolKind: "type_alias", line: 2, reopens: false },
        { typeId: "Outer.Inner.Key", symbolKind: "type_alias", line: 5, reopens: false },
      ]);
    }
  });

  it("publishes no alias declared inside a function, a computed property or a closure", () => {
    const src = [
      "func build() {",
      "  typealias Local = Int",
      "}",
      "final class Box {",
      "  func run() { typealias InMethod = Int }",
      "  var size: Int { typealias InGetter = Int; return 1 }",
      "}",
      "let make = { () -> Int in typealias InClosure = Int; return 1 }",
      "",
    ].join("\n");
    for (const extraction of bothExtractions(src)) {
      expect(aliasFacts(extraction)).toEqual([]);
      expect(extraction.typeDeclarations?.map((fact) => fact.typeId)).toEqual(["Box"]);
    }
  });

  it("keeps every other fact of the file exactly as before an alias joined it", () => {
    const withoutAliases = [
      "final class Session: NSObject {",
      "  func run() {}",
      "}",
      "extension Session: Sendable {",
      "}",
      "",
    ].join("\n");
    const withAliases = [
      "final class Session: NSObject {",
      "  func run() {}",
      "}",
      "extension Session: Sendable {",
      "}",
      "typealias Handler = (Session) -> Void",
      "",
    ].join("\n");
    const [rawBefore, materializedBefore] = bothExtractions(withoutAliases);
    const [rawAfter, materializedAfter] = bothExtractions(withAliases);
    for (const [before, after] of [
      [rawBefore, rawAfter],
      [materializedBefore, materializedAfter],
    ]) {
      const { typeDeclarations: factsAfter, ...restAfter } = after;
      const { typeDeclarations: factsBefore, ...restBefore } = before;
      expect(factsAfter?.filter((fact) => fact.symbolKind !== "type_alias")).toEqual(factsBefore);
      // Calls, bindings and every other channel stay byte-identical; only the
      // whole-file chunk's end line moves with the added line.
      expect({ ...restAfter, chunks: restAfter.chunks.map(({ endLine: _end, ...c }) => c) }).toEqual({
        ...restBefore,
        chunks: restBefore.chunks.map(({ endLine: _end, ...c }) => c),
      });
    }
  });
});
