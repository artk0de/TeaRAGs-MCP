/**
 * `parseSwiftTypeText` past the common spellings `swift-type-text.test.ts`
 * pins: variadics, metatypes of non-nominals, typed throws, attribute
 * arguments with nested parentheses — and the malformed spellings it must
 * decline as a whole rather than half-parse. Plus `swiftTypeExprNominal`, the
 * SDK name each parsed form IS.
 */

import { describe, expect, it } from "vitest";

import {
  parseSwiftTypeText,
  swiftTypeExprNominal,
} from "../../../../../../src/core/domains/language/swift/vocabulary/swift-type-text.js";

const nominal = (path: string) => ({ kind: "nominal", path, args: [] });

describe("parseSwiftTypeText — less common spellings", () => {
  it("reads a variadic parameter type as an array of its element", () => {
    expect(parseSwiftTypeText("Int...")).toEqual({ kind: "array", element: nominal("Int") });
  });

  it("reads `.Type` on a parenthesised type as its metatype", () => {
    expect(parseSwiftTypeText("(Int).Type")).toEqual({ kind: "metatype", instance: nominal("Int") });
    expect(parseSwiftTypeText("[Int].Protocol")).toEqual({
      kind: "metatype",
      instance: { kind: "array", element: nominal("Int") },
    });
  });

  it("skips typed throws and attribute arguments, nested parentheses included", () => {
    expect(parseSwiftTypeText("(Int) throws(ParseError) -> String")).toEqual({
      kind: "function",
      params: [nominal("Int")],
      returns: nominal("String"),
    });
    expect(parseSwiftTypeText("@_lifetime(copy (source)) Span<Int>")).toEqual({
      kind: "nominal",
      path: "Span",
      args: [nominal("Int")],
    });
  });

  it.each([
    ["an empty collection", "["],
    ["a dictionary without a value", "[String: ]"],
    ["an unclosed dictionary", "[String: Int"],
    ["tuple elements without a comma", "(Int String)"],
    ["an empty generic argument list", "Array<>"],
    ["a composition with nothing after `&`", "Codable & "],
    ["a function type with no return", "(Int) -> "],
    ["a bare `.Type`", "Type"],
  ])("declines %s", (_label, text) => {
    expect(parseSwiftTypeText(text)).toBeUndefined();
  });
});

describe("swiftTypeExprNominal", () => {
  it.each([
    ["Box<Int>", "Box"],
    ["[Int]", "Array"],
    ["[String: Int]", "Dictionary"],
    ["Int?", "Optional"],
    ["(Int) -> Void", undefined],
    ["(Int, String)", undefined],
    ["Int.Type", undefined],
  ])("names %s as %s", (text, expected) => {
    const parsed = parseSwiftTypeText(text);
    expect(parsed).toBeDefined();
    expect(parsed && swiftTypeExprNominal(parsed)).toBe(expected);
  });
});
