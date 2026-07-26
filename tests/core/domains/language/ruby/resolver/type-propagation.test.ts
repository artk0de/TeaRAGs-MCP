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
