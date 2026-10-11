/**
 * Swift type-abstractness census (bd tea-rags-mcp-r8hme.8). A protocol is
 * abstract. A type that declares behaviour of its own is concrete; a type whose
 * members are only initializers, stored properties and computed properties
 * declares no behaviour — an error struct, a value object — and counts as
 * neither (bd tea-rags-mcp-44cpv, decision c-1=a). An extension re-opens a
 * type declared elsewhere and counts as neither too.
 */
import SwiftLang from "tree-sitter-swift";
import { describe, expect, it } from "vitest";

import { typeAbstractnessOf } from "../../__helpers__/type-abstractness.js";
import { SwiftLanguage } from "../../../../../../src/core/domains/language/swift/index.js";

const grammar = (SwiftLang as { default?: unknown }).default ?? SwiftLang;
const censusOf = (src: string) => typeAbstractnessOf(new SwiftLanguage(), grammar, src, "A.swift", "swift");

describe("Swift walker — type-abstractness census", () => {
  it("counts protocols as abstract and behaviour-declaring types as concrete, extensions as neither", () => {
    const src = [
      "protocol Store { func get() -> Int }",
      "public protocol Marker {}",
      "final class Session { func open() {} }",
      "struct Request { enum State { case idle } }",
      "actor Cache { func clear() {} }",
      "extension Session: Store { func get() -> Int { 1 } }",
      "",
    ].join("\n");

    // `Request` holds only a nested enum (judged on its own — a case is data,
    // so `State` is behaviour-free too, 44cpv c-1), so every nominal type here
    // except the behaviour-declaring ones is out of both buckets.
    expect(censusOf(src)).toEqual({ abstractTypeCount: 2, concreteTypeCount: 2 });
  });

  describe("behaviour-free types (bd tea-rags-mcp-44cpv, decision c-1=a)", () => {
    it("counts an error type of init, stored and computed properties as neither bucket", () => {
      const src = [
        "struct PipelineError: Error {",
        "  let code: String",
        '  static let kind = "pipeline"',
        "  var description: String { return code }",
        "  init(code: String) { self.code = code }",
        "}",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("counts empty types and case-only enums as neither, deinit as lifecycle", () => {
      const src = [
        "final class Session {}",
        "actor Cache {}",
        "enum State { case idle, busy }",
        "class Guard { deinit {} }",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    });

    it("keeps counting a type as concrete for an instance or static func, or a closure-valued property", () => {
      const src = [
        "class WithFunc { func run() {} }",
        "struct WithStaticFunc { static func make() -> WithStaticFunc { WithStaticFunc() } }",
        "class WithClosureProperty { var handler = { (x: Int) in x } }",
        "",
      ].join("\n");

      expect(censusOf(src)).toEqual({ abstractTypeCount: 0, concreteTypeCount: 3 });
    });
  });
});
