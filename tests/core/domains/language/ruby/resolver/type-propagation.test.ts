import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  boundCallReturnType,
  returnTypeOf,
  typeOfReceiver,
} from "../../../../../../src/core/domains/language/ruby/resolver/type-propagation.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const emptyCtx = (over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
  ...over,
});

// ── Local-binding resolution ────────────────────────────────────────────────

describe("typeOfReceiver — local var instance binding", () => {
  it("returns instance form when var=ClassName.new binding exists at or before atLine", () => {
    const ctx = emptyCtx({
      localBindings: {
        user: [{ line: 5, type: "User", valueKind: "instance" }],
      },
    });
    expect(typeOfReceiver("user", 10, ctx)).toEqual({ form: "instance", name: "User" });
  });

  it("defaults valueKind to instance when absent", () => {
    const ctx = emptyCtx({
      localBindings: {
        post: [{ line: 3, type: "Post" }],
      },
    });
    expect(typeOfReceiver("post", 5, ctx)).toEqual({ form: "instance", name: "Post" });
  });

  it("returns class form when var=ClassName binding has valueKind=class", () => {
    const ctx = emptyCtx({
      localBindings: {
        klass: [{ line: 2, type: "User", valueKind: "class" }],
      },
    });
    expect(typeOfReceiver("klass", 4, ctx)).toEqual({ form: "class", name: "User" });
  });

  it("returns undefined when binding exists only AFTER atLine", () => {
    const ctx = emptyCtx({
      localBindings: {
        user: [{ line: 20, type: "User" }],
      },
    });
    expect(typeOfReceiver("user", 10, ctx)).toBeUndefined();
  });

  it("returns undefined when receiver has no binding", () => {
    const ctx = emptyCtx({ localBindings: {} });
    expect(typeOfReceiver("unbound", 10, ctx)).toBeUndefined();
  });
});

// ── Const.new-chain head seed (rvw34 gap b) ──────────────────────────────────

describe("typeOfReceiver — Const.new-chain head seed (rvw34 gap b)", () => {
  it("seeds Const.new as an instance of Const", () => {
    expect(typeOfReceiver("PostStatusService.new", 1, emptyCtx())).toEqual({
      form: "instance",
      name: "PostStatusService",
    });
  });

  it("seeds Const.new(args) (strips trailing arg list)", () => {
    expect(typeOfReceiver("PostStatusService.new(post)", 1, emptyCtx())).toEqual({
      form: "instance",
      name: "PostStatusService",
    });
  });

  it("threads a member after the new-seed via structuredReturnTypes", () => {
    const ctx = emptyCtx({ structuredReturnTypes: { "PostStatusService#call": { form: "instance", name: "Status" } } });
    expect(typeOfReceiver("PostStatusService.new.call", 1, ctx)).toEqual({ form: "instance", name: "Status" });
  });

  it("does NOT type a bare-const head with a non-instance-returning first link", () => {
    expect(typeOfReceiver("Config.value", 1, emptyCtx())).toBeUndefined();
  });

  it("seeds a scoped const head (A::B.new) as instance of A::B", () => {
    expect(typeOfReceiver("Mod::Svc.new", 1, emptyCtx())).toEqual({ form: "instance", name: "Mod::Svc" });
  });
});

// ── Const-rooted CUSTOM-scope chains (bd tea-rags-mcp-6zpds) ─────────────────
//
// `scope :without_deleted` is NOT in the generic AR query vocabulary, so the
// const-head seed can only type `Owner.without_deleted.find(id)` by consulting
// the DECLARED fact the association type source already emits for the scope
// (`structuredReturnTypes["Owner#without_deleted"] → container(Owner)`).
// Declared facts are consulted FIRST; the vocabulary seed stays the fallback.

describe("typeOfReceiver — const head typed by a DECLARED fact (bd tea-rags-mcp-6zpds)", () => {
  const scopeFact = {
    "Owner#without_deleted": { form: "container" as const, element: { form: "instance" as const, name: "Owner" } },
  };

  it("types a chain through a declared custom scope on the root constant", () => {
    const ctx = emptyCtx({ structuredReturnTypes: scopeFact });
    expect(typeOfReceiver("Owner.without_deleted.find(id)", 1, ctx)).toEqual({ form: "instance", name: "Owner" });
  });

  it("types the scope call itself as the declared relation (no terminal finder)", () => {
    const ctx = emptyCtx({ structuredReturnTypes: scopeFact });
    expect(typeOfReceiver("Owner.without_deleted", 1, ctx)).toEqual({
      form: "container",
      element: { form: "instance", name: "Owner" },
    });
  });

  it("reaches a scope declared on an ANCESTOR of the root constant (MRO, no duplication)", () => {
    const ctx = emptyCtx({
      classAncestors: { Owner: ["SoftDeletable"] },
      structuredReturnTypes: {
        "SoftDeletable#without_deleted": { form: "container", element: { form: "instance", name: "Owner" } },
      },
    });
    expect(typeOfReceiver("Owner.without_deleted.find", 1, ctx)).toEqual({ form: "instance", name: "Owner" });
  });

  it("prefers the CLASS-form coordinate for a class receiver, falling back to the instance one", () => {
    // `Svc.call` and `Svc#call` are different methods (bd tea-rags-mcp-8ypeu):
    // a `@!method self.call` fact lands on `Svc.call` and must win for the class
    // receiver without disturbing the instance coordinate.
    const ctx = emptyCtx({
      structuredReturnTypes: {
        "Svc.call": { form: "instance", name: "ServiceResult" },
        "Svc#call": { form: "instance", name: "InstanceOnly" },
      },
    });
    expect(typeOfReceiver("Svc.call(x)", 1, ctx)).toEqual({ form: "instance", name: "ServiceResult" });
  });

  it("still returns undefined for an UNDECLARED method on a constant (no heuristic)", () => {
    const ctx = emptyCtx({ structuredReturnTypes: scopeFact });
    expect(typeOfReceiver("Owner.mystery_scope.find(id)", 1, ctx)).toBeUndefined();
  });

  it("leaves the generic vocabulary seed unchanged when no fact is declared", () => {
    expect(typeOfReceiver("PostStatusService.new.call", 1, emptyCtx())).toBeUndefined();
    expect(typeOfReceiver("PostStatusService.new", 1, emptyCtx())).toEqual({
      form: "instance",
      name: "PostStatusService",
    });
  });
});

// ── @ivar resolution ─────────────────────────────────────────────────────────

describe("typeOfReceiver — @ivar via classFieldTypes", () => {
  it("resolves @ivar from classFieldTypes when ivarTypes is absent", () => {
    const ctx = emptyCtx({
      callerScope: ["AccountsController"],
      classFieldTypes: {
        AccountsController: { "@account": "Account" },
      },
    });
    expect(typeOfReceiver("@account", 10, ctx)).toEqual({ form: "instance", name: "Account" });
  });

  it("returns undefined when callerScope is empty (no enclosing class key)", () => {
    const ctx = emptyCtx({
      callerScope: [],
      classFieldTypes: {
        AccountsController: { "@account": "Account" },
      },
    });
    expect(typeOfReceiver("@account", 10, ctx)).toBeUndefined();
  });

  it("returns undefined when ivar not recorded in classFieldTypes", () => {
    const ctx = emptyCtx({
      callerScope: ["SomeClass"],
      classFieldTypes: { SomeClass: { "@other": "Other" } },
    });
    expect(typeOfReceiver("@missing", 10, ctx)).toBeUndefined();
  });
});

describe("typeOfReceiver — @ivar with ivarTypes wins over classFieldTypes", () => {
  it("prefers ivarTypes over classFieldTypes when both present", () => {
    const ctx = emptyCtx({
      callerScope: ["PostsController"],
      classFieldTypes: {
        PostsController: { "@post": "OldPost" },
      },
      ivarTypes: {
        PostsController: { "@post": "NewPost" },
      },
    });
    expect(typeOfReceiver("@post", 10, ctx)).toEqual({ form: "instance", name: "NewPost" });
  });

  it("falls back to classFieldTypes when ivarTypes has no entry for the ivar", () => {
    const ctx = emptyCtx({
      callerScope: ["PostsController"],
      classFieldTypes: {
        PostsController: { "@post": "Post" },
      },
      ivarTypes: {
        PostsController: { "@other": "Other" },
      },
    });
    expect(typeOfReceiver("@post", 10, ctx)).toEqual({ form: "instance", name: "Post" });
  });
});

// ── Dotted chain receiver ────────────────────────────────────────────────────

describe("typeOfReceiver — dotted chain receiver deferred to Task 1.4", () => {
  it("returns undefined for a.b (Task 1.4 adds threading)", () => {
    const ctx = emptyCtx();
    expect(typeOfReceiver("a.b", 10, ctx)).toBeUndefined();
  });

  it("returns undefined for deeply chained receiver", () => {
    const ctx = emptyCtx();
    expect(typeOfReceiver("a.b.c", 10, ctx)).toBeUndefined();
  });
});

// ── Constants / self / super / unknown ───────────────────────────────────────

describe("typeOfReceiver — non-propagatable receiver forms", () => {
  it("returns undefined for a capitalized constant", () => {
    expect(typeOfReceiver("User", 10, emptyCtx())).toBeUndefined();
  });

  it("returns undefined for self", () => {
    expect(typeOfReceiver("self", 10, emptyCtx())).toBeUndefined();
  });

  it("returns undefined for super", () => {
    expect(typeOfReceiver("super", 10, emptyCtx())).toBeUndefined();
  });

  it("returns undefined for index-access receiver arr[0]", () => {
    expect(typeOfReceiver("arr[0]", 10, emptyCtx())).toBeUndefined();
  });
});

// ── returnTypeOf — the ONE return-type authority (j9xpf) ─────────────────────

describe("returnTypeOf — channel precedence and receiver-form scoping", () => {
  it("the structured fact at the exact coordinate wins", () => {
    const ctx = emptyCtx({ structuredReturnTypes: { "Svc#call": { form: "instance", name: "Result" } } });
    expect(returnTypeOf({ form: "class", name: "Svc" }, "call", ctx)).toEqual({ form: "instance", name: "Result" });
  });

  it("falls back to an inherited fact through the ancestor MRO", () => {
    const ctx = emptyCtx({
      classAncestors: { Svc: ["KindOfService"] },
      structuredReturnTypes: { "KindOfService#call": { form: "instance", name: "Result" } },
    });
    expect(returnTypeOf({ form: "class", name: "Svc" }, "call", ctx)).toEqual({ form: "instance", name: "Result" });
  });

  it("a Rails association accessor types an INSTANCE receiver", () => {
    const ctx = emptyCtx({ associationTypes: { Client: { firm: "Firm" } } });
    expect(returnTypeOf({ form: "instance", name: "Client" }, "firm", ctx)).toEqual({ form: "instance", name: "Firm" });
  });

  it("a Rails association accessor does NOT type a CLASS receiver — `belongs_to` defines an instance method", () => {
    const ctx = emptyCtx({
      associationTypes: { Client: { firm: "Firm" } },
      functionReturnTypes: { firm: "FirmScope" },
    });
    // Must fall through to the flat channel, not borrow the instance accessor.
    expect(returnTypeOf({ form: "class", name: "Client" }, "firm", ctx)).toEqual({
      form: "instance",
      name: "FirmScope",
    });
  });

  it("returns undefined when no channel knows the member", () => {
    expect(returnTypeOf({ form: "class", name: "Svc" }, "call", emptyCtx())).toBeUndefined();
  });
});

describe("boundCallReturnType — the localCallBindings channel (j9xpf)", () => {
  it("SCOPE-QUALIFIED binding resolves through the scoped channels", () => {
    const ctx = emptyCtx({
      localCallBindings: { result: "Billing::Create.call" },
      classAncestors: { "Billing::Create": ["KindOfService"] },
      structuredReturnTypes: { "KindOfService#call": { form: "instance", name: "Result" } },
    });
    expect(boundCallReturnType("result", ctx)).toEqual({ form: "instance", name: "Result" });
  });

  it("BARE binding still reads the flat, project-wide map (unchanged)", () => {
    const ctx = emptyCtx({ localCallBindings: { x: "fetch" }, functionReturnTypes: { fetch: "HttpResponse" } });
    expect(boundCallReturnType("x", ctx)).toEqual({ form: "instance", name: "HttpResponse" });
  });

  it("returns undefined for a receiver with no call binding", () => {
    expect(boundCallReturnType("x", emptyCtx())).toBeUndefined();
  });
});

// ── The flat map's ambiguity gate (bd tea-rags-mcp-h4hxh) ────────────────────
//
// `functionReturnTypes` is keyed by BARE method name with no owning class, so a
// single `# @return [Response]` on one helper types every same-named method in
// the corpus. On taxdome the map's most collided keys are the ones every Rails
// codebase reuses — `data` (244 defs), `client` (219), `authorize`, `call`.
// The fact is only trustworthy when the corpus cannot disagree about which
// method it describes: at most ONE definition of that short name.

/** Symbol table declaring `defs` definitions that all share `shortName`. */
const tableWithDefs = (shortName: string, defs: number): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  for (let i = 0; i < defs; i++) {
    const relPath = `app/models/owner_${i}.rb`;
    table.upsertFile(relPath, [
      {
        symbolId: `Owner${i}#${shortName}`,
        fqName: `Owner${i}#${shortName}`,
        shortName,
        relPath,
        scope: [`Owner${i}`],
      },
    ]);
  }
  return table;
};

describe("returnTypeOf — the flat map answers only for an unambiguous member (h4hxh)", () => {
  it("SKIPS the flat fact when the corpus defines the member on more than one class", () => {
    const ctx = emptyCtx({
      functionReturnTypes: { authorize: "Response" },
      symbolTable: tableWithDefs("authorize", 5),
    });
    expect(returnTypeOf({ form: "class", name: "ClientPolicy" }, "authorize", ctx)).toBeUndefined();
  });

  it("APPLIES the flat fact when the member has exactly one definition corpus-wide", () => {
    const ctx = emptyCtx({
      functionReturnTypes: { build_widget: "Widget" },
      symbolTable: tableWithDefs("build_widget", 1),
    });
    expect(returnTypeOf({ form: "class", name: "Factory" }, "build_widget", ctx)).toEqual({
      form: "instance",
      name: "Widget",
    });
  });

  it("APPLIES the flat fact when the symbol table knows of no definition at all", () => {
    const ctx = emptyCtx({ functionReturnTypes: { fetch: "HttpResponse" } });
    expect(returnTypeOf({ form: "class", name: "Client" }, "fetch", ctx)).toEqual({
      form: "instance",
      name: "HttpResponse",
    });
  });

  it("an ambiguous member does not block the SCOPED channels above it", () => {
    const ctx = emptyCtx({
      structuredReturnTypes: { "ClientPolicy#authorize": { form: "instance", name: "Verdict" } },
      functionReturnTypes: { authorize: "Response" },
      symbolTable: tableWithDefs("authorize", 5),
    });
    expect(returnTypeOf({ form: "instance", name: "ClientPolicy" }, "authorize", ctx)).toEqual({
      form: "instance",
      name: "Verdict",
    });
  });
});

describe("boundCallReturnType — the bare branch is deliberately NOT gated (h4hxh scope)", () => {
  // The gate exists to stop an owner-less fact from overriding a receiver whose
  // class is already known. A BARE binding has no receiver type at all, so the
  // flat map is not overriding better knowledge — it is the only knowledge, and
  // silencing it there cost 758 edges on taxdome that no oracle can convict
  // one by one. The scope boundary is a measured decision, so it is pinned.
  it("still answers for a bare binding even when the method name is multiply defined", () => {
    const ctx = emptyCtx({
      localCallBindings: { row: "data" },
      functionReturnTypes: { data: "Data" },
      symbolTable: tableWithDefs("data", 244),
    });
    expect(boundCallReturnType("row", ctx)).toEqual({ form: "instance", name: "Data" });
  });

  it("a SCOPE-QUALIFIED binding does obey the gate — its receiver class is known", () => {
    const ctx = emptyCtx({
      localCallBindings: { verdict: "ClientPolicy.authorize" },
      functionReturnTypes: { authorize: "Response" },
      symbolTable: tableWithDefs("authorize", 5),
    });
    expect(boundCallReturnType("verdict", ctx)).toBeUndefined();
  });
});
