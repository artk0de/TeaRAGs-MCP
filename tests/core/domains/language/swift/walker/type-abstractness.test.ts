/**
 * Swift type-abstractness census (bd tea-rags-mcp-r8hme.8). A protocol is
 * abstract; a class, struct, enum or actor is concrete. An extension re-opens a
 * type declared elsewhere and counts as neither.
 */
import SwiftLang from "tree-sitter-swift";
import { describe, expect, it } from "vitest";

import { typeAbstractnessOf } from "../../__helpers__/type-abstractness.js";
import { SwiftLanguage } from "../../../../../../src/core/domains/language/swift/index.js";

const grammar = (SwiftLang as { default?: unknown }).default ?? SwiftLang;
const censusOf = (src: string) => typeAbstractnessOf(new SwiftLanguage(), grammar, src, "A.swift", "swift");

describe("Swift walker — type-abstractness census", () => {
  it("counts protocols as abstract and nominal types as concrete, extensions as neither", () => {
    const src = [
      "protocol Store { func get() -> Int }",
      "public protocol Marker {}",
      "final class Session {}",
      "struct Request { enum State { case idle } }",
      "actor Cache {}",
      "extension Session: Store { func get() -> Int { 1 } }",
      "",
    ].join("\n");

    expect(censusOf(src)).toEqual({ abstractTypeCount: 2, concreteTypeCount: 4 });
  });
});
