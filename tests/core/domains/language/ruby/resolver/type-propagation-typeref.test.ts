/**
 * INFRA-A: typeOfReceiver reads LocalBinding.typeRef when present (union / container),
 * and constructs {form,name} from type+valueKind for plain bindings (backward compat).
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { typeOfReceiver } from "../../../../../../src/core/domains/language/ruby/resolver/type-propagation.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const emptyCtx = (over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
  ...over,
});

describe("typeOfReceiver — reads LocalBinding.typeRef for union/container (INFRA-A)", () => {
  it("returns union typeRef from binding.typeRef when present", () => {
    const unionRef = {
      form: "union" as const,
      members: [
        { form: "instance" as const, name: "A" },
        { form: "instance" as const, name: "B" },
      ],
    };
    const ctx = emptyCtx({
      localBindings: {
        obj: [{ line: 5, type: "A", typeRef: unionRef }],
      },
    });
    expect(typeOfReceiver("obj", 10, ctx)).toEqual(unionRef);
  });

  it("returns container typeRef from binding.typeRef when present", () => {
    const containerRef = { form: "container" as const, element: { form: "instance" as const, name: "Post" } };
    const ctx = emptyCtx({
      localBindings: {
        posts: [{ line: 3, type: "Post", typeRef: containerRef }],
      },
    });
    expect(typeOfReceiver("posts", 10, ctx)).toEqual(containerRef);
  });

  it("falls back to {form, name} from type+valueKind when typeRef is absent", () => {
    const ctx = emptyCtx({
      localBindings: {
        user: [{ line: 2, type: "User" }],
      },
    });
    expect(typeOfReceiver("user", 5, ctx)).toEqual({ form: "instance", name: "User" });
  });

  it("falls back to class form when valueKind=class and no typeRef", () => {
    const ctx = emptyCtx({
      localBindings: {
        k: [{ line: 2, type: "User", valueKind: "class" }],
      },
    });
    expect(typeOfReceiver("k", 5, ctx)).toEqual({ form: "class", name: "User" });
  });

  it("typeRef wins over type+valueKind reconstruction even when both present", () => {
    const unionRef = {
      form: "union" as const,
      members: [
        { form: "instance" as const, name: "X" },
        { form: "instance" as const, name: "Y" },
      ],
    };
    const ctx = emptyCtx({
      localBindings: {
        val: [{ line: 1, type: "X", valueKind: "instance", typeRef: unionRef }],
      },
    });
    // typeRef present → return it, not the reconstructed {form:"instance",name:"X"}
    expect(typeOfReceiver("val", 5, ctx)).toEqual(unionRef);
  });
});
