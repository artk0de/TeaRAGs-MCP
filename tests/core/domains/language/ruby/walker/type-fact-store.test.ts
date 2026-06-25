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

  it("container form (Array<Post>) -> element type name (Post) via refToName recursion", () => {
    // refToName({form:"container", element:{form:"instance",name:"Post"}}) → "Post"
    const store = RubyTypeFactStore.fromFacts([
      {
        kind: "return",
        symbolScope: ["C"],
        methodName: "all_posts",
        type: { form: "container", element: { form: "instance", name: "Post" } },
      },
    ]);
    expect(store.returnTypeByMethod()).toEqual({ all_posts: "Post" });
  });

  it("union form -> undefined (deferred to Incr 1), fact is dropped from returnTypeByMethod", () => {
    const store = RubyTypeFactStore.fromFacts([
      {
        kind: "return",
        symbolScope: [],
        methodName: "multi",
        type: {
          form: "union",
          members: [
            { form: "instance", name: "A" },
            { form: "instance", name: "B" },
          ],
        },
      },
    ]);
    // Union resolves to undefined → not added to the output map
    expect(store.returnTypeByMethod()).toEqual({});
  });

  it("sorts multiple bindings for same variable by line (ascending)", () => {
    // Two param facts for the same name at different lines → sort fires
    const store = RubyTypeFactStore.fromFacts([
      { kind: "param", symbolScope: [], name: "x", line: 10, type: { form: "instance", name: "B" } },
      { kind: "param", symbolScope: [], name: "x", line: 5, type: { form: "instance", name: "A" } },
    ]);
    const bindings = store.localBindingsForChunk(1, 20);
    expect(bindings["x"]).toEqual([
      { line: 5, type: "A" },
      { line: 10, type: "B" },
    ]);
  });

  it("skips param facts with line === undefined", () => {
    const store = RubyTypeFactStore.fromFacts([
      // A fact with no `line` field (line is undefined)
      { kind: "param", symbolScope: [], name: "x", type: { form: "instance", name: "User" } } as RubyTypeFact,
    ]);
    expect(store.localBindingsForChunk(1, 99)).toEqual({});
  });
});
