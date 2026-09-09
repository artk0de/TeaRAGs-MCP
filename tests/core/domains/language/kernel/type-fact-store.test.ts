import { describe, expect, it } from "vitest";

import { TypeFactStore } from "../../../../../src/core/domains/language/kernel/type-fact-store.js";
import type { TypeFact } from "../../../../../src/core/domains/language/kernel/type-facts.js";
import {
  RUBY_TYPE_SOURCE_ORDER,
  RubyTypeFactStore,
} from "../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";

const YARD_FIRST = ["yard", "ast"] as const;
const AST_FIRST = ["ast", "yard"] as const;

function returnFact(source: string, name: string): TypeFact {
  return { kind: "return", source, symbolScope: ["A"], methodName: "m", type: { form: "instance", name } };
}
function ivarFact(source: string, name: string): TypeFact {
  return { kind: "ivar", source, symbolScope: ["A"], name: "@x", type: { form: "instance", name } };
}

describe("TypeFactStore — the injected order governs EVERY ranked read", () => {
  it("ranks localBindingsForChunk by the order it was given", () => {
    const facts: TypeFact[] = [
      { kind: "param", source: "yard", symbolScope: [], name: "x", line: 3, type: { form: "instance", name: "Y" } },
      { kind: "param", source: "ast", symbolScope: [], name: "x", line: 3, type: { form: "instance", name: "A" } },
    ];
    expect(TypeFactStore.fromFacts(facts, YARD_FIRST).localBindingsForChunk(1, 9)["x"]).toEqual([
      { line: 3, type: "Y" },
    ]);
    expect(TypeFactStore.fromFacts(facts, AST_FIRST).localBindingsForChunk(1, 9)["x"]).toEqual([
      { line: 3, type: "A" },
    ]);
  });

  it("ranks structuredReturnType and structuredReturnTypesMap by the same order", () => {
    const facts = [returnFact("yard", "Y"), returnFact("ast", "A")];
    expect(TypeFactStore.fromFacts(facts, YARD_FIRST).structuredReturnType(["A"], "m")).toEqual({
      form: "instance",
      name: "Y",
    });
    expect(TypeFactStore.fromFacts(facts, AST_FIRST).structuredReturnType(["A"], "m")).toEqual({
      form: "instance",
      name: "A",
    });
    expect(TypeFactStore.fromFacts(facts, AST_FIRST).structuredReturnTypesMap()["A#m"]).toEqual({
      form: "instance",
      name: "A",
    });
  });

  it("ranks ivarType and ivarTypesMap by the same order", () => {
    const facts = [ivarFact("yard", "Y"), ivarFact("ast", "A")];
    expect(TypeFactStore.fromFacts(facts, AST_FIRST).ivarType(["A"], "@x")).toEqual({ form: "instance", name: "A" });
    expect(TypeFactStore.fromFacts(facts, AST_FIRST).ivarTypesMap()["A"]).toEqual({ "@x": "A" });
    expect(TypeFactStore.fromFacts(facts, YARD_FIRST).ivarTypesMap()["A"]).toEqual({ "@x": "Y" });
  });

  it("an empty order ranks everything equal, so the first fact seen wins", () => {
    const store = TypeFactStore.fromFacts([returnFact("ast", "A"), returnFact("yard", "Y")], []);
    expect(store.structuredReturnTypesMap()["A#m"]).toEqual({ form: "instance", name: "A" });
  });

  it("keeps each variable's bindings sorted by line", () => {
    const at = (line: number, name: string): TypeFact => ({
      kind: "local",
      source: "ast",
      symbolScope: [],
      name: "v",
      line,
      type: { form: "instance", name },
    });
    const bindings = TypeFactStore.fromFacts([at(9, "Late"), at(2, "Early")], AST_FIRST).localBindingsForChunk(1, 20);
    expect(bindings["v"]?.map((b) => b.line)).toEqual([2, 9]);
  });
});

describe("RubyTypeFactStore shim", () => {
  it("states the seven Ruby ranks and applies them when no order is passed", () => {
    expect(RUBY_TYPE_SOURCE_ORDER).toEqual([
      "sorbet",
      "rbs",
      "yard",
      "associations",
      "draper",
      "body-last-expr",
      "ast",
    ]);
    const store = RubyTypeFactStore.fromFacts([returnFact("ast", "A"), returnFact("yard", "Y")]);
    expect(store.structuredReturnTypesMap()["A#m"]).toEqual({ form: "instance", name: "Y" });
  });
});
