import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubyArRelationGuardSymbolResolutionStrategy,
  RubyBareCallSymbolResolutionStrategy,
  RubyConstantSymbolResolutionStrategy,
  RubyExplicitRequireSymbolResolutionStrategy,
  RubyIvarFieldSymbolResolutionStrategy,
  RubyLocalTypeSymbolResolutionStrategy,
  RubyReceiverSetDropSymbolResolutionStrategy,
  RubyReturnTypeBindingSymbolResolutionStrategy,
  RubySuperSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { receiverIsIndexAccess } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/shared.js";
import {
  SUPER_RECEIVER_SENTINEL,
  ZEITWERK_PREFIX,
} from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

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
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  ...over,
});

describe("RubySuperSymbolResolutionStrategy", () => {
  const strat = new RubySuperSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "super", receiver: SUPER_RECEIVER_SENTINEL, member: "save", startLine: 1 };

  it("continues when the receiver is not the super sentinel", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: "obj" }, ctx({ symbolTable, callerScope: ["Child"] }));
    expect(outcome.kind).toBe("continue");
  });

  it("DROPS when callerScope is empty (super outside a class) — guard", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable, callerScope: [] }));
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS when the enclosing class has no classAncestors entry — bug jsa0/lttd guard", () => {
    const symbolTable = tableWith(["app/child.rb", [sym("Child#save", "save", "app/child.rb", ["Child"])]]);
    // `super`/`zsuper` with no resolvable ancestor must DROP, never fall through
    // to the bare-call fallback that would fabricate a self-loop edge.
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "app/child.rb", callerScope: ["Child"] }));
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS when the only ancestor resolves to no known file — guard", () => {
    const symbolTable = tableWith(["app/child.rb", [sym("Child#save", "save", "app/child.rb", ["Child"])]]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerFile: "app/child.rb", callerScope: ["Child"], classAncestors: { Child: ["Unknown"] } }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("resolves to the PARENT class instance method via the classAncestors chain", () => {
    const symbolTable = tableWith(
      ["app/child.rb", [sym("Child#save", "save", "app/child.rb", ["Child"])]],
      ["app/base.rb", [sym("Base", "Base", "app/base.rb", []), sym("Base#save", "save", "app/base.rb", ["Base"])]],
    );
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerFile: "app/child.rb", callerScope: ["Child"], classAncestors: { Child: ["Base"] } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.rb", targetSymbolId: "Base#save" },
    });
  });

  it("resolves to a file-only edge when the ancestor's file is known but the method is not", () => {
    const symbolTable = tableWith(
      ["app/child.rb", [sym("Child#save", "save", "app/child.rb", ["Child"])]],
      ["app/base.rb", [sym("Base", "Base", "app/base.rb", [])]],
    );
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerFile: "app/child.rb", callerScope: ["Child"], classAncestors: { Child: ["Base"] } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.rb", targetSymbolId: null },
    });
  });
});

describe("RubyLocalTypeSymbolResolutionStrategy", () => {
  const strat = new RubyLocalTypeSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "user.save", receiver: "user", member: "save", startLine: 1 };

  it("continues when the receiver is null", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: null }, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the receiver has no local binding", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });

  it("DROPS when a local binding exists but the type's file is unknown — guard", () => {
    const symbolTable = tableWith();
    // Binding present, but `User` resolves to no file → terminal DROP, never a
    // fall-through to the heuristic passes.
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { user: [{ line: 1, type: "User" }] } }));
    expect(outcome.kind).toBe("drop");
  });

  it("resolves `var.X` to the bound type's instance method", () => {
    const symbolTable = tableWith([
      "app/models/user.rb",
      [sym("User", "User", "app/models/user.rb", []), sym("User#save", "save", "app/models/user.rb", ["User"])],
    ]);
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { user: [{ line: 1, type: "User" }] } }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/user.rb", targetSymbolId: "User#save" },
    });
  });

  it("resolves to a file-only edge when the bound type's file is known but the method is not", () => {
    const symbolTable = tableWith(["app/models/user.rb", [sym("User", "User", "app/models/user.rb", [])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { user: [{ line: 1, type: "User" }] } }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/user.rb", targetSymbolId: null },
    });
  });
});

describe("RubyConstantSymbolResolutionStrategy", () => {
  const strat = new RubyConstantSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "User.find", receiver: "User", member: "find", startLine: 1 };

  it("continues when the receiver is null", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: null }, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the receiver does not look like a constant (lowercase)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: "user" }, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the constant cannot be resolved to a file", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });

  it("resolves `Const.method` to the class-form (`.`) symbol", () => {
    const symbolTable = tableWith([
      "app/models/user.rb",
      [sym("User", "User", "app/models/user.rb", []), sym("User.find", "find", "app/models/user.rb", ["User"])],
    ]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/user.rb", targetSymbolId: "User.find" },
    });
  });

  it("resolves to a file-only edge when the constant's file is known but the method is not", () => {
    const symbolTable = tableWith(["app/models/user.rb", [sym("User", "User", "app/models/user.rb", [])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/user.rb", targetSymbolId: null },
    });
  });

  it("walks classAncestors for an inherited class method", () => {
    const symbolTable = tableWith(
      ["app/policies/product_policy.rb", [sym("ProductPolicy", "ProductPolicy", "app/policies/product_policy.rb", [])]],
      [
        "app/policies/abstract_policy.rb",
        [
          sym("AbstractPolicy", "AbstractPolicy", "app/policies/abstract_policy.rb", []),
          sym("AbstractPolicy.authorize!", "authorize!", "app/policies/abstract_policy.rb", ["AbstractPolicy"]),
        ],
      ],
    );
    const outcome = strat.attempt(
      { callText: "ProductPolicy.authorize!", receiver: "ProductPolicy", member: "authorize!", startLine: 1 },
      ctx({ symbolTable, classAncestors: { ProductPolicy: ["AbstractPolicy"] } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/policies/abstract_policy.rb", targetSymbolId: "AbstractPolicy.authorize!" },
    });
  });
});

describe("RubyExplicitRequireSymbolResolutionStrategy", () => {
  const strat = new RubyExplicitRequireSymbolResolutionStrategy(cfg);

  it("continues when the receiver is null (bare call must not enter — bug jsa0)", () => {
    const symbolTable = tableWith(["lib/foo.rb", [sym("foo", "foo", "lib/foo.rb", [])]]);
    const outcome = strat.attempt(
      { callText: "bar()", receiver: null, member: "bar", startLine: 1 },
      ctx({ symbolTable, imports: [{ importText: "foo", startLine: 1 }] }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when no import matches the receiver", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "foo.bar", receiver: "foo", member: "bar", startLine: 1 },
      ctx({ symbolTable, imports: [{ importText: "baz", startLine: 1 }] }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("skips Zeitwerk-prefixed imports", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "User.bar", receiver: "User", member: "bar", startLine: 1 },
      ctx({ symbolTable, imports: [{ importText: `${ZEITWERK_PREFIX}User`, startLine: 1 }] }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("resolves a bare `require 'foo'` receiver to the matched file's member", () => {
    const symbolTable = tableWith(["lib/foo.rb", [sym("foo.bar", "bar", "lib/foo.rb", ["foo"])]]);
    const outcome = strat.attempt(
      { callText: "foo.bar", receiver: "foo", member: "bar", startLine: 1 },
      // knownPaths is built from non-Zeitwerk import texts + caller file; the
      // basename match needs the `lib/foo.rb` path to be present, so the caller
      // file (the local set) supplies it.
      ctx({ symbolTable, callerFile: "lib/foo.rb", imports: [{ importText: "foo", startLine: 1 }] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "lib/foo.rb", targetSymbolId: "foo.bar" },
    });
  });

  it("resolves a `require_relative './foo'` receiver against the caller's directory (file-only)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "foo.bar", receiver: "foo", member: "bar", startLine: 1 },
      ctx({ symbolTable, callerFile: "lib/app.rb", imports: [{ importText: "./foo", startLine: 1 }] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "lib/foo.rb", targetSymbolId: null },
    });
  });
});

describe("RubyArRelationGuardSymbolResolutionStrategy", () => {
  const strat = new RubyArRelationGuardSymbolResolutionStrategy(cfg);

  it("DROPS when the receiver text is an AR::Relation chain — guard", () => {
    const symbolTable = tableWith();
    // `Product.where(active: true).result` → receiver is a Relation, not a class.
    const outcome = strat.attempt(
      {
        callText: "Product.where(active: true).result",
        receiver: "Product.where(active: true)",
        member: "result",
        startLine: 1,
      },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("continues when the receiver is null", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "bar()", receiver: null, member: "bar", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the receiver is not an AR relation chain", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "user.save", receiver: "user", member: "save", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("continue");
  });
});

describe("RubyReceiverSetDropSymbolResolutionStrategy", () => {
  const strat = new RubyReceiverSetDropSymbolResolutionStrategy(cfg);

  it("DROPS any remaining receiver-set call (unknown dynamic type) — bug lttd guard", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "serializer.is_valid", receiver: "serializer", member: "is_valid", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("continues when the receiver is null (bare call defers to the fallback)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "bar()", receiver: null, member: "bar", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("continue");
  });
});

describe("RubyBareCallSymbolResolutionStrategy", () => {
  const strat = new RubyBareCallSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "helper()", receiver: null, member: "helper", startLine: 1 };

  it("resolves a unique ruby-path global short-name", () => {
    const symbolTable = tableWith(["lib/helpers.rb", [sym("helper", "helper", "lib/helpers.rb", [])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "lib/helpers.rb", targetSymbolId: "helper" },
    });
  });

  it("filters out non-ruby file candidates (cross-language pollution — bug pl7k)", () => {
    const symbolTable = tableWith([
      "vendor/assets/javascripts/d3.js",
      [sym("map", "map", "vendor/assets/javascripts/d3.js", [])],
    ]);
    const outcome = strat.attempt({ ...call, member: "map" }, ctx({ symbolTable }));
    // The only candidate is a JS file → filtered out → no resolution → continue.
    expect(outcome.kind).toBe("continue");
  });

  it("prefers the same-enclosing-class candidate when the short-name is ambiguous (bug t5iw)", () => {
    const symbolTable = tableWith(
      [
        "app/concerns/web_request_concern.rb",
        [
          sym("WebRequestConcern#user_agent", "user_agent", "app/concerns/web_request_concern.rb", [
            "WebRequestConcern",
          ]),
        ],
      ],
      [
        "app/agents/phantom_js_cloud_agent.rb",
        [
          sym("Agents::PhantomJsCloudAgent#user_agent", "user_agent", "app/agents/phantom_js_cloud_agent.rb", [
            "PhantomJsCloudAgent",
          ]),
        ],
      ],
    );
    const outcome = strat.attempt(
      { callText: "user_agent", receiver: null, member: "user_agent", startLine: 1 },
      ctx({ symbolTable, callerScope: ["Agents", "PhantomJsCloudAgent"] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "app/agents/phantom_js_cloud_agent.rb",
        targetSymbolId: "Agents::PhantomJsCloudAgent#user_agent",
      },
    });
  });

  it("continues (strict) when the short-name is ambiguous and not narrowable", () => {
    const symbolTable = tableWith(
      ["app/a.rb", [sym("A#helper", "helper", "app/a.rb", ["A"])]],
      ["app/b.rb", [sym("B#helper", "helper", "app/b.rb", ["B"])]],
    );
    const outcome = strat.attempt(call, ctx({ symbolTable, callerScope: ["C"] }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when no candidate matches the short-name", () => {
    const symbolTable = tableWith(["lib/other.rb", [sym("other", "other", "lib/other.rb", [])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });

  it("resolves an ambiguous short-name to the SUPERCLASS method via the MRO chain (brp1)", () => {
    // Child does NOT own `notify`; Parent (in classAncestors) does, and an
    // unrelated Other#notify collides on the short name. Before brp1 the
    // direct-enclosing narrowing found nothing on Child and the edge dropped.
    const symbolTable = tableWith(
      ["app/parent.rb", [sym("Parent#notify", "notify", "app/parent.rb", ["Parent"])]],
      ["app/other.rb", [sym("Other#notify", "notify", "app/other.rb", ["Other"])]],
    );
    const outcome = strat.attempt(
      { callText: "notify", receiver: null, member: "notify", startLine: 1 },
      ctx({ symbolTable, callerScope: ["Child"], classAncestors: { Child: ["Parent"] } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/parent.rb", targetSymbolId: "Parent#notify" },
    });
  });

  it("prefers the NEAREST ancestor when the short-name is on both Parent and Grandparent (brp1)", () => {
    const symbolTable = tableWith(
      ["app/parent.rb", [sym("Parent#render", "render", "app/parent.rb", ["Parent"])]],
      ["app/grandparent.rb", [sym("Grandparent#render", "render", "app/grandparent.rb", ["Grandparent"])]],
    );
    const outcome = strat.attempt(
      { callText: "render", receiver: null, member: "render", startLine: 1 },
      ctx({ symbolTable, callerScope: ["Child"], classAncestors: { Child: ["Parent", "Grandparent"] } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/parent.rb", targetSymbolId: "Parent#render" },
    });
  });

  it("continues when no candidate's class is in the MRO chain (true cross-class collision — brp1)", () => {
    const symbolTable = tableWith(
      ["app/foo.rb", [sym("Foo#perform", "perform", "app/foo.rb", ["Foo"])]],
      ["app/bar.rb", [sym("Bar#perform", "perform", "app/bar.rb", ["Bar"])]],
    );
    const outcome = strat.attempt(
      { callText: "perform", receiver: null, member: "perform", startLine: 1 },
      ctx({ symbolTable, callerScope: ["Child"], classAncestors: { Child: ["Parent"] } }),
    );
    expect(outcome.kind).toBe("continue");
  });
});

describe("RubyIvarFieldSymbolResolutionStrategy", () => {
  const strat = new RubyIvarFieldSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "@client.get", receiver: "@client", member: "get", startLine: 1 };

  it("resolves @ivar.X via the recorded field type", () => {
    const symbolTable = tableWith([
      "app/clients/http_client.rb",
      [
        sym("HttpClient", "HttpClient", "app/clients/http_client.rb", []),
        sym("HttpClient#get", "get", "app/clients/http_client.rb", ["HttpClient"]),
      ],
    ]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerScope: ["Foo"], classFieldTypes: { Foo: { "@client": "HttpClient" } } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/clients/http_client.rb", targetSymbolId: "HttpClient#get" },
    });
  });

  it("resolves to a file-only edge when the type's file is known but the method is not", () => {
    const symbolTable = tableWith([
      "app/clients/http_client.rb",
      [sym("HttpClient", "HttpClient", "app/clients/http_client.rb", [])],
    ]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerScope: ["Foo"], classFieldTypes: { Foo: { "@client": "HttpClient" } } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/clients/http_client.rb", targetSymbolId: null },
    });
  });

  it("DROPS when the ivar has no recorded type — never falls through", () => {
    const symbolTable = tableWith(["other.rb", [sym("Other#get", "get", "other.rb", ["Other"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, callerScope: ["Foo"], classFieldTypes: { Foo: {} } }));
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS when the recorded type is a gem (no project file) — routes to external, not resolved", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { ...call, receiver: "@http", member: "get" },
      ctx({ symbolTable, callerScope: ["Foo"], classFieldTypes: { Foo: { "@http": "Net::HTTP" } } }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("continues when the receiver is not a single ivar (chained @a.b)", () => {
    const outcome = strat.attempt(
      { ...call, receiver: "@a.b" },
      ctx({ symbolTable: tableWith(), callerScope: ["Foo"], classFieldTypes: { Foo: { "@a": "A" } } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues outside a class scope (callerScope empty)", () => {
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable: tableWith(), classFieldTypes: { Foo: { "@client": "HttpClient" } } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the receiver is not an ivar", () => {
    const outcome = strat.attempt(
      { ...call, receiver: "user" },
      ctx({ symbolTable: tableWith(), callerScope: ["Foo"], classFieldTypes: { Foo: { "@client": "HttpClient" } } }),
    );
    expect(outcome.kind).toBe("continue");
  });
});

describe("RubyReturnTypeBindingSymbolResolutionStrategy", () => {
  const strat = new RubyReturnTypeBindingSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "x.get", receiver: "x", member: "get", startLine: 1 };

  it("continues when the call has no receiver", () => {
    const outcome = strat.attempt({ ...call, receiver: null }, ctx({ symbolTable: tableWith() }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the receiver has no localCallBinding", () => {
    const outcome = strat.attempt(call, ctx({ symbolTable: tableWith(), localCallBindings: {} }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the called method has no recorded return type", () => {
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable: tableWith(), localCallBindings: { x: "make_client" }, functionReturnTypes: {} }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the return type resolves to no project file (gem/stdlib — additive, never DROP)", () => {
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable: tableWith(),
        localCallBindings: { x: "make_client" },
        functionReturnTypes: { make_client: "Net::HTTP" },
      }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("resolves x→make_client→HttpClient#get when the return type is an in-project class", () => {
    const symbolTable = tableWith([
      "app/clients/http_client.rb",
      [
        sym("HttpClient", "HttpClient", "app/clients/http_client.rb", []),
        sym("HttpClient#get", "get", "app/clients/http_client.rb", ["HttpClient"]),
      ],
    ]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, localCallBindings: { x: "make_client" }, functionReturnTypes: { make_client: "HttpClient" } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/clients/http_client.rb", targetSymbolId: "HttpClient#get" },
    });
  });

  it("resolves to a file-only edge when the return type's file is known but the method is not", () => {
    const symbolTable = tableWith([
      "app/clients/http_client.rb",
      [sym("HttpClient", "HttpClient", "app/clients/http_client.rb", [])],
    ]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, localCallBindings: { x: "make_client" }, functionReturnTypes: { make_client: "HttpClient" } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/clients/http_client.rb", targetSymbolId: null },
    });
  });
});

describe("receiverIsIndexAccess (mktkk increment A)", () => {
  it("is true when the receiver's outermost op is an element reference", () => {
    expect(receiverIsIndexAccess("options['subject']")).toBe(true);
    expect(receiverIsIndexAccess("payload[key]")).toBe(true);
    expect(receiverIsIndexAccess("arr[i]")).toBe(true);
    expect(receiverIsIndexAccess("context.registers[:agent]")).toBe(true); // outermost is [:agent]
    expect(receiverIsIndexAccess("[1, 2, 3]")).toBe(true); // array literal receiver
  });

  it("is false for chain / bare / constant receivers (deferred to increment B)", () => {
    expect(receiverIsIndexAccess("event.user")).toBe(false); // chain
    expect(receiverIsIndexAccess("a[0].b")).toBe(false); // outermost op is .b, not index
    expect(receiverIsIndexAccess("obj")).toBe(false); // bare identifier
    expect(receiverIsIndexAccess("User")).toBe(false); // constant
    expect(receiverIsIndexAccess("@client")).toBe(false); // ivar
  });
});
