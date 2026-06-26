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
