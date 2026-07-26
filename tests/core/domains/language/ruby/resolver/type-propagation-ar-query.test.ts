/**
 * G1b — ActiveRecord query-interface fallback in `returnTypeOf`.
 *
 * On a receiver that is an AR MODEL (its transitive ancestry reaches
 * `ApplicationRecord` | `ActiveRecord::Base`), the Rails-defined query methods
 * resolve WITHOUT per-model facts:
 *   - instance-returning (`find`, `create!`, `first`, …)  ⇒ the model
 *   - relation-returning (`where`, `order`, `includes`, …) ⇒ container(model)
 *   - dynamic finder prefix (`find_by_<attr>`)             ⇒ the model
 *
 * The rule is consulted AFTER every declared fact (a declared return type beats
 * vocabulary) and is GATED on the AR-model check, so a non-model class that
 * happens to define `find` must NOT be typed by it.
 *
 * `returnTypeOf` is module-private; the observable contract is exercised through
 * `typeOfReceiver` chains: the head is seeded to a model class/instance and the
 * query method is the next hop.
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

/**
 * Seed a chain `svc.model.<query>` where `svc.model` resolves to the CLASS of an
 * AR model — the realistic receiver for a query method — and `Firm` is an AR
 * model via `classAncestors`. `svc` is a plain carrier bound in `localBindings`.
 */
const arModelCtx = (over: Partial<CallContext> = {}): CallContext =>
  emptyCtx({
    localBindings: { svc: [{ line: 1, type: "Svc", valueKind: "instance" }] },
    structuredReturnTypes: { "Svc#model": { form: "class", name: "Firm" } },
    classAncestors: { Firm: ["ApplicationRecord"] },
    ...over,
  });

describe("returnTypeOf AR query interface — instance-returning verbs ⇒ the model", () => {
  it("find ⇒ instance(model)", () => {
    expect(typeOfReceiver("svc.model.find", 5, arModelCtx())).toEqual({ form: "instance", name: "Firm" });
  });

  it("create! ⇒ instance(model)", () => {
    expect(typeOfReceiver("svc.model.create!", 5, arModelCtx())).toEqual({ form: "instance", name: "Firm" });
  });
});

describe("returnTypeOf AR query interface — relation-returning verbs ⇒ container(model)", () => {
  it("where ⇒ container(model)", () => {
    expect(typeOfReceiver("svc.model.where", 5, arModelCtx())).toEqual({
      form: "container",
      element: { form: "instance", name: "Firm" },
    });
  });

  it("order ⇒ container(model)", () => {
    expect(typeOfReceiver("svc.model.order", 5, arModelCtx())).toEqual({
      form: "container",
      element: { form: "instance", name: "Firm" },
    });
  });
});

describe("returnTypeOf AR query interface — dynamic finder prefix (find_by_<attr>)", () => {
  it("find_by_email ⇒ instance(model)", () => {
    expect(typeOfReceiver("svc.model.find_by_email", 5, arModelCtx())).toEqual({ form: "instance", name: "Firm" });
  });

  it("find_by_email! ⇒ instance(model)", () => {
    expect(typeOfReceiver("svc.model.find_by_email!", 5, arModelCtx())).toEqual({ form: "instance", name: "Firm" });
  });
});

describe("returnTypeOf AR query interface — is-AR-model gate (transitive)", () => {
  it("matches through a MULTI-HOP ancestry (Firm → AbstractModel → ApplicationRecord)", () => {
    const ctx = arModelCtx({
      classAncestors: { Firm: ["AbstractModel"], AbstractModel: ["ApplicationRecord"] },
    });
    expect(typeOfReceiver("svc.model.where", 5, ctx)).toEqual({
      form: "container",
      element: { form: "instance", name: "Firm" },
    });
  });

  it("matches a direct ActiveRecord::Base superclass", () => {
    const ctx = arModelCtx({ classAncestors: { Firm: ["ActiveRecord::Base"] } });
    expect(typeOfReceiver("svc.model.find", 5, ctx)).toEqual({ form: "instance", name: "Firm" });
  });

  it("a NON-model class defining `find` must NOT be typed by the vocabulary", () => {
    const ctx = arModelCtx({
      structuredReturnTypes: { "Svc#model": { form: "class", name: "Widget" } },
      classAncestors: { Widget: ["SomeService"] },
    });
    expect(typeOfReceiver("svc.model.find", 5, ctx)).toBeUndefined();
  });
});

describe("returnTypeOf AR query interface — declared fact beats vocabulary", () => {
  it("a declared structuredReturnTypes for the same key wins over the relation vocabulary", () => {
    const ctx = arModelCtx({
      structuredReturnTypes: {
        "Svc#model": { form: "class", name: "Firm" },
        "Firm#where": { form: "instance", name: "CustomScopeResult" },
      },
    });
    expect(typeOfReceiver("svc.model.where", 5, ctx)).toEqual({ form: "instance", name: "CustomScopeResult" });
  });
});
