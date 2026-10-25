import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, LocalBinding } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  rustHeadHasInferredLocal,
  rustWithAdditiveInferredBindings,
  rustWithoutInferredBindings,
  rustWithTypableInferredLets,
} from "../../../../../../src/core/domains/language/rust/resolver/inferred-binding-gate.js";

function call(receiver: string | null, startLine = 10): CallRef {
  return { callText: `${receiver}.go`, receiver, member: "go", startLine };
}

function local(type: string, extra: Partial<LocalBinding> = {}): LocalBinding {
  return { line: 3, type, ...extra };
}

function context(overrides: Partial<CallContext>): CallContext {
  return {
    callerFile: "src/main.rs",
    callerScope: [],
    imports: [],
    symbolTable: { lookupByShortName: () => [] },
    ...overrides,
  } as unknown as CallContext;
}

describe("Rust inferred-binding gate", () => {
  it("detects a shaped local only for a non-self receiver head", () => {
    const ctx = context({ localBindings: { x: [local("Foo", { inferenceShape: "selfCopy" })], y: [local("Foo")] } });
    expect(rustHeadHasInferredLocal(call("x.field"), ctx)).toBe(true);
    expect(rustHeadHasInferredLocal(call("y"), ctx)).toBe(false);
    expect(rustHeadHasInferredLocal(call("self"), ctx)).toBe(false);
    expect(rustHeadHasInferredLocal(call(null), ctx)).toBe(false);
    expect(rustHeadHasInferredLocal(call("absent"), ctx)).toBe(false);
  });

  it("drops shaped locals and shaped call-result lets of the head, keeping unshaped ones and other names", () => {
    const keptLocal = local("Plain");
    const ctx = context({
      localBindings: { x: [local("Shaped", { inferenceShape: "initializerArms" }), keptLocal], z: [local("Z")] },
      callResultBindings: {
        x: [
          { line: 4, callee: "make", inferenceShape: "reassignedLet" },
          { line: 5, callee: "plain" },
        ],
      },
    });
    const view = rustWithoutInferredBindings(call("x"), ctx);
    expect(view.localBindings?.x).toEqual([keptLocal]);
    expect(view.localBindings?.z).toBe(ctx.localBindings?.z);
    expect(view.callResultBindings?.x).toEqual([{ line: 5, callee: "plain" }]);
    expect(ctx.localBindings?.x).toHaveLength(2);
    expect(rustWithoutInferredBindings(call("self"), ctx)).toBe(ctx);
    expect(rustWithoutInferredBindings(call("untouched"), ctx)).toBe(ctx);
  });

  it("returns the same context for lets that are not shaped or heads that carry nothing", () => {
    const ctx = context({ callResultBindings: { x: [{ line: 4, callee: "make" }] } });
    expect(rustWithTypableInferredLets(call("self"), ctx)).toBe(ctx);
    expect(rustWithTypableInferredLets(call("x"), ctx)).toBe(ctx);
    expect(rustWithAdditiveInferredBindings(call(null), ctx)).toBe(ctx);
    expect(rustWithAdditiveInferredBindings(call("x"), ctx)).toBe(ctx);
  });

  it("reads a shaped call-result let that types to nothing as absent", () => {
    const ctx = context({
      callResultBindings: {
        x: [{ line: 4, endLine: 4, scopeEndLine: 20, callee: "unknown_fn", inferenceShape: "reassignedLet" }],
      },
      localBindings: { x: [local("Param", { line: 1 })] },
    });
    const view = rustWithTypableInferredLets(call("x", 9), ctx);
    expect(view.callResultBindings?.x).toEqual([]);
    expect(view.localBindings?.x).toEqual([local("Param", { line: 1 })]);
  });

  it("keeps a shaped local whose type places as std, and drops one that places nowhere", () => {
    const shapedStd = local("Vec", { inferenceShape: "variantConstructor" });
    const shapedUnknown = local("Mystery", { inferenceShape: "selfCopy" });
    const shapedEmpty = local("", { inferenceShape: "initializerArms" });
    const ctx = context({ localBindings: { a: [shapedStd, shapedUnknown, shapedEmpty] } });
    const view = rustWithAdditiveInferredBindings(call("a"), ctx);
    expect(view.localBindings?.a).toEqual([shapedStd]);
    expect(ctx.localBindings?.a).toHaveLength(3);
  });

  it("without a declaration table, a shaped local places when the project declares a type of that name", () => {
    const shaped = local("Widget", { inferenceShape: "selfCopy" });
    const declaring = context({
      localBindings: { a: [shaped] },
      symbolTable: {
        lookupByShortName: (name: string) =>
          name === "Widget" ? [{ relPath: "src/w.rs", symbolId: "ui::Widget", symbolKind: "class" }] : [],
      } as unknown as CallContext["symbolTable"],
    });
    expect(rustWithAdditiveInferredBindings(call("a"), declaring)).toBe(declaring);
    const bare = context({ localBindings: { a: [shaped] } });
    expect(rustWithAdditiveInferredBindings(call("a"), bare).localBindings?.a).toEqual([]);
  });

  it("with a declaration table, places by the run's own declarations and ignores re-openings", () => {
    const own = local("Widget", { inferenceShape: "selfCopy" });
    const reopened = local("Gadget", { inferenceShape: "selfCopy" });
    const ctx = context({
      localBindings: { a: [own, reopened] },
      typeDeclarations: {
        "src/w.rs": [
          { typeId: "ui::Widget", symbolKind: "class", line: 1 },
          { typeId: "ui::Gadget", symbolKind: "class", line: 2, reopens: true },
        ],
      } as unknown as CallContext["typeDeclarations"],
    });
    expect(rustWithAdditiveInferredBindings(call("a"), ctx).localBindings?.a).toEqual([own]);
    // Second read hits the per-table memo and agrees.
    expect(rustWithAdditiveInferredBindings(call("a"), ctx).localBindings?.a).toEqual([own]);
  });
});
