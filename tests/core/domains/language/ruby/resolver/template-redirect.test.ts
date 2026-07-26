/**
 * bd tea-rags-mcp — DEFECT 2 (self-receiver abstract-hook dispatch), G4 v3.
 * Spec: docs/superpowers/specs/2026-07-10-instance-template-redirect-design.md.
 *
 * The central post-resolution redirect: after the strategy chain resolves a call
 * to a shared self-dispatch template node (`KindOfService#call`, a key of
 * `ctx.selfDispatchTemplates` with hook `perform`), a CONCRETE receiver type
 * (from the exact sources the strategies already consult — `localBindings`,
 * `ivarTypes`, chain propagation) narrows the abstract hook to the entry's own
 * concrete `Type#perform`. The edge stays entry-anchored
 * (`enclosing(service.call) → Create#perform`).
 *
 * Strictly ADDITIVE refinement: ANY miss (untyped receiver, hook not defined on
 * the concrete type, non-template target, the template's own abstract type)
 * keeps the ORIGINAL resolved target unchanged — never drop, never fabricate a
 * file-only edge. v1/v2 constant-entry narrowing is unaffected (a constant entry
 * already resolves to `Const#perform`, which is not a template key).
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
  type SymbolResolutionTarget,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { redirectSelfDispatchTemplate } from "../../../../../../src/core/domains/language/ruby/resolver/template-redirect.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const MODE = DEFAULT_AMBIGUOUS_RESOLVE_MODE;

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "app/controllers/things_controller.rb",
  callerScope: ["ThingsController"],
  imports: [],
  ...over,
});

// The instance-form self-dispatch template shape: `KindOfService#call` self-calls
// the abstract `perform` hook; `KindOfService` never defines `perform`, the
// concrete subtype `Create` does. The strategy chain resolves a typed-instance
// receiver call (`service.call`, `service : Create`) to the INHERITED template
// `KindOfService#call` — the redirect narrows it to `Create#perform`.
const KOS_FILE = "app/services/kind_of_service.rb";
const CREATE_FILE = "app/services/create.rb";
const WIDGET_FILE = "app/models/widget.rb";

const serviceTable = (): InMemoryGlobalSymbolTable =>
  tableWith(
    [
      KOS_FILE,
      [
        sym("KindOfService", "KindOfService", KOS_FILE, []),
        sym("KindOfService#call", "call", KOS_FILE, ["KindOfService"]),
      ],
    ],
    [CREATE_FILE, [sym("Create", "Create", CREATE_FILE, []), sym("Create#perform", "perform", CREATE_FILE, ["Create"])]],
    // Widget is a concrete type that does NOT define `perform` (hook-missing case).
    [WIDGET_FILE, [sym("Widget", "Widget", WIDGET_FILE, [])]],
  );

// The resolved target the strategy chain produces for a typed-instance receiver
// call whose static type inherits the template: the shared template NODE itself.
const TEMPLATE_TARGET: SymbolResolutionTarget = { targetRelPath: KOS_FILE, targetSymbolId: "KindOfService#call" };

const serviceCtx = (over: Partial<CallContext> = {}): CallContext =>
  ctx({
    symbolTable: serviceTable(),
    classAncestors: { Create: ["KindOfService"], Widget: [] },
    selfDispatchTemplates: { "KindOfService#call": "perform" },
    ...over,
  });

const callWith = (receiver: string | null): CallRef => ({
  callText: `${receiver ?? ""}.call`,
  receiver,
  member: "call",
  startLine: 5,
});

describe("redirectSelfDispatchTemplate (DEFECT 2 G4 — instance-rooted template redirect)", () => {
  it("localVar-typed receiver → narrows the template edge to the entry's concrete `Create#perform`", () => {
    const c = serviceCtx({ localBindings: { service: [{ line: 1, type: "Create", valueKind: "instance" }] } });
    const out = redirectSelfDispatchTemplate(TEMPLATE_TARGET, callWith("service"), c, MODE);
    expect(out).toEqual({ targetRelPath: CREATE_FILE, targetSymbolId: "Create#perform" });
  });

  it("ivar-typed receiver → narrows the template edge to `Create#perform`", () => {
    const c = serviceCtx({
      callerScope: ["ThingsController"],
      ivarTypes: { ThingsController: { "@svc": "Create" } },
    });
    const out = redirectSelfDispatchTemplate(TEMPLATE_TARGET, callWith("@svc"), c, MODE);
    expect(out).toEqual({ targetRelPath: CREATE_FILE, targetSymbolId: "Create#perform" });
  });

  it("chain-typed receiver (propagation engine) → narrows the template edge to `Create#perform`", () => {
    // `builder.build` : builder = Builder, Builder#build returns a Create instance.
    const c = serviceCtx({
      localBindings: { builder: [{ line: 1, type: "Builder", valueKind: "instance" }] },
      structuredReturnTypes: { "Builder#build": { form: "instance", name: "Create" } },
    });
    const out = redirectSelfDispatchTemplate(TEMPLATE_TARGET, callWith("builder.build"), c, MODE);
    expect(out).toEqual({ targetRelPath: CREATE_FILE, targetSymbolId: "Create#perform" });
  });

  it("untyped receiver → keeps the ORIGINAL template target (no inference, no drop)", () => {
    const c = serviceCtx(); // `mystery` has no binding → typeOfReceiver undefined
    const out = redirectSelfDispatchTemplate(TEMPLATE_TARGET, callWith("mystery"), c, MODE);
    expect(out).toBe(TEMPLATE_TARGET);
  });

  it("hook not defined on the concrete receiver type → keeps the ORIGINAL template target", () => {
    // `widget : Widget`; Widget resolves to a file but defines no `perform` and
    // has no ancestor that does → resolveTypeInstanceMethod is file-only → keep.
    const c = serviceCtx({ localBindings: { widget: [{ line: 1, type: "Widget", valueKind: "instance" }] } });
    const out = redirectSelfDispatchTemplate(TEMPLATE_TARGET, callWith("widget"), c, MODE);
    expect(out).toBe(TEMPLATE_TARGET);
  });

  it("never returns a file-only edge — a hook-miss preserves the method-level original", () => {
    const c = serviceCtx({ localBindings: { widget: [{ line: 1, type: "Widget", valueKind: "instance" }] } });
    const out = redirectSelfDispatchTemplate(TEMPLATE_TARGET, callWith("widget"), c, MODE);
    expect(out.targetSymbolId).not.toBeNull();
    expect(out.targetSymbolId).toBe("KindOfService#call");
  });

  it("non-template resolved target → returned untouched even with a typed receiver", () => {
    const nonTemplate: SymbolResolutionTarget = { targetRelPath: "app/foo.rb", targetSymbolId: "Foo#bar" };
    const c = serviceCtx({ localBindings: { service: [{ line: 1, type: "Create", valueKind: "instance" }] } });
    const out = redirectSelfDispatchTemplate(nonTemplate, callWith("service"), c, MODE);
    expect(out).toBe(nonTemplate);
  });

  it("file-only resolved target (targetSymbolId null) → returned untouched", () => {
    const fileOnly: SymbolResolutionTarget = { targetRelPath: KOS_FILE, targetSymbolId: null };
    const c = serviceCtx({ localBindings: { service: [{ line: 1, type: "Create", valueKind: "instance" }] } });
    const out = redirectSelfDispatchTemplate(fileOnly, callWith("service"), c, MODE);
    expect(out).toBe(fileOnly);
  });

  it("receiver typed as the template's OWN abstract type → NOT redirected (keeps original)", () => {
    // `base : KindOfService` — the template's own enclosing type; no concrete
    // subtype narrowing is possible, so the abstract template edge stays.
    const c = serviceCtx({ localBindings: { base: [{ line: 1, type: "KindOfService", valueKind: "instance" }] } });
    const out = redirectSelfDispatchTemplate(TEMPLATE_TARGET, callWith("base"), c, MODE);
    expect(out).toBe(TEMPLATE_TARGET);
  });

  it("feature off (no selfDispatchTemplates map) → returns the target unchanged", () => {
    const c = ctx({ symbolTable: serviceTable(), localBindings: { service: [{ line: 1, type: "Create" }] } });
    const out = redirectSelfDispatchTemplate(TEMPLATE_TARGET, callWith("service"), c, MODE);
    expect(out).toBe(TEMPLATE_TARGET);
  });

  it("receiverless (null receiver) resolved template target → returns unchanged", () => {
    const out = redirectSelfDispatchTemplate(TEMPLATE_TARGET, callWith(null), serviceCtx(), MODE);
    expect(out).toBe(TEMPLATE_TARGET);
  });
});
