import { describe, expect, it } from "vitest";

import { RubyTypeFactStore } from "../../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";
import type { RubyTypeFact } from "../../../../../../src/core/domains/language/ruby/walker/type-sources/types.js";

describe("RubyTypeFactStore — source precedence", () => {
  it("yard wins over ast for same coordinate (same scope+method+name+kind+line)", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "param",
        source: "ast",
        symbolScope: ["C"],
        methodName: "m",
        name: "user",
        line: 5,
        type: { form: "instance", name: "AstUser" },
      },
      {
        kind: "param",
        source: "yard",
        symbolScope: ["C"],
        methodName: "m",
        name: "user",
        line: 5,
        type: { form: "instance", name: "YardUser" },
      },
    ];
    const store = RubyTypeFactStore.fromFacts(facts);
    // yard (index 2) wins over ast (index 3) in default ["sorbet","rbs","yard","ast"]
    const bindings = store.localBindingsForChunk(1, 99);
    expect(bindings["user"]).toHaveLength(1);
    expect(bindings["user"]?.[0]).toEqual({ line: 5, type: "YardUser" });
  });

  it("different positions → both kept (no precedence collision)", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "param",
        source: "ast",
        symbolScope: ["C"],
        methodName: "m",
        name: "user",
        line: 5,
        type: { form: "instance", name: "AstUser" },
      },
      {
        kind: "param",
        source: "yard",
        symbolScope: ["C"],
        methodName: "m",
        name: "user",
        line: 10,
        type: { form: "instance", name: "YardUser" },
      },
    ];
    const store = RubyTypeFactStore.fromFacts(facts);
    const bindings = store.localBindingsForChunk(1, 99);
    expect(bindings["user"]).toHaveLength(2);
  });

  it("custom source order: ast wins over yard when ast listed first", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "param",
        source: "yard",
        symbolScope: [],
        name: "x",
        line: 3,
        type: { form: "instance", name: "Yard" },
      },
      {
        kind: "param",
        source: "ast",
        symbolScope: [],
        name: "x",
        line: 3,
        type: { form: "instance", name: "Ast" },
      },
    ];
    const store = RubyTypeFactStore.fromFacts(facts, ["ast", "yard"]);
    const bindings = store.localBindingsForChunk(1, 99);
    expect(bindings["x"]).toHaveLength(1);
    expect(bindings["x"]?.[0]).toEqual({ line: 3, type: "Ast" });
  });
});

describe("RubyTypeFactStore — structuredReturnType", () => {
  it("returns undefined when no return fact for method", () => {
    const store = RubyTypeFactStore.fromFacts([]);
    expect(store.structuredReturnType(["A"], "foo")).toBeUndefined();
  });

  it("instance ref is returned as-is", () => {
    const fact: RubyTypeFact = {
      kind: "return",
      source: "yard",
      symbolScope: ["A"],
      methodName: "foo",
      type: { form: "instance", name: "Post" },
    };
    const store = RubyTypeFactStore.fromFacts([fact]);
    expect(store.structuredReturnType(["A"], "foo")).toEqual({ form: "instance", name: "Post" });
  });

  it("union ref is returned intact (not flattened)", () => {
    const fact: RubyTypeFact = {
      kind: "return",
      source: "yard",
      symbolScope: ["A", "B"],
      methodName: "resolve",
      type: {
        form: "union",
        members: [
          { form: "instance", name: "Foo" },
          { form: "instance", name: "Bar" },
        ],
      },
    };
    const store = RubyTypeFactStore.fromFacts([fact]);
    const ref = store.structuredReturnType(["A", "B"], "resolve");
    expect(ref).toEqual({
      form: "union",
      members: [
        { form: "instance", name: "Foo" },
        { form: "instance", name: "Bar" },
      ],
    });
  });

  it("container ref is returned intact (element preserved)", () => {
    const fact: RubyTypeFact = {
      kind: "return",
      source: "yard",
      symbolScope: ["C"],
      methodName: "all",
      type: { form: "container", element: { form: "instance", name: "Post" } },
    };
    const store = RubyTypeFactStore.fromFacts([fact]);
    expect(store.structuredReturnType(["C"], "all")).toEqual({
      form: "container",
      element: { form: "instance", name: "Post" },
    });
  });

  it("scope mismatch → undefined", () => {
    const fact: RubyTypeFact = {
      kind: "return",
      source: "yard",
      symbolScope: ["A"],
      methodName: "foo",
      type: { form: "instance", name: "Post" },
    };
    const store = RubyTypeFactStore.fromFacts([fact]);
    expect(store.structuredReturnType(["B"], "foo")).toBeUndefined();
    expect(store.structuredReturnType([], "foo")).toBeUndefined();
  });
});

describe("RubyTypeFactStore — ivarType", () => {
  it("returns undefined when no ivar fact", () => {
    const store = RubyTypeFactStore.fromFacts([]);
    expect(store.ivarType(["A"], "@user")).toBeUndefined();
  });

  it("returns ivar ref for matching scope+name", () => {
    const fact: RubyTypeFact = {
      kind: "ivar",
      source: "yard",
      symbolScope: ["A"],
      name: "@user",
      type: { form: "instance", name: "User" },
    };
    const store = RubyTypeFactStore.fromFacts([fact]);
    expect(store.ivarType(["A"], "@user")).toEqual({ form: "instance", name: "User" });
  });

  it("ivar scope mismatch → undefined", () => {
    const fact: RubyTypeFact = {
      kind: "ivar",
      source: "yard",
      symbolScope: ["A"],
      name: "@user",
      type: { form: "instance", name: "User" },
    };
    const store = RubyTypeFactStore.fromFacts([fact]);
    expect(store.ivarType(["B"], "@user")).toBeUndefined();
  });

  it("ivar precedence: yard beats ast at same coordinate", () => {
    const facts: RubyTypeFact[] = [
      {
        kind: "ivar",
        source: "ast",
        symbolScope: ["A"],
        name: "@x",
        type: { form: "instance", name: "AstType" },
      },
      {
        kind: "ivar",
        source: "yard",
        symbolScope: ["A"],
        name: "@x",
        type: { form: "instance", name: "YardType" },
      },
    ];
    const store = RubyTypeFactStore.fromFacts(facts);
    expect(store.ivarType(["A"], "@x")).toEqual({ form: "instance", name: "YardType" });
  });
});
