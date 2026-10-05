/**
 * P1 iteration bindings, the shapes `iteration-bindings.test.ts` does not
 * reach: tuple / container iterators, the built-in table (`zip`, `sorted`, the
 * shadowing and whole-call guards), the untyped-container write facts, union
 * context managers, and the rebinding rule of `pythonLocalBindingInForce`.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  LocalBinding,
  SymbolResolutionTarget,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import {
  pythonElementTypeOf,
  pythonLocalBindingInForce,
} from "../../../../../../src/core/domains/language/python/resolver/python-iteration-types.js";
import { createPythonReceiverTypePorts } from "../../../../../../src/core/domains/language/python/resolver/python-receiver-type-ports.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      ids.map((symbolId) => {
        const parts = symbolId.split(/[#.]/);
        return { symbolId, fqName: symbolId, shortName: parts[parts.length - 1], relPath, scope: parts.slice(0, -1) };
      }),
    );
  }
  return table;
}

const instance = (name: string): TypeRef => ({ form: "instance", name });
const containerOf = (name: string): TypeRef => ({ form: "container", element: instance(name) });

const derived = (
  valueKind: "iterationElement" | "contextEnter" | "tupleElement",
  line: number,
  sourceExpression: string,
  tupleIndex?: number,
): LocalBinding => ({
  line,
  type: "",
  valueKind,
  sourceExpression,
  ...(tupleIndex === undefined ? {} : { tupleIndex }),
  endLine: line,
});

const call = (receiver: string, member: string, startLine: number): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine,
});

const resolve = (ref: CallRef, ctx: CallContext): SymbolResolutionTarget | null =>
  new PythonCallResolver().resolve(ref, ctx);

const FILE = "shop/cart.py";
const TABLE = {
  [FILE]: [
    "Cart",
    "Cart#run",
    "Item",
    "Item#price",
    "Coupon",
    "Coupon#apply",
    "Bag",
    "Bag#__iter__",
    "Lock",
    "Lock#__enter__",
    "Lock#release",
    "Guard",
    "Guard#__enter__",
    "Guard#release",
  ],
};

const baseCtx = (localBindings: Record<string, LocalBinding[]>, extra: Partial<CallContext> = {}): CallContext => ({
  callerFile: FILE,
  callerScope: ["Cart", "run"],
  imports: [],
  symbolTable: tableWith(TABLE),
  localBindings,
  ...extra,
});

describe("pythonElementTypeOf — the kernel iteration port", () => {
  const ctx = baseCtx({});
  const noMembers = () => undefined;

  it("reads a homogeneous tuple's element and declines a heterogeneous or non-nominal one", () => {
    const homogeneous: TypeRef = { form: "tuple", elements: [instance("Item"), instance("Item")] };
    const mixed: TypeRef = { form: "tuple", elements: [instance("Item"), instance("Coupon")] };
    expect(pythonElementTypeOf(homogeneous, ctx, noMembers)).toEqual(instance("Item"));
    expect(pythonElementTypeOf(mixed, ctx, noMembers)).toBeNull();
    expect(pythonElementTypeOf({ form: "tuple", elements: [] }, ctx, noMembers)).toBeNull();
    expect(pythonElementTypeOf({ form: "tuple", elements: [containerOf("Item")] }, ctx, noMembers)).toBeNull();
  });

  it("walks `__iter__` → `__next__` for a project class and honours a container-valued `__iter__`", () => {
    const members: Record<string, TypeRef> = {
      "Bag.__iter__": instance("BagIterator"),
      "BagIterator.__next__": instance("Item"),
      "List.__iter__": containerOf("Coupon"),
      "Odd.__iter__": { form: "nil" },
    };
    const memberTypeOf = (recv: TypeRef, member: string): TypeRef | undefined =>
      recv.form === "instance" ? members[`${recv.name}.${member}`] : undefined;
    expect(pythonElementTypeOf(instance("Bag"), ctx, memberTypeOf)).toEqual(instance("Item"));
    expect(pythonElementTypeOf(instance("List"), ctx, memberTypeOf)).toEqual(instance("Coupon"));
    expect(pythonElementTypeOf(instance("Odd"), ctx, memberTypeOf)).toBeNull();
    expect(pythonElementTypeOf(instance("Plain"), ctx, memberTypeOf)).toBeNull();
    expect(pythonElementTypeOf({ form: "nil" }, ctx, memberTypeOf)).toBeNull();
  });
});

describe("Python iteration bindings — built-in table and guards", () => {
  const items: LocalBinding = { line: 3, type: "Item", typeRef: containerOf("Item") };
  const coupons: LocalBinding = { line: 3, type: "Coupon", typeRef: containerOf("Coupon") };

  it("a fixed tuple annotation of one element type iterates as that element", () => {
    const pair: LocalBinding = {
      line: 3,
      type: "Item",
      typeRef: { form: "tuple", elements: [instance("Item"), instance("Item")] },
    };
    const ctx = baseCtx({ pair: [pair], x: [derived("iterationElement", 4, "pair")] });
    expect(resolve(call("x", "price", 5), ctx)?.targetSymbolId).toBe("Item#price");
  });

  it("an element-preserving built-in (`sorted`, `reversed`) passes the argument's element through", () => {
    const ctx = baseCtx({
      items: [items],
      a: [derived("iterationElement", 4, "sorted(items, key=len)")],
      b: [derived("iterationElement", 4, "reversed(items)")],
    });
    expect(resolve(call("a", "price", 5), ctx)?.targetSymbolId).toBe("Item#price");
    expect(resolve(call("b", "price", 5), ctx)?.targetSymbolId).toBe("Item#price");
  });

  it("`zip(xs, ys)` yields the i-th argument's element at position i; no index ⇒ untyped", () => {
    const ctx = baseCtx({
      items: [items],
      coupons: [coupons],
      i: [derived("iterationElement", 4, "zip(items, coupons)", 0)],
      c: [derived("iterationElement", 4, "zip(items, coupons)", 1)],
      whole: [derived("iterationElement", 4, "zip(items, coupons)")],
    });
    expect(resolve(call("i", "price", 5), ctx)?.targetSymbolId).toBe("Item#price");
    expect(resolve(call("c", "apply", 5), ctx)?.targetSymbolId).toBe("Coupon#apply");
    expect(resolve(call("whole", "price", 5), ctx)?.targetSymbolId).not.toBe("Item#price");
  });

  it("`enumerate(xs)` index position carries no element type", () => {
    const ctx = baseCtx({ items: [items], idx: [derived("iterationElement", 4, "enumerate(items)", 0)] });
    expect(resolve(call("idx", "price", 5), ctx)?.targetSymbolId).not.toBe("Item#price");
  });

  it("a locally shadowed built-in name and a call that is only a prefix are not folded", () => {
    const shadowed = baseCtx({
      items: [items],
      sorted: [{ line: 2, type: "Cart" }],
      x: [derived("iterationElement", 4, "sorted(items)")],
    });
    expect(resolve(call("x", "price", 5), shadowed)?.targetSymbolId).not.toBe("Item#price");

    const prefixOnly = baseCtx({ items: [items], x: [derived("iterationElement", 4, "sorted(items).pop")] });
    expect(resolve(call("x", "price", 5), prefixOnly)?.targetSymbolId).not.toBe("Item#price");
  });
});

describe("Python iteration bindings — untyped containers and mapping views", () => {
  it("an untyped container's element comes from the walker's write fact on `<iterable>[]`", () => {
    const ctx = baseCtx({
      "found[]": [{ line: 3, type: "Item" }],
      x: [derived("iterationElement", 5, "found")],
    });
    expect(resolve(call("x", "price", 6), ctx)?.targetSymbolId).toBe("Item#price");
  });

  it("an untyped mapping states its element only through the `.values()` view", () => {
    const ctx = baseCtx({
      "prices.values()[]": [{ line: 3, type: "Item" }],
      v: [derived("iterationElement", 5, "prices.values()")],
      pair_v: [derived("iterationElement", 5, "prices.items()", 1)],
      pair_k: [derived("iterationElement", 5, "prices.items()", 0)],
    });
    expect(resolve(call("v", "price", 6), ctx)?.targetSymbolId).toBe("Item#price");
    expect(resolve(call("pair_v", "price", 6), ctx)?.targetSymbolId).toBe("Item#price");
    expect(resolve(call("pair_k", "price", 6), ctx)?.targetSymbolId).not.toBe("Item#price");
  });

  it("a write fact with no type contributes nothing", () => {
    const ctx = baseCtx({
      "found[]": [{ line: 3, type: "" }],
      x: [derived("iterationElement", 5, "found")],
    });
    expect(resolve(call("x", "price", 6), ctx)?.targetSymbolId).not.toBe("Item#price");
  });

  it("an element fact that is itself derived is folded through the same reader", () => {
    const ctx = baseCtx({
      coupons: [{ line: 2, type: "Coupon", typeRef: containerOf("Coupon") }],
      "found[]": [derived("iterationElement", 3, "coupons")],
      x: [derived("iterationElement", 5, "found")],
    });
    expect(resolve(call("x", "apply", 6), ctx)?.targetSymbolId).toBe("Coupon#apply");
  });
});

describe("Python context-manager bindings — union contexts", () => {
  const union = (...members: TypeRef[]): LocalBinding => ({
    line: 3,
    type: "Lock",
    typeRef: { form: "union", members },
  });

  it("one arm that yields nothing leaves the target untyped, never a partial union", () => {
    const ctx = baseCtx(
      { cm: [union(instance("Lock"), instance("Guard"))], c: [derived("contextEnter", 5, "cm")] },
      { structuredReturnTypes: { "Lock#__enter__": instance("Lock") } },
    );
    expect(resolve(call("c", "release", 6), ctx)?.targetSymbolId).not.toBe("Lock#release");
  });

  it("a non-nominal union arm leaves the target untyped", () => {
    const ctx = baseCtx(
      { cm: [union(instance("Lock"), containerOf("Item"))], c: [derived("contextEnter", 5, "cm")] },
      { structuredReturnTypes: { "Lock#__enter__": instance("Lock") } },
    );
    expect(resolve(call("c", "release", 6), ctx)?.targetSymbolId).not.toBe("Lock#release");
  });

  it("every nominal arm yielding the same class (nil arms skipped) types the target", () => {
    const ctx = baseCtx(
      { cm: [union(instance("Lock"), instance("Guard"), { form: "nil" })], c: [derived("contextEnter", 5, "cm")] },
      { structuredReturnTypes: { "Lock#__enter__": instance("Guard"), "Guard#__enter__": instance("Guard") } },
    );
    expect(resolve(call("c", "release", 6), ctx)?.targetSymbolId).toBe("Guard#release");
  });
});

describe("pythonLocalBindingInForce — a call result established after the loop rebinds the name", () => {
  it("drops an iteration binding a later call-result binding supersedes, keeps a typed one", () => {
    const iteration = derived("iterationElement", 4, "items");
    const typed: LocalBinding = { line: 4, type: "Item" };
    const ctx = baseCtx(
      { x: [iteration], y: [typed] },
      { callResultBindings: { x: [{ callee: "make_item", line: 6 }], y: [{ callee: "make_item", line: 6 }] } },
    );
    expect(pythonLocalBindingInForce(ctx, "x", 5)).toBe(iteration);
    expect(pythonLocalBindingInForce(ctx, "x", 7)).toBeUndefined();
    expect(pythonLocalBindingInForce(ctx, "y", 7)).toBe(typed);
  });
});

describe("kernel port wiring", () => {
  it("createPythonReceiverTypePorts exposes the tuple-aware element read", () => {
    const ports = createPythonReceiverTypePorts(new PythonImportFileMapper());
    const ctx = baseCtx({});
    expect(ports.elementTypeOf?.({ form: "tuple", elements: [instance("Item"), instance("Item")] }, ctx)).toEqual(
      instance("Item"),
    );
  });
});
