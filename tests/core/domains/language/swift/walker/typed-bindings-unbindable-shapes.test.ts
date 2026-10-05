/**
 * Swift binding shapes the walker recognises but cannot give a name to: a
 * wildcard loop item, a multi-pattern `case`, a payload pattern that is not
 * `.case(let x)`, a `catch` with a pattern, a closure parameter that is
 * annotated or a wildcard, a closure nested inside an implicit-parameter
 * closure. None of them may bind something wrong, and none may stop the
 * bindings declared after them — a `marker` local is declared below each one
 * and must still be typed.
 *
 * Driven through `extractFromSwiftFile`, the surface the pipeline calls.
 */

import Parser from "tree-sitter";
import SwiftLang from "tree-sitter-swift";
import { describe, expect, it } from "vitest";

import { extractFromSwiftFile } from "../../../../../../src/core/domains/language/swift/walker/walker.js";

function bindingsOf(src: string): Record<string, { type?: string }[] | undefined> {
  const parser = new Parser();
  parser.setLanguage(((SwiftLang as { default?: unknown }).default ?? SwiftLang) as Parser.Language);
  const lines = src.split("\n").length;
  const result = extractFromSwiftFile({
    tree: parser.parse(src),
    code: src,
    relPath: "Sources/Sample.swift",
    language: "swift",
    chunks: [{ symbolId: "f", scope: [], startLine: 1, endLine: lines }],
  });
  return result.chunks[0].localBindings ?? {};
}

function swiftFunction(body: string[]): string {
  return ["import Foundation", "func go(items: [Foo], tag: Tag) {", ...body.map((l) => `  ${l}`), "}", ""].join("\n");
}

describe("typed Swift bindings — shapes that name nothing", () => {
  it("binds no item for a wildcard loop and keeps typing what follows", () => {
    const b = bindingsOf(swiftFunction(["for _ in items { print(1) }", "let marker = Foo()"]));
    expect(b["_"]).toBeUndefined();
    expect(b.marker?.[0].type).toBe("Foo");
  });

  it("binds no payload for a case with several patterns or a qualified case", () => {
    const b = bindingsOf(
      swiftFunction([
        "switch tag {",
        "case .a, .b: print(1)",
        "case Tag.c(let payload): print(payload)",
        "default: break",
        "}",
        "let marker = Foo()",
      ]),
    );
    expect(b.payload).toBeUndefined();
    expect(b.marker?.[0].type).toBe("Foo");
  });

  it("binds `error` only for a bare catch, never for a catch with a pattern", () => {
    const b = bindingsOf(
      swiftFunction([
        "do { try work() } catch let failure as Failure { print(failure) }",
        "do { try work() } catch Failure.timeout { print(1) }",
        "let marker = Foo()",
      ]),
    );
    expect(b.error).toBeUndefined();
    expect(b.marker?.[0].type).toBe("Foo");
  });

  it("leaves annotated and wildcard closure parameters to their own arms", () => {
    const b = bindingsOf(
      swiftFunction([
        "items.forEach { (item: Foo) in print(item) }",
        "items.enumerated().forEach { _, entry in print(entry) }",
        "let marker = Foo()",
      ]),
    );
    expect(b["_"]).toBeUndefined();
    expect(b.marker?.[0].type).toBe("Foo");
  });

  it("binds no implicit parameter for a closure whose own body nests another implicit-parameter closure", () => {
    const b = bindingsOf(swiftFunction(["items.map { $0.children.map { $0.name } }", "let marker = Foo()"]));
    expect(b.marker?.[0].type).toBe("Foo");
  });

  it("types a coalesced value by its left operand", () => {
    const b = bindingsOf(swiftFunction(["let first = Foo()", "let picked = first ?? Foo()"]));
    expect(b.picked?.[0].type).toBe("Foo");
  });
  it("keeps typing after a generic construction, an empty collection literal and a bare navigation chain", () => {
    const b = bindingsOf(
      swiftFunction([
        "let boxed = Box<Foo>(item: Foo())",
        "let none = [Foo]()",
        "let lookup = [String: Foo]()",
        "let nameLength = tag.label.count",
        "let marker = Foo()",
      ]),
    );
    expect(b.marker?.[0].type).toBe("Foo");
  });

  it("keeps typing past a property whose observer block holds a comment, and a closure call in a nested call", () => {
    const src = [
      "import Foundation",
      "final class Holder {",
      "  var level: Int = 0 {",
      "    // observer note",
      "    didSet { print(oldValue) }",
      "  }",
      "  func go(items: [Foo]) {",
      "    let wrapped = Wrapper(build: { (value: Foo) in value })",
      "    perform(after: { items.forEach { print($0) } })",
      "    let marker = Foo()",
      "  }",
      "}",
      "",
    ].join("\n");
    expect(bindingsOf(src).marker?.[0].type).toBe("Foo");
  });
  it("keeps typing after an empty catch, a three-slot loop pattern and an expression that names no type", () => {
    const b = bindingsOf(
      swiftFunction([
        "do { try work() } catch { }",
        "for (a, b, c) in triples { print(a) }",
        "let sum = lhs + rhs",
        "let flag = !done",
        "let pick = done ? lhs : rhs",
        "let marker = Foo()",
      ]),
    );
    expect(b.sum).toBeUndefined();
    expect(b.marker?.[0].type).toBe("Foo");
  });

  it("does not let a value read ahead of its own declaration take that declaration's type", () => {
    const b = bindingsOf(swiftFunction(["let early = later", "let later = Foo()"]));
    expect(b.early).toBeUndefined();
    expect(b.later?.[0].type).toBe("Foo");
  });

  it("types an `if let` rebinding at file scope, where no enclosing block bounds it", () => {
    const src = ["import Foundation", "let source: Foo? = nil", "if let bound = source { print(bound) }", ""].join(
      "\n",
    );
    expect(bindingsOf(src).source?.[0].type).toBe("Foo");
  });
});
