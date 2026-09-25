import { describe, expect, it } from "vitest";

import { parseSwiftTypeText } from "../../../../../../src/core/domains/language/swift/vocabulary/swift-type-text.js";

const nominal = (path: string, ...args: unknown[]) => ({ kind: "nominal", path, args });

describe("parseSwiftTypeText", () => {
  it("parses a nominal with generic arguments", () => {
    expect(parseSwiftTypeText("Result<Success, NewFailure>")).toEqual(
      nominal("Result", nominal("Success"), nominal("NewFailure")),
    );
  });

  it("keeps a dotted path and collects every generic group's arguments in order", () => {
    expect(parseSwiftTypeText("AsyncStream<Element>.Continuation.YieldResult")).toEqual(
      nominal("AsyncStream.Continuation.YieldResult", nominal("Element")),
    );
    expect(parseSwiftTypeText("Self.SubSequence")).toEqual(nominal("Self.SubSequence"));
  });

  it("parses optionals, arrays and dictionaries", () => {
    expect(parseSwiftTypeText("[String : Any]?")).toEqual({
      kind: "optional",
      wrapped: { kind: "dictionary", key: nominal("String"), value: nominal("Any") },
    });
    expect(parseSwiftTypeText("[URLQueryItem]")).toEqual({ kind: "array", element: nominal("URLQueryItem") });
  });

  it("drops attributes, ownership keywords, any / some and effects", () => {
    expect(parseSwiftTypeText("(any StreamDelegate)?")).toEqual({
      kind: "optional",
      wrapped: nominal("StreamDelegate"),
    });
    expect(parseSwiftTypeText("@escaping @Sendable (inout Value) throws -> U")).toEqual({
      kind: "function",
      params: [nominal("Value")],
      returns: nominal("U"),
    });
    expect(parseSwiftTypeText("() async throws(Failure) -> Success")).toEqual({
      kind: "function",
      params: [],
      returns: nominal("Success"),
    });
  });

  it("parses a function type's parameters, labels dropped", () => {
    expect(parseSwiftTypeText("(Self.Element) throws -> Void")).toEqual({
      kind: "function",
      params: [nominal("Self.Element")],
      returns: nominal("Void"),
    });
    expect(parseSwiftTypeText("(_ data: Data, response: URLResponse?) -> Void")).toEqual({
      kind: "function",
      params: [nominal("Data"), { kind: "optional", wrapped: nominal("URLResponse") }],
      returns: nominal("Void"),
    });
  });

  it("parses an optional function type and a metatype", () => {
    expect(parseSwiftTypeText("(@Sendable (Termination) -> Void)?")).toEqual({
      kind: "optional",
      wrapped: { kind: "function", params: [nominal("Termination")], returns: nominal("Void") },
    });
    expect(parseSwiftTypeText("T.Type")).toEqual({ kind: "metatype", instance: nominal("T") });
  });

  it("answers the first member of a protocol composition", () => {
    expect(parseSwiftTypeText("any Subscriber & Sendable")).toEqual(nominal("Subscriber"));
  });

  it("declines text that is not a type", () => {
    expect(parseSwiftTypeText("foo(bar)")).toBeUndefined();
    expect(parseSwiftTypeText("")).toBeUndefined();
  });
});
