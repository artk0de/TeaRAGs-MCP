import { describe, expect, it } from "vitest";

import { RubyTypeFactStore } from "../../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";
import type { RubyTypeFact } from "../../../../../../src/core/domains/language/ruby/walker/type-sources/types.js";

describe("RubyTypeFactStore parity", () => {
  it("param fact -> position-scoped LocalBinding", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "param",
        symbolScope: ["C"],
        methodName: "m",
        name: "user",
        line: 5,
        type: { form: "instance", name: "User" },
      },
    ];
    const store = RubyTypeFactStore.fromFacts(facts);
    expect(store.localBindingsForChunk(3, 20)).toEqual({
      user: [{ line: 5, type: "User" }],
    });
  });

  it("class-valued param keeps valueKind", () => {
    const store = RubyTypeFactStore.fromFacts([
      {
        kind: "local",
        symbolScope: ["C"],
        methodName: "m",
        name: "k",
        line: 7,
        type: { form: "class", name: "User" },
      },
    ]);
    expect(store.localBindingsForChunk(1, 99).k[0]).toEqual({
      line: 7,
      type: "User",
      valueKind: "class",
    });
  });

  it("return fact -> functionReturnTypes entry", () => {
    const store = RubyTypeFactStore.fromFacts([
      {
        kind: "return",
        symbolScope: ["C"],
        methodName: "build",
        type: { form: "instance", name: "Post" },
      },
    ]);
    expect(store.returnTypeByMethod()).toEqual({ build: "Post" });
  });
});
