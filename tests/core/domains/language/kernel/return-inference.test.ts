import { describe, expect, it } from "vitest";

import {
  inferReturnTypeName,
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
