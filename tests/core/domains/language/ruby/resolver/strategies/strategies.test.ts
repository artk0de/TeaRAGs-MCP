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
  RubyDynamicDispatchResolver,
  RubyExplicitRequireSymbolResolutionStrategy,
  RubyIvarFieldSymbolResolutionStrategy,
  RubyLocalTypeSymbolResolutionStrategy,
  RubyReceiverSetDropSymbolResolutionStrategy,
  RubyReturnTypeBindingSymbolResolutionStrategy,
  RubySuperSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import {
  receiverChainTailIsExternal,
  receiverIsIndexAccess,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/shared.js";
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

  // B-const — class-valued (var=CONST) bindings (Increment B / var=CONST)
  it("resolves `klass = User; klass.find` to the static method symbolId `User.find` (class-valued binding)", () => {
    const symbolTable = tableWith([
      "app/models/user.rb",
      [
        sym("User", "User", "app/models/user.rb", []),
        sym("User.find", "find", "app/models/user.rb", ["User"]),
        sym("User#find", "find", "app/models/user.rb", ["User"]),
      ],
    ]);
    const klassCall: CallRef = { callText: "klass.find", receiver: "klass", member: "find", startLine: 2 };
    const outcome = strat.attempt(
      klassCall,
      ctx({ symbolTable, localBindings: { klass: [{ line: 1, type: "User", valueKind: "class" }] } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/user.rb", targetSymbolId: "User.find" },
    });
  });

  it("REGRESSION: `obj = User.new; obj.find` still resolves to instance method `User#find` (instance-valued binding)", () => {
    const symbolTable = tableWith([
      "app/models/user.rb",
      [
        sym("User", "User", "app/models/user.rb", []),
        sym("User.find", "find", "app/models/user.rb", ["User"]),
        sym("User#find", "find", "app/models/user.rb", ["User"]),
      ],
    ]);
    const instanceCall: CallRef = { callText: "obj.find", receiver: "obj", member: "find", startLine: 2 };
    const outcome = strat.attempt(
      instanceCall,
      ctx({ symbolTable, localBindings: { obj: [{ line: 1, type: "User" }] } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/user.rb", targetSymbolId: "User#find" },
    });
  });

  it("resolves class-valued binding to file-only edge when static method is absent", () => {
    const symbolTable = tableWith(["app/models/user.rb", [sym("User", "User", "app/models/user.rb", [])]]);
    const klassCall: CallRef = { callText: "klass.find", receiver: "klass", member: "find", startLine: 2 };
    const outcome = strat.attempt(
      klassCall,
      ctx({ symbolTable, localBindings: { klass: [{ line: 1, type: "User", valueKind: "class" }] } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/user.rb", targetSymbolId: null },
    });
  });

  // RC-2 (tea-rags-mcp-nts2b): ancestor walk must proceed even when the class's
  // own file cannot be resolved (e.g. class reopened across N>1 files so
  // resolveConstant returns null). Before the fix the function bailed on
  // `if (!targetFile) return null` and never visited classAncestors.
  it("RC-2: resolves inherited method via classAncestors when class file is unresolvable (N>1 declarations)", () => {
    // EnterpriseAdminClient is declared in 2 files → resolveConstant returns null.
    // But it includes Configurable which defines `configure` — the ancestor DOES
    // resolve and owns the method.
    const symbolTable = tableWith(
      // Two declarations of the same constant → lookup().length === 2 → resolveConstant returns null
      [
        "lib/octokit/enterprise_admin_client.rb",
        [
          sym("Octokit::EnterpriseAdminClient", "EnterpriseAdminClient", "lib/octokit/enterprise_admin_client.rb", [
            "Octokit",
          ]),
        ],
      ],
      [
        "lib/octokit/enterprise_admin_client/admins.rb",
        [
          sym(
            "Octokit::EnterpriseAdminClient",
            "EnterpriseAdminClient",
            "lib/octokit/enterprise_admin_client/admins.rb",
            ["Octokit"],
          ),
        ],
      ],
      // Ancestor Configurable has `configure` as an instance method
      [
        "lib/octokit/configurable.rb",
        [
          sym("Octokit::Configurable", "Configurable", "lib/octokit/configurable.rb", ["Octokit"]),
          sym("Octokit::Configurable#configure", "configure", "lib/octokit/configurable.rb", [
            "Octokit",
            "Configurable",
          ]),
        ],
      ],
    );
    const clientCall: CallRef = {
      callText: "client.configure",
      receiver: "client",
      member: "configure",
      startLine: 1,
    };
    const outcome = strat.attempt(
      clientCall,
      ctx({
        symbolTable,
        localBindings: { client: [{ line: 1, type: "Octokit::EnterpriseAdminClient" }] },
        classAncestors: { "Octokit::EnterpriseAdminClient": ["Octokit::Configurable"] },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "lib/octokit/configurable.rb",
        targetSymbolId: "Octokit::Configurable#configure",
      },
    });
  });

  it("RC-2 control: class file unresolvable AND no classAncestors entry → DROP (not continue)", () => {
    // Same N>1 declaration scenario but no classAncestors → null returned → DROP.
    const symbolTable = tableWith(
      [
        "lib/octokit/enterprise_admin_client.rb",
        [
          sym("Octokit::EnterpriseAdminClient", "EnterpriseAdminClient", "lib/octokit/enterprise_admin_client.rb", [
            "Octokit",
          ]),
        ],
      ],
      [
        "lib/octokit/enterprise_admin_client/admins.rb",
        [
          sym(
            "Octokit::EnterpriseAdminClient",
            "EnterpriseAdminClient",
            "lib/octokit/enterprise_admin_client/admins.rb",
            ["Octokit"],
          ),
        ],
      ],
    );
    const clientCall: CallRef = {
      callText: "client.configure",
      receiver: "client",
      member: "configure",
      startLine: 1,
    };
    const outcome = strat.attempt(
      clientCall,
      ctx({
        symbolTable,
        localBindings: { client: [{ line: 1, type: "Octokit::EnterpriseAdminClient" }] },
        // no classAncestors
      }),
    );
    expect(outcome.kind).toBe("drop");
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

  it("class-body chunk: anchors the MRO on callerSymbolId when callerScope omits the class name (bd lawlq.3.2)", () => {
    // A class-body callback edge (`before_action :set_items`) is assigned to the
    // CLASS chunk, whose `scope` EXCLUDES its own name (convention) — so
    // callerScope=[] for a top-level class. callerSymbolId carries the full FQ;
    // anchor the MRO on it so the same-class def wins over a sibling namesake.
    const symbolTable = tableWith(
      [
        "app/controllers/collections_controller.rb",
        [
          sym("CollectionsController#set_items", "set_items", "app/controllers/collections_controller.rb", [
            "CollectionsController",
          ]),
        ],
      ],
      [
        "app/controllers/contexts_controller.rb",
        [
          sym("ContextsController#set_items", "set_items", "app/controllers/contexts_controller.rb", [
            "ContextsController",
          ]),
        ],
      ],
    );
    const outcome = strat.attempt(
      { callText: "set_items", receiver: null, member: "set_items", startLine: 1 },
      ctx({ symbolTable, callerScope: [], callerSymbolId: "CollectionsController" }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "app/controllers/collections_controller.rb",
        targetSymbolId: "CollectionsController#set_items",
      },
    });
  });

  it("class-body chunk: climbs the MRO from callerSymbolId to an inherited method (bd lawlq.3.2)", () => {
    const symbolTable = tableWith(
      [
        "app/controllers/application_controller.rb",
        [
          sym(
            "ApplicationController#require_functional!",
            "require_functional!",
            "app/controllers/application_controller.rb",
            ["ApplicationController"],
          ),
        ],
      ],
      [
        "app/controllers/statuses_cleanup_controller.rb",
        [
          sym(
            "StatusesCleanupController#require_functional!",
            "require_functional!",
            "app/controllers/statuses_cleanup_controller.rb",
            ["StatusesCleanupController"],
          ),
        ],
      ],
    );
    const outcome = strat.attempt(
      { callText: "require_functional!", receiver: null, member: "require_functional!", startLine: 1 },
      ctx({
        symbolTable,
        callerScope: [],
        callerSymbolId: "AboutController",
        classAncestors: { AboutController: ["ApplicationController"] },
      }),
    );
    expect(outcome.kind === "resolved" && outcome.target.targetSymbolId).toBe(
      "ApplicationController#require_functional!",
    );
  });

  it("class-body chunk: MRO narrowing excludes unrelated same-name defs (precision, bd lawlq.3.2)", () => {
    const symbolTable = tableWith(
      [
        "app/controllers/concerns/localized.rb",
        [sym("Localized#set_locale", "set_locale", "app/controllers/concerns/localized.rb", ["Localized"])],
      ],
      [
        "app/mailers/admin_mailer.rb",
        [sym("AdminMailer#set_locale", "set_locale", "app/mailers/admin_mailer.rb", ["AdminMailer"])],
      ],
      [
        "app/mailers/notification_mailer.rb",
        [
          sym("NotificationMailer#set_locale", "set_locale", "app/mailers/notification_mailer.rb", [
            "NotificationMailer",
          ]),
        ],
      ],
    );
    const outcome = strat.attempt(
      { callText: "set_locale", receiver: null, member: "set_locale", startLine: 1 },
      ctx({
        symbolTable,
        callerScope: [],
        callerSymbolId: "AccountsController",
        classAncestors: { AccountsController: ["ApplicationController"], ApplicationController: ["Localized"] },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/controllers/concerns/localized.rb", targetSymbolId: "Localized#set_locale" },
    });
  });

  it("method-body chunk (symbolId has `#`) still anchors on callerScope, not callerSymbolId (no regression)", () => {
    // A method chunk's symbolId is `Class#method`; its callerScope already
    // carries the full class path. callerSymbolId MUST be ignored here (`#`).
    const symbolTable = tableWith(
      ["app/a.rb", [sym("A#helper", "helper", "app/a.rb", ["A"])]],
      ["app/b.rb", [sym("B#helper", "helper", "app/b.rb", ["B"])]],
    );
    const outcome = strat.attempt(
      { callText: "helper", receiver: null, member: "helper", startLine: 1 },
      ctx({ symbolTable, callerScope: ["A"], callerSymbolId: "A#show" }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/a.rb", targetSymbolId: "A#helper" },
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

  it("FQ-canonicalizes each ancestor hop so a deep DSL-mixin chain resolves the method (bd lawlq.3.4)", () => {
    // graphql-ruby `field` shape: classAncestors is keyed by FQ but stores RAW
    // ancestor text (`class DirectiveType < Introspection::BaseObject`). The
    // bareCall MRO must canonicalize each hop to its FQ via Ruby nesting, else
    // the chain dead-ends after ONE hop and `field` (defined 3 hops up on the
    // HasFields mixin) never resolves — the dominant graphql helperModule miss.
    const HAS = "lib/graphql/schema/member/has_fields.rb";
    const OBJ = "lib/graphql/schema/object.rb";
    const BASE = "lib/graphql/introspection/base_object.rb";
    const DIR = "lib/graphql/introspection/directive_type.rb";
    const symbolTable = tableWith(
      [
        HAS,
        [
          sym("GraphQL::Schema::Member::HasFields", "HasFields", HAS, ["GraphQL", "Schema", "Member"]),
          sym("GraphQL::Schema::Member::HasFields#field", "field", HAS, ["GraphQL", "Schema", "Member", "HasFields"]),
        ],
      ],
      [OBJ, [sym("GraphQL::Schema::Object", "Object", OBJ, ["GraphQL", "Schema"])]],
      [BASE, [sym("GraphQL::Introspection::BaseObject", "BaseObject", BASE, ["GraphQL", "Introspection"])]],
      [DIR, [sym("GraphQL::Introspection::DirectiveType", "DirectiveType", DIR, ["GraphQL", "Introspection"])]],
      // Unrelated same-name def forces ambiguity (else a unique `field` resolves trivially).
      ["app/widgets/widget.rb", [sym("Widget#field", "field", "app/widgets/widget.rb", ["Widget"])]],
    );
    const classAncestors: Record<string, string[]> = {
      "GraphQL::Introspection::DirectiveType": ["Introspection::BaseObject"], // raw, non-FQ superclass text
      "GraphQL::Introspection::BaseObject": ["GraphQL::Schema::Object"],
      "GraphQL::Schema::Object": ["GraphQL::Schema::Member::HasFields"], // extend
    };
    const outcome = strat.attempt(
      { callText: "field", receiver: null, member: "field", startLine: 1 },
      ctx({
        symbolTable,
        callerScope: ["GraphQL", "Introspection"],
        callerSymbolId: "GraphQL::Introspection::DirectiveType",
        classAncestors,
      }),
    );
    expect(outcome.kind === "resolved" && outcome.target.targetSymbolId).toBe(
      "GraphQL::Schema::Member::HasFields#field",
    );
  });

  it("exact-FQ tier prefers a namespaced self-def over a same-last-segment top-level namesake (bd lawlq.3.5)", () => {
    // `Admin::InvitesController#resource_params` and top-level
    // `InvitesController#resource_params` share the last scope segment
    // "InvitesController". The tail-only compare matched BOTH at the enclosing
    // level → strict-continue. The exact-FQ tier (`scope.join("::") === klass`)
    // picks the literal same-class def.
    const symbolTable = tableWith(
      [
        "app/controllers/admin/invites_controller.rb",
        [
          sym(
            "Admin::InvitesController#resource_params",
            "resource_params",
            "app/controllers/admin/invites_controller.rb",
            ["Admin::InvitesController"],
          ),
        ],
      ],
      [
        "app/controllers/invites_controller.rb",
        [
          sym("InvitesController#resource_params", "resource_params", "app/controllers/invites_controller.rb", [
            "InvitesController",
          ]),
        ],
      ],
    );
    const outcome = strat.attempt(
      { callText: "resource_params", receiver: null, member: "resource_params", startLine: 1 },
      ctx({ symbolTable, callerScope: ["Admin", "InvitesController"] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "app/controllers/admin/invites_controller.rb",
        targetSymbolId: "Admin::InvitesController#resource_params",
      },
    });
  });

  it("resolves a concern-module self-send via includedBy consensus (bd lawlq.3.2 facet-2)", () => {
    // `module AccountOwnedConcern; def check; not_found; end; end` — `not_found`
    // is not on the module's own MRO; it is INHERITED by every including class
    // from a shared ancestor. Resolve via the classes that include the module,
    // taking the target invariant across them (consensus).
    const APP = "app/controllers/application_controller.rb";
    const symbolTable = tableWith(
      [
        APP,
        [
          sym("ApplicationController", "ApplicationController", APP, []),
          sym("ApplicationController#not_found", "not_found", APP, ["ApplicationController"]),
        ],
      ],
      // Unrelated namesake forces ambiguity so the class-MRO walk cannot pick it.
      ["app/models/widget.rb", [sym("Widget#not_found", "not_found", "app/models/widget.rb", ["Widget"])]],
    );
    const outcome = strat.attempt(
      { callText: "not_found", receiver: null, member: "not_found", startLine: 1 },
      ctx({
        symbolTable,
        callerScope: [],
        callerSymbolId: "AccountOwnedConcern",
        classAncestors: { FooController: ["AccountOwnedConcern", "ApplicationController"] },
        includedBy: { AccountOwnedConcern: ["FooController"] },
      }),
    );
    expect(outcome.kind === "resolved" && outcome.target.targetSymbolId).toBe("ApplicationController#not_found");
  });

  it("does NOT prefix-walk a COMPACT-declared class's raw ancestor to a wrong in-project FQ (bd lawlq.3.7)", () => {
    // `class Api::V2::UsersController < BaseController` (COMPACT) has Ruby nesting
    // [Api::V2::UsersController] only — bare `BaseController` resolves at TOP level
    // (an external gem here), NEVER `Api::BaseController`. Without the compact gate
    // canonicalizeAncestorFq prefix-walks to the unique in-project `Api::BaseController`
    // and fabricates an `authorize!` mixin edge.
    const symbolTable = tableWith(
      [
        "app/controllers/api/base_controller.rb",
        [
          sym("Api::BaseController#authorize!", "authorize!", "app/controllers/api/base_controller.rb", [
            "Api",
            "BaseController",
          ]),
        ],
      ],
      ["app/models/widget.rb", [sym("Widget#authorize!", "authorize!", "app/models/widget.rb", ["Widget"])]],
    );
    const outcome = strat.attempt(
      { callText: "authorize!", receiver: null, member: "authorize!", startLine: 1 },
      ctx({
        symbolTable,
        callerScope: [],
        callerSymbolId: "Api::V2::UsersController",
        classAncestors: { "Api::V2::UsersController": ["BaseController"] },
        compactDeclaredClasses: new Set(["Api::V2::UsersController"]),
      }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("does NOT fabricate a cross-namespace edge from a bare top-level class to a namespaced namesake (bd lawlq.3.7)", () => {
    // Top-level `class NotificationsController` self-sends `set_notification`
    // which it does NOT own. A namespaced namesake Api::NotificationsController
    // (nested scope form) DOES define it. A bare top-level class must NEVER
    // dispatch into Api::NotificationsController — the tail/last-segment match
    // fabricated this edge (M1 feeds the bare FQ, M4 tail disjunct matched it).
    const symbolTable = tableWith(
      [
        "app/controllers/api/notifications_controller.rb",
        [
          sym(
            "Api::NotificationsController#set_notification",
            "set_notification",
            "app/controllers/api/notifications_controller.rb",
            ["Api", "NotificationsController"],
          ),
        ],
      ],
      [
        "app/models/audit_log.rb",
        [sym("AuditLog#set_notification", "set_notification", "app/models/audit_log.rb", ["AuditLog"])],
      ],
    );
    const outcome = strat.attempt(
      { callText: "set_notification", receiver: null, member: "set_notification", startLine: 1 },
      ctx({ symbolTable, callerScope: [], callerSymbolId: "NotificationsController" }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("resolves a bare top-level class self-send to its OWN def over a namespaced namesake (bd lawlq.3.7)", () => {
    // Corollary: the namesake pollution must not SUPPRESS the correct own-class
    // edge either. Top-level NotificationsController owns set_notification and a
    // namespaced namesake also defines it → resolve to the OWN def.
    const symbolTable = tableWith(
      [
        "app/controllers/notifications_controller.rb",
        [
          sym(
            "NotificationsController#set_notification",
            "set_notification",
            "app/controllers/notifications_controller.rb",
            ["NotificationsController"],
          ),
        ],
      ],
      [
        "app/controllers/api/notifications_controller.rb",
        [
          sym(
            "Api::NotificationsController#set_notification",
            "set_notification",
            "app/controllers/api/notifications_controller.rb",
            ["Api", "NotificationsController"],
          ),
        ],
      ],
    );
    const outcome = strat.attempt(
      { callText: "set_notification", receiver: null, member: "set_notification", startLine: 1 },
      ctx({ symbolTable, callerScope: [], callerSymbolId: "NotificationsController" }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "app/controllers/notifications_controller.rb",
        targetSymbolId: "NotificationsController#set_notification",
      },
    });
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

  // RC-1 (tea-rags-mcp-55xil): instance-form preference over class-form on
  // cross-form ambiguity. A bare call from a class that INCLUDES a mixin
  // (Octokit::Client includes Octokit::Configurable) where classAncestors is
  // absent. The MRO narrowing finds no candidate scoped to "Client" or any
  // ancestor, so it falls to pickSingleCandidate. Before the fix that returned
  // null (>1 candidate, strict mode) → CONTINUE (miss). With the form-preference
  // filter, the class-form candidate (Octokit::Default.client_id) is dropped
  // first, leaving only the instance-form candidate → resolves.
  it("prefers instance-form (#) candidate over class-form (.) when MRO narrowing exhausts without a match (rc1)", () => {
    const symbolTable = tableWith(
      [
        "lib/octokit/configurable.rb",
        [
          sym("Octokit::Configurable#client_id", "client_id", "lib/octokit/configurable.rb", [
            "Octokit",
            "Configurable",
          ]),
        ],
      ],
      [
        "lib/octokit/default.rb",
        [sym("Octokit::Default.client_id", "client_id", "lib/octokit/default.rb", ["Octokit", "Default"])],
      ],
    );
    // Caller is Octokit::Client which INCLUDES Configurable, but classAncestors
    // is absent (mixin — no MRO entry). MRO narrowing finds nothing scoped to
    // "Client", falls to pickSingleCandidate with 2 candidates → old: CONTINUE.
    const outcome = strat.attempt(
      { callText: "client_id", receiver: null, member: "client_id", startLine: 1 },
      ctx({ symbolTable, callerScope: ["Octokit", "Client"] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "lib/octokit/configurable.rb",
        targetSymbolId: "Octokit::Configurable#client_id",
      },
    });
  });

  it("still CONTINUEs (does not guess) when two instance-form candidates collide (no MRO, same form — rc1 regression)", () => {
    // Two instance methods with the same short name in unrelated classes and no
    // MRO entry: the form-preference filter leaves two instance candidates, which
    // is still genuinely ambiguous — must NOT guess.
    const symbolTable = tableWith(
      ["lib/a.rb", [sym("A#client_id", "client_id", "lib/a.rb", ["A"])]],
      ["lib/b.rb", [sym("B#client_id", "client_id", "lib/b.rb", ["B"])]],
    );
    const outcome = strat.attempt(
      { callText: "client_id", receiver: null, member: "client_id", startLine: 1 },
      ctx({ symbolTable, callerScope: ["Mod"] }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("resolves an ambiguous short-name to a NAMESPACED base-class method via the MRO chain (compact-FQ scope — cai0/n2kpz)", () => {
    // The walker emits the enclosing class of `class Api::BaseController` as a
    // COMPACT FQ scope segment — scope = ["Api::BaseController"], NOT
    // ["Api","BaseController"]. The pre-fix narrowing compared def.scope[last]
    // only against klass's LAST segment ("BaseController"), so the compact FQ
    // tail "Api::BaseController" never matched and the inherited bare call
    // dropped in strict mode despite a single valid in-project target. A decoy
    // TagsController#limit_param collides on the short name.
    const symbolTable = tableWith(
      [
        "app/controllers/api/base_controller.rb",
        [
          sym("Api::BaseController#limit_param", "limit_param", "app/controllers/api/base_controller.rb", [
            "Api::BaseController",
          ]),
        ],
      ],
      [
        "app/controllers/tags_controller.rb",
        [sym("TagsController#limit_param", "limit_param", "app/controllers/tags_controller.rb", ["TagsController"])],
      ],
    );
    const outcome = strat.attempt(
      { callText: "limit_param", receiver: null, member: "limit_param", startLine: 1 },
      ctx({
        symbolTable,
        callerScope: ["Api", "V1", "Accounts", "EndorsementsController"],
        classAncestors: { "Api::V1::Accounts::EndorsementsController": ["Api::BaseController"] },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "app/controllers/api/base_controller.rb",
        targetSymbolId: "Api::BaseController#limit_param",
      },
    });
  });

  it("resolves an ambiguous short-name to a NAMESPACED included concern via the MRO chain (compact-FQ scope — cai0/n2kpz)", () => {
    // Same compact-FQ scope bug for a concern reached via `include`: the
    // enclosing controller includes Api::Pagination, whose scope is stored as
    // ["Api::Pagination"]. Pre-fix, "Api::Pagination" only compared against the
    // klass last-segment "Pagination" and missed; the bare pagination_params
    // dropped even though the concern is the unique MRO owner (a sibling
    // controller override collides on the short name).
    const symbolTable = tableWith(
      [
        "app/controllers/concerns/api/pagination.rb",
        [
          sym("Api::Pagination#pagination_params", "pagination_params", "app/controllers/concerns/api/pagination.rb", [
            "Api::Pagination",
          ]),
        ],
      ],
      [
        "app/controllers/api/v1/notifications_controller.rb",
        [
          sym(
            "Api::V1::NotificationsController#pagination_params",
            "pagination_params",
            "app/controllers/api/v1/notifications_controller.rb",
            ["Api::V1::NotificationsController"],
          ),
        ],
      ],
    );
    const outcome = strat.attempt(
      { callText: "pagination_params", receiver: null, member: "pagination_params", startLine: 1 },
      ctx({
        symbolTable,
        callerScope: ["Api", "V1", "Accounts", "FollowerAccountsController"],
        classAncestors: { "Api::V1::Accounts::FollowerAccountsController": ["Api::Pagination"] },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: {
        targetRelPath: "app/controllers/concerns/api/pagination.rb",
        targetSymbolId: "Api::Pagination#pagination_params",
      },
    });
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

describe("RubySuperSymbolResolutionStrategy — module-method super (cai0/2oky5)", () => {
  const strat = new RubySuperSymbolResolutionStrategy(cfg);

  it("resolves module super to the consensus target when including classes agree", () => {
    // Module M `def m; super; end` included by A and B; both have MRO [M, Base].
    // Base defines m. classAncestors[M]=[] so the class-keyed walk misses;
    // includedBy M:[A,B] supplies the reverse path. Both agree → Base#m.
    const symbolTable = tableWith(
      ["app/m.rb", [sym("M", "M", "app/m.rb", [])]],
      ["app/a.rb", [sym("A", "A", "app/a.rb", [])]],
      ["app/b.rb", [sym("B", "B", "app/b.rb", [])]],
      ["app/base.rb", [sym("Base", "Base", "app/base.rb", []), sym("Base#m", "m", "app/base.rb", ["Base"])]],
    );
    const callRef: CallRef = { callText: "super", receiver: SUPER_RECEIVER_SENTINEL, member: "m", startLine: 1 };
    const outcome = strat.attempt(
      callRef,
      ctx({
        symbolTable,
        callerScope: ["M"],
        classAncestors: { M: [], A: ["M", "Base"], B: ["M", "Base"] },
        includedBy: { M: ["A", "B"] },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.rb", targetSymbolId: "Base#m" },
    });
  });

  it("drops module super when including classes disagree on the target", () => {
    // A's next-after-M = Base1#m; B's next-after-M = Base2#m — divergent → DROP.
    const symbolTable = tableWith(
      ["app/m.rb", [sym("M", "M", "app/m.rb", [])]],
      ["app/a.rb", [sym("A", "A", "app/a.rb", [])]],
      ["app/b.rb", [sym("B", "B", "app/b.rb", [])]],
      ["app/base1.rb", [sym("Base1", "Base1", "app/base1.rb", []), sym("Base1#m", "m", "app/base1.rb", ["Base1"])]],
      ["app/base2.rb", [sym("Base2", "Base2", "app/base2.rb", []), sym("Base2#m", "m", "app/base2.rb", ["Base2"])]],
    );
    const callRef: CallRef = { callText: "super", receiver: SUPER_RECEIVER_SENTINEL, member: "m", startLine: 1 };
    const outcome = strat.attempt(
      callRef,
      ctx({
        symbolTable,
        callerScope: ["M"],
        classAncestors: { M: [], A: ["M", "Base1"], B: ["M", "Base2"] },
        includedBy: { M: ["A", "B"] },
      }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("drops module super when the module has no including class", () => {
    // includedBy absent for M; classAncestors[M]=[] so walk also misses → DROP.
    const symbolTable = tableWith(
      ["app/m.rb", [sym("M", "M", "app/m.rb", [])]],
      ["app/base.rb", [sym("Base", "Base", "app/base.rb", []), sym("Base#m", "m", "app/base.rb", ["Base"])]],
    );
    const callRef: CallRef = { callText: "super", receiver: SUPER_RECEIVER_SENTINEL, member: "m", startLine: 1 };
    const outcome = strat.attempt(
      callRef,
      ctx({
        symbolTable,
        callerScope: ["M"],
        classAncestors: { M: [] },
        // includedBy absent
      }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("resolves prepended-module super to the prepending class", () => {
    // Wrapper prepended into Agent. super from Wrapper#save → Agent#save.
    // classPrependedAncestors Agent:[Wrapper]; includedBy Wrapper:[Agent];
    // classAncestors[Wrapper]=[] so class-keyed walk misses → reverse path.
    const symbolTable = tableWith(
      ["app/wrapper.rb", [sym("Wrapper", "Wrapper", "app/wrapper.rb", [])]],
      [
        "app/agent.rb",
        [sym("Agent", "Agent", "app/agent.rb", []), sym("Agent#save", "save", "app/agent.rb", ["Agent"])],
      ],
    );
    const callRef: CallRef = { callText: "super", receiver: SUPER_RECEIVER_SENTINEL, member: "save", startLine: 1 };
    const outcome = strat.attempt(
      callRef,
      ctx({
        symbolTable,
        callerScope: ["Wrapper"],
        classAncestors: { Wrapper: [] },
        classPrependedAncestors: { Agent: ["Wrapper"] },
        includedBy: { Wrapper: ["Agent"] },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/agent.rb", targetSymbolId: "Agent#save" },
    });
  });
});

describe("receiverChainTailIsExternal (increment B / B-suppress)", () => {
  it("is true when the receiver ends in a provably-external core/runtime tail", () => {
    expect(receiverChainTailIsExternal("req.headers")).toBe(true);
    expect(receiverChainTailIsExternal("e.backtrace")).toBe(true);
    expect(receiverChainTailIsExternal("type.constantize")).toBe(true);
  });

  it("is false for in-project association tails or bare identifiers", () => {
    expect(receiverChainTailIsExternal("event.user.agents")).toBe(false); // in-project assoc — NOT external
    expect(receiverChainTailIsExternal("user")).toBe(false); // bare identifier
  });
});

describe("RubyDynamicDispatchResolver — chain-tail suppression (increment B / B-suppress)", () => {
  const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };
  const resolver = new RubyDynamicDispatchResolver(cfg);

  it("returns [] for a provably-external chain-tail receiver (req.headers.to_h)", () => {
    // `req.headers.to_h` → receiver is `req.headers`; `.headers` is an EXTERNAL_CHAIN_TAIL
    const call: CallRef = { callText: "req.headers.to_h", receiver: "req.headers", member: "to_h", startLine: 1 };
    const symbolTable = tableWith([
      "app/lib/to_h.rb",
      [sym("SomeClass#to_h", "to_h", "app/lib/to_h.rb", ["SomeClass"])],
    ]);
    const result = resolver.resolveDispatch(call, ctx({ symbolTable }));
    expect(result).toEqual([]);
  });

  it("still fans out for a non-external chain receiver (regression guard: event.user)", () => {
    // `event.user` → `.user` is NOT in EXTERNAL_CHAIN_TAILS → fan-out proceeds
    const call: CallRef = { callText: "event.user.save", receiver: "event.user", member: "save", startLine: 1 };
    const symbolTable = tableWith(["app/models/user.rb", [sym("User#save", "save", "app/models/user.rb", ["User"])]]);
    const result = resolver.resolveDispatch(call, ctx({ symbolTable }));
    expect(result.length).toBeGreaterThan(0);
  });
});
