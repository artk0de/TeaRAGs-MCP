import { describe, expect, it } from "vitest";

import {
  inferReturnTypeName,
  inferReturnTypeNames,
  type ReturnInferencePorts,
} from "../../../../../src/core/domains/language/kernel/return-inference.js";

interface FakeNode {
  readonly id: string;
  readonly kind: "expr" | "binding";
  readonly type?: string;
}
type Ctx = {
  terminals: FakeNode[];
  events: Record<string, (FakeNode | null)[]>;
};

const ports: ReturnInferencePorts<FakeNode, Ctx> = {
  terminalExpressions: (_def, ctx) => ctx.terminals,
  typeOfExpression: (node) => node.type ?? null,
  isBinding: (node) => node.kind === "binding",
  bindingName: (node) => node.id,
  assignmentEvents: (_def, name, ctx) => ctx.events[name] ?? [],
};
const def: FakeNode = { id: "def", kind: "expr" };

describe("inferReturnTypeName", () => {
  it("returns the single nominal type when every arm agrees", () => {
    const ctx: Ctx = {
      terminals: [
        { id: "a", kind: "expr", type: "Foo" },
        { id: "b", kind: "expr", type: "Foo" },
      ],
      events: {},
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBe("Foo");
  });
  it("is silent when two arms disagree", () => {
    const ctx: Ctx = {
      terminals: [
        { id: "a", kind: "expr", type: "Foo" },
        { id: "b", kind: "expr", type: "Bar" },
      ],
      events: {},
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
  it("is silent when any arm is untyped", () => {
    const ctx: Ctx = {
      terminals: [
        { id: "a", kind: "expr", type: "Foo" },
        { id: "b", kind: "expr" },
      ],
      events: {},
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
  it("is silent on no terminal expressions at all", () => {
    expect(inferReturnTypeName(def, { terminals: [], events: {} }, ports)).toBeNull();
  });
  it("indirects a binding arm through its one plain assignment", () => {
    const ctx: Ctx = {
      terminals: [{ id: "r", kind: "binding" }],
      events: { r: [{ id: "v", kind: "expr", type: "Foo" }] },
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBe("Foo");
  });
  it("is silent when a binding is assigned twice", () => {
    const ctx: Ctx = {
      terminals: [{ id: "r", kind: "binding" }],
      events: {
        r: [
          { id: "v", kind: "expr", type: "Foo" },
          { id: "w", kind: "expr", type: "Foo" },
        ],
      },
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
  it("is silent when the binding's single event is non-plain", () => {
    const ctx: Ctx = {
      terminals: [{ id: "r", kind: "binding" }],
      events: { r: [null] },
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
  it("is silent when a binding has no assignment in the body", () => {
    const ctx: Ctx = { terminals: [{ id: "r", kind: "binding" }], events: {} };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
  it("does not recurse a binding whose assignment is another binding", () => {
    const ctx: Ctx = {
      terminals: [{ id: "r", kind: "binding" }],
      events: {
        r: [{ id: "s", kind: "binding" }],
        s: [{ id: "v", kind: "expr", type: "Foo" }],
      },
    };
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });
});

describe("inferReturnTypeNames — the union option (bd tea-rags-mcp-m99j1.1.53)", () => {
  const UNION = { maxArms: 3 };
  const expr = (id: string, type?: string): FakeNode => ({ id, kind: "expr", type });
  const binding: FakeNode = { id: "r", kind: "binding" };

  it("without the option two arms naming different types still kill (the Ruby default)", () => {
    const ctx: Ctx = { terminals: [expr("a", "Foo"), expr("b", "Bar")], events: {} };
    expect(inferReturnTypeNames(def, ctx, ports)).toBeNull();
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });

  it("unions arms naming different types, in declaration order, deduped", () => {
    const ctx: Ctx = { terminals: [expr("a", "Foo"), expr("b", "Bar"), expr("c", "Foo")], events: {} };
    expect(inferReturnTypeNames(def, ctx, ports, UNION)).toEqual(["Foo", "Bar"]);
  });

  it("answers one name when every arm agrees, option or not", () => {
    const ctx: Ctx = { terminals: [expr("a", "Foo"), expr("b", "Foo")], events: {} };
    expect(inferReturnTypeNames(def, ctx, ports, UNION)).toEqual(["Foo"]);
    expect(inferReturnTypeNames(def, ctx, ports)).toEqual(["Foo"]);
  });

  it("still kills on an unmappable arm", () => {
    const ctx: Ctx = { terminals: [expr("a", "Foo"), expr("b")], events: {} };
    expect(inferReturnTypeNames(def, ctx, ports, UNION)).toBeNull();
  });

  it("kills a union wider than the cap", () => {
    const ctx: Ctx = { terminals: [expr("a", "A"), expr("b", "B"), expr("c", "C"), expr("d", "D")], events: {} };
    expect(inferReturnTypeNames(def, ctx, ports, UNION)).toBeNull();
  });

  it("unions a binding's plain assignment events — one per branch", () => {
    const ctx: Ctx = {
      terminals: [binding],
      events: { r: [expr("v", "CursorDebugWrapper"), expr("w", "CursorWrapper")] },
    };
    expect(inferReturnTypeNames(def, ctx, ports, UNION)).toEqual(["CursorDebugWrapper", "CursorWrapper"]);
    expect(inferReturnTypeName(def, ctx, ports)).toBeNull();
  });

  it("still kills a binding with a non-plain event, a second binding hop, or no event", () => {
    const nonPlain: Ctx = { terminals: [binding], events: { r: [expr("v", "Foo"), null] } };
    const hop: Ctx = {
      terminals: [binding],
      events: { r: [expr("v", "Foo"), { id: "s", kind: "binding" }], s: [expr("w", "Bar")] },
    };
    const none: Ctx = { terminals: [binding], events: {} };
    for (const ctx of [nonPlain, hop, none]) expect(inferReturnTypeNames(def, ctx, ports, UNION)).toBeNull();
  });

  it("folds an arm the language already answers with several names", () => {
    const multi: ReturnInferencePorts<FakeNode, Ctx> = {
      ...ports,
      typeOfExpression: (node) => (node.id === "m" ? ["Foo", "Bar"] : (node.type ?? null)),
    };
    const ctx: Ctx = { terminals: [{ id: "m", kind: "expr" }, expr("b", "Baz")], events: {} };
    expect(inferReturnTypeNames(def, ctx, multi, UNION)).toEqual(["Foo", "Bar", "Baz"]);
    expect(inferReturnTypeNames(def, ctx, multi)).toBeNull();
  });
});
