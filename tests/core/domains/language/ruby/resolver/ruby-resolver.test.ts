import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { ZEITWERK_PREFIX } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function makeCtx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  symbolTable: InMemoryGlobalSymbolTable,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable };
}

describe("RubyCallResolver — Zeitwerk constant lookup", () => {
  it("resolves `User.find` via fileScope index (symbol table)", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    // The walker would index a class declaration's constants — here we
    // simulate by inserting the constant directly with fqName = "User".
    table.upsertFile("app/models/user.rb", [
      { symbolId: "User", fqName: "User", shortName: "User", relPath: "app/models/user.rb", scope: [] },
      {
        // Per symbolid-convention.md: class methods (def self.find) join
        // their class with `.`, not `::` (the namespace separator).
        symbolId: "User.find",
        fqName: "User.find",
        shortName: "find",
        relPath: "app/models/user.rb",
        scope: ["User"],
      },
    ]);
    const target = resolver.resolve(
      { callText: "User.find(1)", receiver: "User", member: "find", startLine: 4 },
      makeCtx("app/controllers/users_controller.rb", [{ importText: `${ZEITWERK_PREFIX}User`, startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("app/models/user.rb");
    expect(target?.targetSymbolId).toBe("User.find");
  });

  it("resolves qualified `Acme::Auth::Login` constants", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/services/acme/auth/login.rb", [
      {
        symbolId: "Acme::Auth::Login",
        fqName: "Acme::Auth::Login",
        shortName: "Login",
        relPath: "app/services/acme/auth/login.rb",
        scope: ["Acme", "Auth"],
      },
      {
        symbolId: "Acme::Auth::Login::call",
        fqName: "Acme::Auth::Login::call",
        shortName: "call",
        relPath: "app/services/acme/auth/login.rb",
        scope: ["Acme", "Auth", "Login"],
      },
    ]);
    const target = resolver.resolve(
      { callText: "Acme::Auth::Login.call", receiver: "Acme::Auth::Login", member: "call", startLine: 3 },
      makeCtx("app/controllers/sessions_controller.rb", [], table),
    );
    expect(target?.targetRelPath).toBe("app/services/acme/auth/login.rb");
  });

  it("falls back to Zeitwerk convention when symbol table has no fqName entry", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    // No symbol table entry for `Widget` — only a known file path
    // available via the import-list (simulating that the file is
    // indexed but its fileScope didn't get persisted).
    const target = resolver.resolve(
      { callText: "Widget.render", receiver: "Widget", member: "render", startLine: 1 },
      // Pass a known relative file in the import list so knownPaths
      // includes it; the resolver also adds the caller file.
      makeCtx("app/controllers/x.rb", [{ importText: "app/components/widget.rb", startLine: 1 }], table),
    );
    // resolveZeitwerkConstant matches Widget → app/components/widget.rb
    // via basename fallback (any path ending in /widget.rb).
    expect(target?.targetRelPath).toBe("app/components/widget.rb");
  });

  it("returns null when constant is unknown and no Zeitwerk path matches", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    const target = resolver.resolve(
      { callText: "Ghost.find", receiver: "Ghost", member: "find", startLine: 1 },
      makeCtx("main.rb", [], table),
    );
    expect(target).toBeNull();
  });
});

describe("RubyCallResolver — explicit requires", () => {
  it("handles require_relative './foo' resolving to sibling file", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/foo.rb", [
      { symbolId: "Foo", fqName: "Foo", shortName: "Foo", relPath: "pkg/foo.rb", scope: [] },
      { symbolId: "Foo::bar", fqName: "Foo::bar", shortName: "bar", relPath: "pkg/foo.rb", scope: ["Foo"] },
    ]);
    // Receiver matches the constant `Foo` which is defined in pkg/foo.rb.
    // The Zeitwerk path resolves first (symbol table direct match),
    // even without the require_relative being inspected.
    const target = resolver.resolve(
      { callText: "Foo.bar", receiver: "Foo", member: "bar", startLine: 5 },
      makeCtx("pkg/main.rb", [{ importText: "./foo", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.rb");
  });
});

describe("RubyCallResolver — global short-name fallback", () => {
  it("resolves bare top-level call when no receiver", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("helpers.rb", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "helpers.rb", scope: [] },
    ]);
    const target = resolver.resolve(
      { callText: "do_thing", receiver: null, member: "do_thing", startLine: 1 },
      makeCtx("main.rb", [], table),
    );
    expect(target?.targetRelPath).toBe("helpers.rb");
  });

  it("returns null when global lookup is ambiguous", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "a.rb", scope: [] },
    ]);
    table.upsertFile("b.rb", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "b.rb", scope: [] },
    ]);
    const target = resolver.resolve(
      { callText: "do_thing", receiver: null, member: "do_thing", startLine: 1 },
      makeCtx("main.rb", [], table),
    );
    expect(target).toBeNull();
  });
});

describe("RubyCallResolver — Zeitwerk constant with no targetSymbolId", () => {
  // When `resolveConstant` returns a target file (via zeitwerk path
  // match) but the symbol table has no entry whose shortName matches
  // the call.member, the resolver records the file edge with
  // targetSymbolId=null. This covers the `if (target) ... else
  // targetFile only` branch on line 48 of ruby-resolver.ts.
  it("records target file with null symbolId when member is not found in symbol table", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    // File path is known (via the explicit require import-list), but no
    // symbol with shortName="ghost_method" exists anywhere — so the
    // candidate list is empty after the file-filter.
    const target = resolver.resolve(
      { callText: "Widget.ghost_method", receiver: "Widget", member: "ghost_method", startLine: 1 },
      makeCtx("app/x.rb", [{ importText: "app/components/widget.rb", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("app/components/widget.rb");
    expect(target?.targetSymbolId).toBeNull();
  });

  // When `lookup(qualified)` returns multiple entries (the constant
  // chain matches more than one file's fileScope), pass 1 in
  // `resolveConstant` doesn't pin a single file and falls through to
  // Zeitwerk pass 2. Covers line 89 (`direct.length === 1` false-branch).
  it("falls through to Zeitwerk convention when direct symbol-table lookup is ambiguous", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [{ symbolId: "User", fqName: "User", shortName: "User", relPath: "a.rb", scope: [] }]);
    table.upsertFile("b.rb", [{ symbolId: "User", fqName: "User", shortName: "User", relPath: "b.rb", scope: [] }]);
    // Direct lookup finds two — ambiguous. Pass 2 (Zeitwerk) consults
    // the import-list knownPaths; the import below puts `app/models/user.rb`
    // in scope, where User snake_cases to user.rb (basename match wins).
    const target = resolver.resolve(
      { callText: "User.find", receiver: "User", member: "find", startLine: 1 },
      makeCtx("main.rb", [{ importText: "app/models/user.rb", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("app/models/user.rb");
  });
});

describe("RubyCallResolver — explicit require path matching", () => {
  // `resolveExplicitRequire` for a bare `require 'foo'`: walk knownPaths
  // looking for any path ending in `/foo.rb` OR equalling `foo.rb`.
  // Covers lines 102-107 (the bare-require branch).
  it("resolves bare `require 'foo'` to a known path ending in /foo.rb", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("vendor/lib/foo.rb", [
      { symbolId: "Foo", fqName: "Foo", shortName: "Foo", relPath: "vendor/lib/foo.rb", scope: [] },
      { symbolId: "Foo::bar", fqName: "Foo::bar", shortName: "bar", relPath: "vendor/lib/foo.rb", scope: ["Foo"] },
    ]);
    // Receiver is null so we skip Zeitwerk. The explicit-require branch
    // walks the import-list; `foo` matches because the import-list also
    // carries `vendor/lib/foo.rb` (the resolver's knownPaths includes
    // every importText that isn't zeitwerk-prefixed).
    const target = resolver.resolve(
      { callText: "bar", receiver: "foo", member: "bar", startLine: 1 },
      makeCtx(
        "main.rb",
        [
          { importText: "foo", startLine: 1 },
          { importText: "vendor/lib/foo.rb", startLine: 2 },
        ],
        table,
      ),
    );
    expect(target?.targetRelPath).toBe("vendor/lib/foo.rb");
    expect(target?.targetSymbolId).toBe("Foo::bar");
  });

  // require_relative with knownPath-only resolution: the importText
  // already carries the canonical "./<x>" shape produced by the walker.
  // Covers the require_relative branch in resolveExplicitRequire.
  it("resolves `require_relative './foo'` to caller-dir + foo.rb", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    // No fileScope match — we want the file-only edge so we exercise
    // the resolveExplicitRequire path independent of the constant
    // lookup. Receiver matches importText to flip into the
    // explicit-require branch (line 62).
    const target = resolver.resolve(
      { callText: "helper", receiver: "./foo", member: "helper", startLine: 1 },
      makeCtx("pkg/main.rb", [{ importText: "./foo", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.rb");
    expect(target?.targetSymbolId).toBeNull();
  });

  // resolveExplicitRequire — bare require where the knownPath list has
  // NO matching basename. Drops through to the final fallback (null).
  it("returns null when bare require has no matching basename in knownPaths", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    const target = resolver.resolve(
      { callText: "thing", receiver: "nonexistent", member: "thing", startLine: 1 },
      makeCtx("main.rb", [{ importText: "nonexistent", startLine: 1 }], table),
    );
    // No knownPath ends in /nonexistent.rb → resolveExplicitRequire
    // returns null. Global short-name lookup for `thing` is empty too.
    expect(target).toBeNull();
  });
});

describe("RubyCallResolver — Step 0 resolveByLocalType (walker-inferred receiver types)", () => {
  it("disambiguates colliding short-names by binding receiver to its constructor class", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/policies/abstract_policy.rb", [
      {
        symbolId: "AbstractPolicy",
        fqName: "AbstractPolicy",
        shortName: "AbstractPolicy",
        relPath: "app/policies/abstract_policy.rb",
        scope: [],
      },
      {
        symbolId: "AbstractPolicy#authorize!",
        fqName: "AbstractPolicy#authorize!",
        shortName: "authorize!",
        relPath: "app/policies/abstract_policy.rb",
        scope: ["AbstractPolicy"],
      },
    ]);
    // Colliding short-name in a different file — global short-name lookup
    // would be ambiguous; localBindings constrains it.
    table.upsertFile("app/services/other.rb", [
      {
        symbolId: "OtherThing#authorize!",
        fqName: "OtherThing#authorize!",
        shortName: "authorize!",
        relPath: "app/services/other.rb",
        scope: ["OtherThing"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/controllers/x.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { policy: [{ line: 1, type: "AbstractPolicy" }] },
    };
    const target = resolver.resolve(
      { callText: "policy.authorize!", receiver: "policy", member: "authorize!", startLine: 5 },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("AbstractPolicy#authorize!");
    expect(target?.targetRelPath).toBe("app/policies/abstract_policy.rb");
  });

  // This case used to demonstrate the FP — `Product.ransack(...).result(...)`
  // resolving to AbstractPolicy#result via global short-name. The AR-relation
  // chain guard now drops it. The behavioural test that PINS the new fix
  // lives in the "AR Relation chain guard" describe block below.

  it("returns file-only edge when method is inherited from a base class outside the project", () => {
    // Common Ruby pattern: `user = User.new; user.save` where `save` is
    // defined on ApplicationRecord (not indexed) but User is.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/user.rb", [
      {
        symbolId: "User",
        fqName: "User",
        shortName: "User",
        relPath: "app/models/user.rb",
        scope: [],
      },
      // No `save` method indexed in user.rb.
    ]);
    const ctx: CallContext = {
      callerFile: "app/controllers/users_controller.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { u: [{ line: 1, type: "User" }] },
    };
    const target = resolver.resolve({ callText: "u.save", receiver: "u", member: "save", startLine: 5 }, ctx);
    // File-level edge preserved (user.rb), method-level dropped.
    expect(target?.targetRelPath).toBe("app/models/user.rb");
    expect(target?.targetSymbolId).toBeNull();
  });

  it("returns null when the bound type's file is unknown", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    const ctx: CallContext = {
      callerFile: "app/controllers/x.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { thing: [{ line: 1, type: "UnknownClassNotInSymbolTable" }] },
    };
    const target = resolver.resolve({ callText: "thing.foo", receiver: "thing", member: "foo", startLine: 1 }, ctx);
    expect(target).toBeNull();
  });
});

describe("RubyCallResolver — explicit require with mixed import channels", () => {
  // When ctx.imports contains both a zeitwerk-prefixed entry AND a plain
  // require entry, the explicit-require scan must SKIP the zeitwerk one
  // (it belongs to the constant-lookup channel, not the load-path one).
  // Drives the `imp.importText.startsWith(ZEITWERK_PREFIX) → return false`
  // branch in the requireMatch predicate.
  it("ignores zeitwerk-prefixed imports during explicit-require search", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("vendor/lib/helper.rb", [
      { symbolId: "helper", fqName: "helper", shortName: "helper", relPath: "vendor/lib/helper.rb", scope: [] },
    ]);
    // Receiver matches one import's importText to flip into the
    // explicit-require branch; the zeitwerk-prefixed entry must be
    // filtered out by the predicate.
    const target = resolver.resolve(
      { callText: "helper", receiver: "helper", member: "helper", startLine: 1 },
      makeCtx(
        "main.rb",
        [
          { importText: `${ZEITWERK_PREFIX}User`, startLine: 1 }, // must be skipped
          { importText: "helper", startLine: 2 }, // bare require — matches receiver
          { importText: "vendor/lib/helper.rb", startLine: 3 }, // for basename match
        ],
        table,
      ),
    );
    expect(target?.targetRelPath).toBe("vendor/lib/helper.rb");
    expect(target?.targetSymbolId).toBe("helper");
  });

  // resolveExplicitRequire's bare-require branch: when a path in
  // knownPaths EQUALS the wanted basename (rather than ending in
  // `/<basename>`), the first equality check fires (`p === wanted`).
  // Realistic shape: caller file IS `foo.rb` at the project root, and
  // a `require 'foo'` from within itself self-loops to that same file.
  it("matches bare require by exact equality with knownPaths basename", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo.rb", [
      { symbolId: "Foo", fqName: "Foo", shortName: "Foo", relPath: "foo.rb", scope: [] },
      { symbolId: "Foo::bar", fqName: "Foo::bar", shortName: "bar", relPath: "foo.rb", scope: ["Foo"] },
    ]);
    const target = resolver.resolve(
      { callText: "bar", receiver: "foo", member: "bar", startLine: 1 },
      // Caller file is `foo.rb` itself — it gets added to knownPaths and
      // equals the `foo.rb` wanted-basename, triggering the equality branch.
      makeCtx("foo.rb", [{ importText: "foo", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("foo.rb");
    expect(target?.targetSymbolId).toBe("Foo::bar");
  });
});

describe("RubyCallResolver — Zeitwerk branch ancestor walk for class-method calls", () => {
  it("disambiguates Class.method vs Class#method when both share short_name + file", () => {
    // Real production Rails monorepo situation: AbstractPolicy has BOTH a
    // class method (def self.authorize! / class << self) AND an instance
    // method (def authorize!) with the same name `authorize!` in the
    // same file. ProductPolicy.authorize!(...) is a class-method call —
    // the resolver must prefer the `.`-form (class method) over the
    // `#`-form (instance method). Without that distinction strict mode
    // picks neither and the edge drops.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/policies/product_policy.rb", [
      {
        symbolId: "ProductPolicy",
        fqName: "ProductPolicy",
        shortName: "ProductPolicy",
        relPath: "app/policies/product_policy.rb",
        scope: [],
      },
    ]);
    table.upsertFile("app/policies/abstract_policy.rb", [
      {
        symbolId: "AbstractPolicy",
        fqName: "AbstractPolicy",
        shortName: "AbstractPolicy",
        relPath: "app/policies/abstract_policy.rb",
        scope: [],
      },
      {
        symbolId: "AbstractPolicy.authorize!",
        fqName: "AbstractPolicy.authorize!",
        shortName: "authorize!",
        relPath: "app/policies/abstract_policy.rb",
        scope: ["AbstractPolicy"],
      },
      {
        symbolId: "AbstractPolicy#authorize!",
        fqName: "AbstractPolicy#authorize!",
        shortName: "authorize!",
        relPath: "app/policies/abstract_policy.rb",
        scope: ["AbstractPolicy"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/services/products/show.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      classAncestors: { ProductPolicy: ["AbstractPolicy"] },
    };
    const target = resolver.resolve(
      {
        callText: "ProductPolicy.authorize!(@current_user, :see_draft, @product)",
        receiver: "ProductPolicy",
        member: "authorize!",
        startLine: 12,
      },
      ctx,
    );
    // Must pick the class-method form.
    expect(target?.targetSymbolId).toBe("AbstractPolicy.authorize!");
  });

  it("resolves `ProductPolicy.authorize!` to inherited `AbstractPolicy.authorize!`", () => {
    // `class ProductPolicy < AbstractPolicy` declares the inheritance.
    // `ProductPolicy.authorize!(...)` is a class-method call — receiver
    // is a constant, so it enters the Zeitwerk branch. ProductPolicy
    // doesn't override authorize!, so without ancestor walk the edge
    // drops to a file-only attribution. With the walk it should pin
    // to AbstractPolicy.authorize! living in abstract_policy.rb.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/policies/product_policy.rb", [
      {
        symbolId: "ProductPolicy",
        fqName: "ProductPolicy",
        shortName: "ProductPolicy",
        relPath: "app/policies/product_policy.rb",
        scope: [],
      },
    ]);
    table.upsertFile("app/policies/abstract_policy.rb", [
      {
        symbolId: "AbstractPolicy",
        fqName: "AbstractPolicy",
        shortName: "AbstractPolicy",
        relPath: "app/policies/abstract_policy.rb",
        scope: [],
      },
      {
        symbolId: "AbstractPolicy.authorize!",
        fqName: "AbstractPolicy.authorize!",
        shortName: "authorize!",
        relPath: "app/policies/abstract_policy.rb",
        scope: ["AbstractPolicy"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/services/products/show.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      classAncestors: { ProductPolicy: ["AbstractPolicy"] },
    };
    const target = resolver.resolve(
      {
        callText: "ProductPolicy.authorize!(@current_user, :see_draft, @product)",
        receiver: "ProductPolicy",
        member: "authorize!",
        startLine: 12,
      },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("AbstractPolicy.authorize!");
    expect(target?.targetRelPath).toBe("app/policies/abstract_policy.rb");
  });

  it("falls back to file-only edge when neither class nor any ancestor owns the method", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/policies/product_policy.rb", [
      {
        symbolId: "ProductPolicy",
        fqName: "ProductPolicy",
        shortName: "ProductPolicy",
        relPath: "app/policies/product_policy.rb",
        scope: [],
      },
    ]);
    table.upsertFile("app/policies/abstract_policy.rb", [
      {
        symbolId: "AbstractPolicy",
        fqName: "AbstractPolicy",
        shortName: "AbstractPolicy",
        relPath: "app/policies/abstract_policy.rb",
        scope: [],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      classAncestors: { ProductPolicy: ["AbstractPolicy"] },
    };
    const target = resolver.resolve(
      { callText: "ProductPolicy.never_existed", receiver: "ProductPolicy", member: "never_existed", startLine: 1 },
      ctx,
    );
    // Method-level dropped, file-level pinned to the bound class's file.
    expect(target?.targetRelPath).toBe("app/policies/product_policy.rb");
    expect(target?.targetSymbolId).toBeNull();
  });

  it("recurses through a 3-level inheritance chain to find the method on the grandparent", () => {
    // class ConcretePolicy < MidPolicy; class MidPolicy < RootPolicy.
    // ConcretePolicy.audit! — neither ConcretePolicy nor MidPolicy define
    // audit!; only RootPolicy does. Exercises the recurse-one-level-deeper
    // path inside walkAncestorsForConstantCall.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/policies/concrete_policy.rb", [
      {
        symbolId: "ConcretePolicy",
        fqName: "ConcretePolicy",
        shortName: "ConcretePolicy",
        relPath: "app/policies/concrete_policy.rb",
        scope: [],
      },
    ]);
    table.upsertFile("app/policies/mid_policy.rb", [
      {
        symbolId: "MidPolicy",
        fqName: "MidPolicy",
        shortName: "MidPolicy",
        relPath: "app/policies/mid_policy.rb",
        scope: [],
      },
    ]);
    table.upsertFile("app/policies/root_policy.rb", [
      {
        symbolId: "RootPolicy",
        fqName: "RootPolicy",
        shortName: "RootPolicy",
        relPath: "app/policies/root_policy.rb",
        scope: [],
      },
      {
        symbolId: "RootPolicy.audit!",
        fqName: "RootPolicy.audit!",
        shortName: "audit!",
        relPath: "app/policies/root_policy.rb",
        scope: ["RootPolicy"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/services/audit.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      classAncestors: {
        ConcretePolicy: ["MidPolicy"],
        MidPolicy: ["RootPolicy"],
      },
    };
    const target = resolver.resolve(
      { callText: "ConcretePolicy.audit!(:thing)", receiver: "ConcretePolicy", member: "audit!", startLine: 5 },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("RootPolicy.audit!");
    expect(target?.targetRelPath).toBe("app/policies/root_policy.rb");
  });

  it("breaks an ancestor cycle (A → B → A) without overflow and falls back to file-only edge", () => {
    // Pathological classAncestors: ChildPolicy → ParentPolicy → ChildPolicy.
    // The visited guard in walkAncestorsForConstantCall must skip the
    // already-walked ancestor and unwind to the file-only fallback.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/policies/child_policy.rb", [
      {
        symbolId: "ChildPolicy",
        fqName: "ChildPolicy",
        shortName: "ChildPolicy",
        relPath: "app/policies/child_policy.rb",
        scope: [],
      },
    ]);
    table.upsertFile("app/policies/parent_policy.rb", [
      {
        symbolId: "ParentPolicy",
        fqName: "ParentPolicy",
        shortName: "ParentPolicy",
        relPath: "app/policies/parent_policy.rb",
        scope: [],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      classAncestors: {
        ChildPolicy: ["ParentPolicy"],
        ParentPolicy: ["ChildPolicy"],
      },
    };
    const target = resolver.resolve(
      { callText: "ChildPolicy.ghost!", receiver: "ChildPolicy", member: "ghost!", startLine: 3 },
      ctx,
    );
    // No method anywhere → method-level dropped, file-level pinned to bound class.
    expect(target?.targetRelPath).toBe("app/policies/child_policy.rb");
    expect(target?.targetSymbolId).toBeNull();
  });

  it("skips an ancestor that doesn't resolve to a file and tries the next one", () => {
    // ProductPolicy declares two ancestors: [GhostMixin, AbstractPolicy].
    // GhostMixin has no symbol-table entry and no Zeitwerk path match —
    // resolveConstant returns null, so the walker must `continue` past
    // the ghost ancestor and try AbstractPolicy.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/policies/product_policy.rb", [
      {
        symbolId: "ProductPolicy",
        fqName: "ProductPolicy",
        shortName: "ProductPolicy",
        relPath: "app/policies/product_policy.rb",
        scope: [],
      },
    ]);
    table.upsertFile("app/policies/abstract_policy.rb", [
      {
        symbolId: "AbstractPolicy",
        fqName: "AbstractPolicy",
        shortName: "AbstractPolicy",
        relPath: "app/policies/abstract_policy.rb",
        scope: [],
      },
      {
        symbolId: "AbstractPolicy.permit!",
        fqName: "AbstractPolicy.permit!",
        shortName: "permit!",
        relPath: "app/policies/abstract_policy.rb",
        scope: ["AbstractPolicy"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/services/products/permit.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      classAncestors: { ProductPolicy: ["GhostMixin", "AbstractPolicy"] },
    };
    const target = resolver.resolve(
      { callText: "ProductPolicy.permit!(@user)", receiver: "ProductPolicy", member: "permit!", startLine: 7 },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("AbstractPolicy.permit!");
    expect(target?.targetRelPath).toBe("app/policies/abstract_policy.rb");
  });
});

describe("RubyCallResolver — Step 0 with qualified type name (scope tail = full FQN)", () => {
  it("resolves member on a namespaced class when the symbol's scope tail is the FULL FQN", () => {
    // The walker emits scope=["Product::IndexForm"] (one element, the
    // full qualified name) for classes declared with a compound header
    // like `class Product::IndexForm`. Step 0 matches against this
    // form when typeName is also qualified — without the FQN-match
    // branch, the filter compared bareType="IndexForm" against the
    // tail="Product::IndexForm" and silently dropped the candidate.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/forms/product/index_form.rb", [
      {
        symbolId: "Product::IndexForm",
        fqName: "Product::IndexForm",
        shortName: "IndexForm",
        relPath: "app/forms/product/index_form.rb",
        scope: [],
      },
      {
        symbolId: "Product::IndexForm#search_params",
        fqName: "Product::IndexForm#search_params",
        shortName: "search_params",
        relPath: "app/forms/product/index_form.rb",
        scope: ["Product::IndexForm"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/rpc/products_controller.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { form: [{ line: 1, type: "Product::IndexForm" }] },
    };
    const target = resolver.resolve(
      { callText: "form.search_params", receiver: "form", member: "search_params", startLine: 5 },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("Product::IndexForm#search_params");
    expect(target?.targetRelPath).toBe("app/forms/product/index_form.rb");
  });

  it("still resolves a top-level class whose scope tail is the bare name", () => {
    // Coverage twin: top-level `class Foo` produces scope=["Foo"], so
    // the bareType branch of the filter must still match.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo.rb", [
      { symbolId: "Foo", fqName: "Foo", shortName: "Foo", relPath: "foo.rb", scope: [] },
      { symbolId: "Foo#bar", fqName: "Foo#bar", shortName: "bar", relPath: "foo.rb", scope: ["Foo"] },
    ]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { x: [{ line: 1, type: "Foo" }] },
    };
    const target = resolver.resolve({ callText: "x.bar", receiver: "x", member: "bar", startLine: 1 }, ctx);
    expect(target?.targetSymbolId).toBe("Foo#bar");
  });
});

describe("RubyCallResolver — Step 0 with classAncestors (inheritance walk)", () => {
  it("resolves method to superclass when bound class doesn't define it", () => {
    // Product::IndexForm < PaginatableForm. `form.page` where form bound
    // to Product::IndexForm — page lives on PaginatableForm.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/forms/product/index_form.rb", [
      {
        symbolId: "Product::IndexForm",
        fqName: "Product::IndexForm",
        shortName: "IndexForm",
        relPath: "app/forms/product/index_form.rb",
        scope: ["Product"],
      },
    ]);
    table.upsertFile("app/forms/paginatable_form.rb", [
      {
        symbolId: "PaginatableForm",
        fqName: "PaginatableForm",
        shortName: "PaginatableForm",
        relPath: "app/forms/paginatable_form.rb",
        scope: [],
      },
      {
        symbolId: "PaginatableForm#page",
        fqName: "PaginatableForm#page",
        shortName: "page",
        relPath: "app/forms/paginatable_form.rb",
        scope: ["PaginatableForm"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/rpc/products_controller.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { form: [{ line: 1, type: "Product::IndexForm" }] },
      classAncestors: { "Product::IndexForm": ["PaginatableForm"] },
    };
    const target = resolver.resolve({ callText: "form.page", receiver: "form", member: "page", startLine: 5 }, ctx);
    expect(target?.targetSymbolId).toBe("PaginatableForm#page");
    expect(target?.targetRelPath).toBe("app/forms/paginatable_form.rb");
  });

  it("walks mixin ancestors when method not on direct superclass", () => {
    // Foo includes Bar. method `m` on Bar.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo.rb", [{ symbolId: "Foo", fqName: "Foo", shortName: "Foo", relPath: "foo.rb", scope: [] }]);
    table.upsertFile("bar.rb", [
      { symbolId: "Bar", fqName: "Bar", shortName: "Bar", relPath: "bar.rb", scope: [] },
      { symbolId: "Bar#m", fqName: "Bar#m", shortName: "m", relPath: "bar.rb", scope: ["Bar"] },
    ]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { x: [{ line: 1, type: "Foo" }] },
      classAncestors: { Foo: ["Bar"] },
    };
    const target = resolver.resolve({ callText: "x.m", receiver: "x", member: "m", startLine: 1 }, ctx);
    expect(target?.targetSymbolId).toBe("Bar#m");
  });

  it("falls back to file-only edge when method missing on bound class AND all ancestors", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("user.rb", [
      { symbolId: "User", fqName: "User", shortName: "User", relPath: "user.rb", scope: [] },
    ]);
    // ApplicationRecord exists but doesn't define `save` (it's inherited
    // from ActiveRecord::Base outside the project).
    table.upsertFile("application_record.rb", [
      {
        symbolId: "ApplicationRecord",
        fqName: "ApplicationRecord",
        shortName: "ApplicationRecord",
        relPath: "application_record.rb",
        scope: [],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { u: [{ line: 1, type: "User" }] },
      classAncestors: { User: ["ApplicationRecord"] },
    };
    const target = resolver.resolve({ callText: "u.save", receiver: "u", member: "save", startLine: 1 }, ctx);
    // Method-level dropped, file-level edge preserved (the bound class's file).
    expect(target?.targetRelPath).toBe("user.rb");
    expect(target?.targetSymbolId).toBeNull();
  });

  it("survives a self-referential ancestor cycle without stack overflow", () => {
    // Pathological case: A's ancestor is A itself (impossible in real Ruby,
    // defensive guard against malformed extraction).
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [{ symbolId: "A", fqName: "A", shortName: "A", relPath: "a.rb", scope: [] }]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { x: [{ line: 1, type: "A" }] },
      classAncestors: { A: ["A"] },
    };
    const target = resolver.resolve({ callText: "x.q", receiver: "x", member: "q", startLine: 1 }, ctx);
    expect(target?.targetRelPath).toBe("a.rb");
    expect(target?.targetSymbolId).toBeNull();
  });

  // Multi-step ancestor cycle: A → B → A. The visited set must prevent the
  // re-entry on A causing infinite recursion. Exercises the `visited.has`
  // guard via the inter-class loop rather than the trivial self-loop. The
  // recursion enters A, walks to B, B's ancestor is A which short-circuits,
  // B falls through to file-only edge but with targetSymbolId=null, so
  // A's loop discards that and itself falls to file-only — A's own file.
  it("breaks an A → B → A ancestor cycle via the visited guard", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [{ symbolId: "A", fqName: "A", shortName: "A", relPath: "a.rb", scope: [] }]);
    table.upsertFile("b.rb", [{ symbolId: "B", fqName: "B", shortName: "B", relPath: "b.rb", scope: [] }]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { x: [{ line: 1, type: "A" }] },
      classAncestors: { A: ["B"], B: ["A"] },
    };
    // `m` doesn't exist on A or B — both file-only edges. A's loop sees
    // B's inherited result has targetSymbolId=null, rejects it, falls
    // through to A's own file edge.
    const target = resolver.resolve({ callText: "x.m", receiver: "x", member: "m", startLine: 1 }, ctx);
    expect(target?.targetRelPath).toBe("a.rb");
    expect(target?.targetSymbolId).toBeNull();
  });

  // An ancestor that itself resolves to null (unknown class) — the loop
  // continues to the next ancestor and finds the method on it. Drives the
  // `inherited` null falsy branch after recursion, and the ancestor-loop
  // continuation past a failed ancestor.
  it("skips ancestor that doesn't resolve to a file and tries the next one", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo.rb", [{ symbolId: "Foo", fqName: "Foo", shortName: "Foo", relPath: "foo.rb", scope: [] }]);
    // First ancestor `Unknown` not in symbol table → resolveConstant returns null.
    // Second ancestor `Helper` defines `act`.
    table.upsertFile("helper.rb", [
      { symbolId: "Helper", fqName: "Helper", shortName: "Helper", relPath: "helper.rb", scope: [] },
      { symbolId: "Helper#act", fqName: "Helper#act", shortName: "act", relPath: "helper.rb", scope: ["Helper"] },
    ]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { x: [{ line: 1, type: "Foo" }] },
      classAncestors: { Foo: ["Unknown", "Helper"] },
    };
    const target = resolver.resolve({ callText: "x.act", receiver: "x", member: "act", startLine: 1 }, ctx);
    expect(target?.targetSymbolId).toBe("Helper#act");
    expect(target?.targetRelPath).toBe("helper.rb");
  });

  it("tries ancestors in declaration order — first match wins", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo.rb", [{ symbolId: "Foo", fqName: "Foo", shortName: "Foo", relPath: "foo.rb", scope: [] }]);
    table.upsertFile("first.rb", [
      { symbolId: "First", fqName: "First", shortName: "First", relPath: "first.rb", scope: [] },
      { symbolId: "First#shared", fqName: "First#shared", shortName: "shared", relPath: "first.rb", scope: ["First"] },
    ]);
    table.upsertFile("second.rb", [
      { symbolId: "Second", fqName: "Second", shortName: "Second", relPath: "second.rb", scope: [] },
      {
        symbolId: "Second#shared",
        fqName: "Second#shared",
        shortName: "shared",
        relPath: "second.rb",
        scope: ["Second"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { x: [{ line: 1, type: "Foo" }] },
      // Foo extends First, then includes Second — First wins for `shared`.
      classAncestors: { Foo: ["First", "Second"] },
    };
    const target = resolver.resolve({ callText: "x.shared", receiver: "x", member: "shared", startLine: 1 }, ctx);
    expect(target?.targetSymbolId).toBe("First#shared");
  });
});

// bd tea-rags-mcp-3jvn — `prepend M` inserts M BEFORE the class in MRO. When
// a bound variable's class A both prepends M and defines the same method
// itself, instance-method dispatch lands on M#foo (not A#foo). The walker
// emits prepended modules into a separate classPrependedAncestors map so
// the resolver walks them BEFORE the bound class's own methods.
describe("RubyCallResolver — Module#prepend ancestor priority (bd 3jvn)", () => {
  it("resolves instance method to prepended module instead of class's own method", () => {
    // class A; prepend M; def foo; ...end; end with M#foo also defined.
    // var: A → var.foo MUST land on M#foo (prepend shadows), not A#foo.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [
      { symbolId: "A", fqName: "A", shortName: "A", relPath: "a.rb", scope: [] },
      { symbolId: "A#foo", fqName: "A#foo", shortName: "foo", relPath: "a.rb", scope: ["A"] },
    ]);
    table.upsertFile("m.rb", [
      { symbolId: "M", fqName: "M", shortName: "M", relPath: "m.rb", scope: [] },
      { symbolId: "M#foo", fqName: "M#foo", shortName: "foo", relPath: "m.rb", scope: ["M"] },
    ]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { x: [{ line: 1, type: "A" }] },
      classPrependedAncestors: { A: ["M"] },
    };
    const target = resolver.resolve({ callText: "x.foo", receiver: "x", member: "foo", startLine: 1 }, ctx);
    expect(target?.targetSymbolId).toBe("M#foo");
    expect(target?.targetRelPath).toBe("m.rb");
  });

  it("iterates multiple prepends in REVERSE source order (last prepend wins in MRO)", () => {
    // class A; prepend M1; prepend M2; end → MRO walks M2 → M1 → A.
    // Both M1 and M2 define `foo`; M2 must win because it was prepended last.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [
      { symbolId: "A", fqName: "A", shortName: "A", relPath: "a.rb", scope: [] },
      { symbolId: "A#foo", fqName: "A#foo", shortName: "foo", relPath: "a.rb", scope: ["A"] },
    ]);
    table.upsertFile("m1.rb", [
      { symbolId: "M1", fqName: "M1", shortName: "M1", relPath: "m1.rb", scope: [] },
      { symbolId: "M1#foo", fqName: "M1#foo", shortName: "foo", relPath: "m1.rb", scope: ["M1"] },
    ]);
    table.upsertFile("m2.rb", [
      { symbolId: "M2", fqName: "M2", shortName: "M2", relPath: "m2.rb", scope: [] },
      { symbolId: "M2#foo", fqName: "M2#foo", shortName: "foo", relPath: "m2.rb", scope: ["M2"] },
    ]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { x: [{ line: 1, type: "A" }] },
      // Source order: M1 first, M2 second — resolver iterates in reverse.
      classPrependedAncestors: { A: ["M1", "M2"] },
    };
    const target = resolver.resolve({ callText: "x.foo", receiver: "x", member: "foo", startLine: 1 }, ctx);
    expect(target?.targetSymbolId).toBe("M2#foo");
  });

  it("falls through to the class itself when prepended modules don't define the member", () => {
    // class A; prepend M; def foo; end; end where M does NOT define foo.
    // var.foo lands on A#foo (prepend miss + class hit).
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [
      { symbolId: "A", fqName: "A", shortName: "A", relPath: "a.rb", scope: [] },
      { symbolId: "A#foo", fqName: "A#foo", shortName: "foo", relPath: "a.rb", scope: ["A"] },
    ]);
    table.upsertFile("m.rb", [{ symbolId: "M", fqName: "M", shortName: "M", relPath: "m.rb", scope: [] }]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { x: [{ line: 1, type: "A" }] },
      classPrependedAncestors: { A: ["M"] },
    };
    const target = resolver.resolve({ callText: "x.foo", receiver: "x", member: "foo", startLine: 1 }, ctx);
    expect(target?.targetSymbolId).toBe("A#foo");
  });

  it("regression: include `Mod` still resolves through classAncestors (no prepend interference)", () => {
    // class Foo; include Bar; end with Bar#m — unchanged behaviour, the
    // include path must still work after the prepend wiring lands.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo.rb", [{ symbolId: "Foo", fqName: "Foo", shortName: "Foo", relPath: "foo.rb", scope: [] }]);
    table.upsertFile("bar.rb", [
      { symbolId: "Bar", fqName: "Bar", shortName: "Bar", relPath: "bar.rb", scope: [] },
      { symbolId: "Bar#m", fqName: "Bar#m", shortName: "m", relPath: "bar.rb", scope: ["Bar"] },
    ]);
    const ctx: CallContext = {
      callerFile: "main.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
      localBindings: { x: [{ line: 1, type: "Foo" }] },
      classAncestors: { Foo: ["Bar"] },
      // No prepended ancestors — exercises the missing-map branch.
    };
    const target = resolver.resolve({ callText: "x.m", receiver: "x", member: "m", startLine: 1 }, ctx);
    expect(target?.targetSymbolId).toBe("Bar#m");
  });
});

describe("RubyCallResolver — AR Relation chain guard", () => {
  it("drops resolution when receiver is a chained AR-relation call (.ransack/.where/...)", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    // Plant a tempting global short-name match — without the guard,
    // the resolver would FP-attribute the call to this unrelated class.
    table.upsertFile("app/policies/abstract_policy.rb", [
      {
        symbolId: "AbstractPolicy#result",
        fqName: "AbstractPolicy#result",
        shortName: "result",
        relPath: "app/policies/abstract_policy.rb",
        scope: ["AbstractPolicy"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/controllers/products_controller.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
    };
    // `Product.ransack(form).result(distinct: true)` — chained on
    // AR::Relation, not on AbstractPolicy.
    const target = resolver.resolve(
      {
        callText: "Product.ransack(form).result(distinct: true)",
        receiver: "Product.ransack(form)",
        member: "result",
        startLine: 5,
      },
      ctx,
    );
    expect(target).toBeNull();
  });

  it("triggers the guard for each AR relation builder marker", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/services/x.rb", [
      {
        symbolId: "X#first",
        fqName: "X#first",
        shortName: "first",
        relPath: "app/services/x.rb",
        scope: ["X"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/controllers/x.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
    };
    for (const chain of [
      "User.where(active: true)",
      "User.order(:name)",
      "User.joins(:posts)",
      "User.includes(:posts)",
      "User.select(:id)",
      "User.group(:role)",
    ]) {
      const target = resolver.resolve(
        { callText: `${chain}.first`, receiver: chain, member: "first", startLine: 1 },
        ctx,
      );
      expect(target).toBeNull();
    }
  });

  it("does NOT trigger the AR-relation guard for plain receivers without dot-chained relation calls", () => {
    // The AR guard is keyed off dot-prefixed relation builders in the
    // receiver text (`.where(`, `.order(` etc.). A plain `obj.go`
    // receiver lacks any of those markers — the AR guard must NOT fire,
    // and resolution proceeds through the normal channels. With bug
    // tea-rags-mcp-lttd fixed the receiver-set drop guard returns null
    // when no channel matched (no zeitwerk constant, no require, no
    // local binding). The point of THIS test is to confirm the AR
    // guard's predicate doesn't over-match — assertion is on
    // `receiverLooksLikeArRelationChain("obj")` returning false, which
    // we observe indirectly: the AR guard's "drop on AR relation" path
    // is not the path that returns null here (the receiver-set drop
    // guard is).
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/services/x.rb", [
      {
        symbolId: "Helper#go",
        fqName: "Helper#go",
        shortName: "go",
        relPath: "app/services/x.rb",
        scope: ["Helper"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/controllers/x.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
    };
    // With receiver set + no import / zeitwerk / local-binding match,
    // the resolver drops the edge (lttd fix). The AR guard is irrelevant
    // here — what matters is that `obj` doesn't look like an AR chain.
    const target = resolver.resolve({ callText: "obj.go", receiver: "obj", member: "go", startLine: 1 }, ctx);
    expect(target).toBeNull();
  });
});

describe("RubyCallResolver — looksLikeConstant guard", () => {
  // Receiver text that doesn't match constant grammar (lowercase start,
  // e.g. `obj.method` rather than `Klass.method`) skips the
  // looksLikeConstant branch. Covers the false-branch of the regex on
  // line 132. With bug tea-rags-mcp-lttd fixed, the global short-name
  // fallback fires ONLY when receiver is null. A lowercase receiver
  // identifier (`obj.render`) means the dynamic type is unknown — falling
  // back to global short-name fabricated false-positive edges (huginn:
  // `agents.map(&:id)` → JS `d3.js#map`; sinatra: `Regexp.escape(domain)`
  // → `Rack::Protection::EscapedParams#escape`). Drop instead.
  it("drops the edge when lowercase receiver has no matching import/zeitwerk/local-binding", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("helpers.rb", [
      { symbolId: "render", fqName: "render", shortName: "render", relPath: "helpers.rb", scope: [] },
    ]);
    // `obj` is lowercase — looksLikeConstant returns false. No matching
    // require import. No local binding. Receiver-set + no resolution =
    // drop edge.
    const target = resolver.resolve(
      { callText: "obj.render", receiver: "obj", member: "render", startLine: 1 },
      makeCtx("main.rb", [], table),
    );
    expect(target).toBeNull();
  });
});

describe("RubyCallResolver — receiver-set drops edge when no resolution succeeds (bug lttd)", () => {
  // Mirrors java-resolver.test.ts (lines 105-176) drop-edge patterns —
  // when a receiver is set but no import / zeitwerk / local-binding
  // resolution succeeds, the resolver MUST return null instead of
  // falling through to the global short-name fallback. The fallback
  // fabricated false-positive edges across unrelated classes (and
  // across LANGUAGES in vendored / mixed-language repos).

  it("drops the edge for a chained-expression receiver with no import match (sinatra Regexp.escape case)", () => {
    // Real sinatra case: `host_authorization.rb` does `Regexp.escape(domain)`.
    // Old: global short-name "escape" matched the unique
    // `Rack::Protection::EscapedParams#escape` → false-positive cycle.
    // `Regexp` is a Ruby core constant (no project file backs it). Drop.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("rack/protection/escaped_params.rb", [
      {
        symbolId: "Rack::Protection::EscapedParams#escape",
        fqName: "Rack::Protection::EscapedParams#escape",
        shortName: "escape",
        relPath: "rack/protection/escaped_params.rb",
        scope: ["Rack", "Protection", "EscapedParams"],
      },
    ]);
    const target = resolver.resolve(
      { callText: "Regexp.escape(domain)", receiver: "Regexp", member: "escape", startLine: 1 },
      makeCtx("rack/protection/host_authorization.rb", [], table),
    );
    expect(target).toBeNull();
  });

  it("drops the edge for a local-variable receiver with no import or local binding", () => {
    // `serializer.is_valid` where `serializer` is a local with no
    // walker-inferred binding. Global short-name "is_valid" would match
    // some unrelated class — drop.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/forms/some_form.rb", [
      {
        symbolId: "SomeForm#is_valid",
        fqName: "SomeForm#is_valid",
        shortName: "is_valid",
        relPath: "app/forms/some_form.rb",
        scope: ["SomeForm"],
      },
    ]);
    const target = resolver.resolve(
      { callText: "serializer.is_valid", receiver: "serializer", member: "is_valid", startLine: 1 },
      makeCtx("app/controllers/x.rb", [], table),
    );
    expect(target).toBeNull();
  });

  it("drops the edge for a chained-method-call receiver (e.g. `agents.map`) with no resolution", () => {
    // Real huginn case: `agents.map(&:id)` — receiver `agents` is a local
    // collection. Without binding, the old global short-name fallback for
    // "map" matched the unique non-ruby `map` defined in
    // `vendor/assets/javascripts/d3.js` (parsed as a JS top-level
    // function). Drop the edge — cross-language pollution must never
    // surface as a Ruby caller→callee edge.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("vendor/assets/javascripts/d3.js", [
      {
        symbolId: "map",
        fqName: "map",
        shortName: "map",
        relPath: "vendor/assets/javascripts/d3.js",
        scope: [],
      },
    ]);
    const target = resolver.resolve(
      { callText: "agents.map(&:id)", receiver: "agents", member: "map", startLine: 1 },
      makeCtx("app/concerns/file_handling.rb", [], table),
    );
    expect(target).toBeNull();
  });

  it("drops the edge for an external (core-Ruby) class receiver with no project file backing", () => {
    // `Hash.new` where `Hash` is a Ruby builtin — no project file
    // defines it. With Zeitwerk pass 2 nothing matches; old global
    // short-name "new" would pick a unique project-defined `new` if any.
    // Drop instead.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/services/builder.rb", [
      {
        symbolId: "Builder.new",
        fqName: "Builder.new",
        shortName: "new",
        relPath: "app/services/builder.rb",
        scope: ["Builder"],
      },
    ]);
    const target = resolver.resolve(
      { callText: "Hash.new", receiver: "Hash", member: "new", startLine: 1 },
      makeCtx("app/controllers/x.rb", [], table),
    );
    expect(target).toBeNull();
  });

  it("still falls back to global short-name when receiver is null (bare top-level call)", () => {
    // Defense-in-depth: confirms the receiver-set drop does NOT regress
    // bare-call resolution. `do_thing` with no receiver, unique target →
    // resolves via global short-name fallback as before.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("helpers.rb", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "helpers.rb", scope: [] },
    ]);
    const target = resolver.resolve(
      { callText: "do_thing", receiver: null, member: "do_thing", startLine: 1 },
      makeCtx("main.rb", [], table),
    );
    expect(target?.targetRelPath).toBe("helpers.rb");
  });
});

describe("RubyCallResolver — bare-call same-class scope preference (bug t5iw)", () => {
  // Mirrors java-resolver.ts:50-54 scope-filter fallback. When a bare
  // call (no receiver) has multiple short-name candidates, prefer
  // candidates whose `scope[last]` matches the caller's enclosing class
  // (`callerScope[last]`). Without this, strict-mode pickSingleCandidate
  // returned null on ambiguity and dropped the edge — observed on huginn:
  // `Agents::PhantomJsCloudAgent#page_request_settings` contains a bare
  // `user_agent` call but `WebRequestConcern#user_agent` AND
  // `Agents::PhantomJsCloudAgent#user_agent` both exist with shortName
  // "user_agent", so the edge dropped silently.

  it("prefers same-class candidate when bare-call short-name is ambiguous across classes", () => {
    // Two definitions of `user_agent` — one on a concern, one on the
    // caller's own class. The bare `user_agent` call from inside
    // `Agents::PhantomJsCloudAgent#page_request_settings` must resolve to
    // the same-class definition, not be dropped as ambiguous.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/concerns/web_request_concern.rb", [
      {
        symbolId: "WebRequestConcern#user_agent",
        fqName: "WebRequestConcern#user_agent",
        shortName: "user_agent",
        relPath: "app/concerns/web_request_concern.rb",
        scope: ["WebRequestConcern"],
      },
    ]);
    table.upsertFile("app/models/agents/phantom_js_cloud_agent.rb", [
      {
        symbolId: "Agents::PhantomJsCloudAgent#user_agent",
        fqName: "Agents::PhantomJsCloudAgent#user_agent",
        shortName: "user_agent",
        relPath: "app/models/agents/phantom_js_cloud_agent.rb",
        scope: ["Agents", "PhantomJsCloudAgent"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/models/agents/phantom_js_cloud_agent.rb",
      callerScope: ["Agents", "PhantomJsCloudAgent"],
      imports: [],
      symbolTable: table,
    };
    const target = resolver.resolve(
      { callText: "user_agent", receiver: null, member: "user_agent", startLine: 96 },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("Agents::PhantomJsCloudAgent#user_agent");
    expect(target?.targetRelPath).toBe("app/models/agents/phantom_js_cloud_agent.rb");
  });

  it("returns null when caller scope matches NEITHER ambiguous candidate", () => {
    // Same two definitions, but caller is in a third unrelated class.
    // Scope filter narrows to zero same-class candidates → fall back to
    // strict pickSingleCandidate over the original ambiguous list → null.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [
      { symbolId: "ClassA#foo", fqName: "ClassA#foo", shortName: "foo", relPath: "a.rb", scope: ["ClassA"] },
    ]);
    table.upsertFile("b.rb", [
      { symbolId: "ClassB#foo", fqName: "ClassB#foo", shortName: "foo", relPath: "b.rb", scope: ["ClassB"] },
    ]);
    const ctx: CallContext = {
      callerFile: "c.rb",
      callerScope: ["ClassC"],
      imports: [],
      symbolTable: table,
    };
    const target = resolver.resolve({ callText: "foo", receiver: null, member: "foo", startLine: 1 }, ctx);
    expect(target).toBeNull();
  });

  it("does NOT prefer ancestor-class candidates — only same-class wins (ancestor preference is out of scope for t5iw)", () => {
    // `WebRequestConcern#user_agent` is mixed into PhantomJsCloudAgent
    // via `include WebRequestConcern`. The caller scope is the agent
    // class, ancestor candidate is in a different class. With ONLY the
    // ancestor-class candidate present, the scope filter narrows to
    // zero same-class candidates → fall back to global pickSingleCandidate
    // on the unfiltered list (one candidate left) → resolves to the
    // ancestor. This documents that t5iw fixes ONLY same-class
    // disambiguation; deeper ancestor-walk preference is follow-up brp1.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/concerns/web_request_concern.rb", [
      {
        symbolId: "WebRequestConcern#user_agent",
        fqName: "WebRequestConcern#user_agent",
        shortName: "user_agent",
        relPath: "app/concerns/web_request_concern.rb",
        scope: ["WebRequestConcern"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/models/agents/phantom_js_cloud_agent.rb",
      callerScope: ["Agents", "PhantomJsCloudAgent"],
      imports: [],
      symbolTable: table,
      classAncestors: { "Agents::PhantomJsCloudAgent": ["WebRequestConcern"] },
    };
    const target = resolver.resolve(
      { callText: "user_agent", receiver: null, member: "user_agent", startLine: 96 },
      ctx,
    );
    // Only one candidate exists → unambiguous global short-name fallback.
    expect(target?.targetSymbolId).toBe("WebRequestConcern#user_agent");
  });

  it("regression: bare call with empty callerScope still resolves unambiguously when only one candidate exists", () => {
    // Top-level helper call from a file with no enclosing class
    // (callerScope=[]). Scope-filter yields zero (no last element to
    // match), fall back to global short-name lookup with unique target.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("helpers.rb", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "helpers.rb", scope: [] },
    ]);
    const target = resolver.resolve(
      { callText: "do_thing", receiver: null, member: "do_thing", startLine: 1 },
      makeCtx("main.rb", [], table),
    );
    expect(target?.targetRelPath).toBe("helpers.rb");
  });
});

// bd tea-rags-mcp-jsa0 — requireMatch predicate must not unconditionally accept
// bare calls. Pre-fix, `call.receiver === null || ...` made the predicate
// always return true for bare calls — every bare call short-circuited into the
// requireMatch branch with an arbitrary import file as target, blocking the
// t5iw same-class fallback below it. Live huginn confirmed:
// `Agents::PhantomJsCloudAgent#page_request_settings` calls `user_agent` (bare)
// but `get_callers(Agents::PhantomJsCloudAgent#user_agent)` returned `[]`
// because the bare call was absorbed into a file edge to an unrelated require'd
// file. Fix: require receiver to be non-null AND match the import text.
describe("RubyCallResolver — bare call must not shortcut into requireMatch (bug jsa0)", () => {
  it("bare call falls through to t5iw same-class fallback when unrelated require exists", () => {
    // Reproduces the huginn case. Caller is inside Agents::PhantomJsCloudAgent;
    // the file has unrelated `require 'json'`-style imports plus a same-class
    // `user_agent` definition. Pre-fix: bare `user_agent` resolved to the
    // unrelated 'json' file (file-only, targetSymbolId=null). Post-fix: it
    // resolves via t5iw same-class preference to the agent's own user_agent.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/concerns/web_request_concern.rb", [
      {
        symbolId: "WebRequestConcern#user_agent",
        fqName: "WebRequestConcern#user_agent",
        shortName: "user_agent",
        relPath: "app/concerns/web_request_concern.rb",
        scope: ["WebRequestConcern"],
      },
    ]);
    table.upsertFile("app/models/agents/phantom_js_cloud_agent.rb", [
      {
        symbolId: "Agents::PhantomJsCloudAgent#user_agent",
        fqName: "Agents::PhantomJsCloudAgent#user_agent",
        shortName: "user_agent",
        relPath: "app/models/agents/phantom_js_cloud_agent.rb",
        scope: ["Agents", "PhantomJsCloudAgent"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/models/agents/phantom_js_cloud_agent.rb",
      callerScope: ["Agents", "PhantomJsCloudAgent"],
      // The actual file `require 'json'` — unrelated to the user_agent call,
      // but pre-fix it was treated as a viable requireMatch target.
      imports: [{ importText: "json", startLine: 1 }],
      symbolTable: table,
    };
    const target = resolver.resolve(
      { callText: "user_agent", receiver: null, member: "user_agent", startLine: 96 },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("Agents::PhantomJsCloudAgent#user_agent");
    expect(target?.targetRelPath).toBe("app/models/agents/phantom_js_cloud_agent.rb");
  });

  it("bare call to nonexistent symbol with unrelated require returns null (not file edge to the require'd file)", () => {
    // Pre-fix: bare `nonexistent_helper` with `require 'json'` resolved to
    // { targetRelPath: <some json file from knownPaths>, targetSymbolId: null }
    // because the requireMatch predicate accepted any bare-call+import combo.
    // Post-fix: the require predicate skips bare calls; global short-name
    // fallback finds zero candidates → null.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    // Plant an unrelated indexed file so knownPaths contains a basename
    // matching the import. Pre-fix the resolver would attribute the bare
    // call to this file.
    table.upsertFile("vendor/lib/json.rb", [
      {
        symbolId: "JSON",
        fqName: "JSON",
        shortName: "JSON",
        relPath: "vendor/lib/json.rb",
        scope: [],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/services/something.rb",
      callerScope: ["Something"],
      imports: [
        { importText: "json", startLine: 1 },
        { importText: "vendor/lib/json.rb", startLine: 2 },
      ],
      symbolTable: table,
    };
    const target = resolver.resolve(
      { callText: "nonexistent_helper", receiver: null, member: "nonexistent_helper", startLine: 5 },
      ctx,
    );
    expect(target).toBeNull();
  });

  it("require_relative './foo' branch does not match unrelated bare calls", () => {
    // Pre-fix: line 108 had `return target === ctx.callerFile || true;` which
    // is ALWAYS true — any bare call with any require_relative in scope
    // shortcuts to file-edge of that relative file. Post-fix: predicate
    // requires receiver to non-null AND match the import basename.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    // Plant a same-class helper so the t5iw fallback can pin the bare call.
    table.upsertFile("app/services/something.rb", [
      {
        symbolId: "Something#helper",
        fqName: "Something#helper",
        shortName: "helper",
        relPath: "app/services/something.rb",
        scope: ["Something"],
      },
    ]);
    // Also plant a different shortName helper in the require_relative target
    // so we'd see the wrong attribution if the bug were still present.
    table.upsertFile("app/services/foo.rb", [
      {
        symbolId: "Foo#bar",
        fqName: "Foo#bar",
        shortName: "bar",
        relPath: "app/services/foo.rb",
        scope: ["Foo"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/services/something.rb",
      callerScope: ["Something"],
      imports: [{ importText: "./foo", startLine: 1 }],
      symbolTable: table,
    };
    const target = resolver.resolve({ callText: "helper", receiver: null, member: "helper", startLine: 5 }, ctx);
    // t5iw same-class wins; require_relative does NOT shortcut.
    expect(target?.targetSymbolId).toBe("Something#helper");
    expect(target?.targetRelPath).toBe("app/services/something.rb");
  });

  it("regression: explicit-receiver bare-require call still matches importText (call.receiver === imp.importText)", () => {
    // The pre-existing happy path: `require 'foo'` then `foo.bar` (where
    // `foo` is the receiver text and `foo` matches the importText). Must
    // still resolve to the require'd file. This documents that the fix
    // tightens but does not break receiver===importText matching.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("vendor/lib/foo.rb", [
      { symbolId: "Foo", fqName: "Foo", shortName: "Foo", relPath: "vendor/lib/foo.rb", scope: [] },
      { symbolId: "Foo#bar", fqName: "Foo#bar", shortName: "bar", relPath: "vendor/lib/foo.rb", scope: ["Foo"] },
    ]);
    const target = resolver.resolve(
      { callText: "bar", receiver: "foo", member: "bar", startLine: 1 },
      makeCtx(
        "main.rb",
        [
          { importText: "foo", startLine: 1 },
          { importText: "vendor/lib/foo.rb", startLine: 2 },
        ],
        table,
      ),
    );
    expect(target?.targetRelPath).toBe("vendor/lib/foo.rb");
    expect(target?.targetSymbolId).toBe("Foo#bar");
  });
});

describe("RubyCallResolver — nested class constant lookup via enclosing scope walk (bug ohz5)", () => {
  // Mirrors Ruby's runtime Module.nesting constant lookup. When a method
  // inside `class Agents::StubhubAgent` references a bare constant
  // `StubhubFetcher`, Ruby walks the enclosing scopes upward looking for
  // `Agents::StubhubAgent::StubhubFetcher`, then `Agents::StubhubFetcher`,
  // then top-level `StubhubFetcher`. The resolver must mirror this so the
  // call edge from `fetch_stubhub_data` to the nested class's class method
  // is preserved instead of dropped.

  it("resolves a sibling-nested constant via the enclosing class scope", () => {
    // Real huginn case (app/models/agents/stubhub_agent.rb): inside
    // `Agents::StubhubAgent#fetch_stubhub_data`, `StubhubFetcher.call(url)`
    // refers to the inner class `Agents::StubhubAgent::StubhubFetcher`
    // declared lexically in the same file.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/agents/stubhub_agent.rb", [
      {
        symbolId: "Agents::StubhubAgent",
        fqName: "Agents::StubhubAgent",
        shortName: "StubhubAgent",
        relPath: "app/models/agents/stubhub_agent.rb",
        scope: ["Agents"],
      },
      {
        symbolId: "Agents::StubhubAgent::StubhubFetcher",
        fqName: "Agents::StubhubAgent::StubhubFetcher",
        shortName: "StubhubFetcher",
        relPath: "app/models/agents/stubhub_agent.rb",
        scope: ["Agents", "StubhubAgent"],
      },
      {
        symbolId: "Agents::StubhubAgent::StubhubFetcher.call",
        fqName: "Agents::StubhubAgent::StubhubFetcher.call",
        shortName: "call",
        relPath: "app/models/agents/stubhub_agent.rb",
        scope: ["Agents", "StubhubAgent", "StubhubFetcher"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/models/agents/stubhub_agent.rb",
      // Walker emits scope as the class-name segments leading to the
      // enclosing method's owner — for a method in
      // `class Agents::StubhubAgent`, that's ["Agents", "StubhubAgent"].
      callerScope: ["Agents", "StubhubAgent"],
      imports: [],
      symbolTable: table,
    };
    const target = resolver.resolve(
      { callText: "StubhubFetcher.call(url)", receiver: "StubhubFetcher", member: "call", startLine: 49 },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("Agents::StubhubAgent::StubhubFetcher.call");
    expect(target?.targetRelPath).toBe("app/models/agents/stubhub_agent.rb");
  });

  it("resolves a cousin constant declared under a shared outer module", () => {
    // `module A::B; class C; def self.go; end; end; class D; def hop; C.go; end; end; end`
    // From inside `A::B::D#hop`, the bare reference `C` should walk up to
    // the enclosing `A::B` scope and find `A::B::C`.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a/b/c.rb", [
      {
        symbolId: "A::B::C",
        fqName: "A::B::C",
        shortName: "C",
        relPath: "a/b/c.rb",
        scope: ["A", "B"],
      },
      {
        symbolId: "A::B::C.go",
        fqName: "A::B::C.go",
        shortName: "go",
        relPath: "a/b/c.rb",
        scope: ["A", "B", "C"],
      },
    ]);
    table.upsertFile("a/b/d.rb", [
      {
        symbolId: "A::B::D",
        fqName: "A::B::D",
        shortName: "D",
        relPath: "a/b/d.rb",
        scope: ["A", "B"],
      },
      {
        symbolId: "A::B::D#hop",
        fqName: "A::B::D#hop",
        shortName: "hop",
        relPath: "a/b/d.rb",
        scope: ["A", "B", "D"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "a/b/d.rb",
      callerScope: ["A", "B", "D"],
      imports: [],
      symbolTable: table,
    };
    const target = resolver.resolve({ callText: "C.go", receiver: "C", member: "go", startLine: 3 }, ctx);
    expect(target?.targetSymbolId).toBe("A::B::C.go");
    expect(target?.targetRelPath).toBe("a/b/c.rb");
  });

  it("returns null when the same bare constant exists under multiple enclosing-scope prefixes (ambiguous)", () => {
    // Both `Agents::StubhubAgent::Helper` and `Agents::Helper` exist —
    // the walk produces two candidates from different prefix levels.
    // Without a deterministic tie-breaker the resolver MUST return null
    // rather than guess (mirrors pickSingleCandidate strict semantics).
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("inner.rb", [
      {
        symbolId: "Agents::StubhubAgent::Helper",
        fqName: "Agents::StubhubAgent::Helper",
        shortName: "Helper",
        relPath: "inner.rb",
        scope: ["Agents", "StubhubAgent"],
      },
      {
        symbolId: "Agents::StubhubAgent::Helper.run",
        fqName: "Agents::StubhubAgent::Helper.run",
        shortName: "run",
        relPath: "inner.rb",
        scope: ["Agents", "StubhubAgent", "Helper"],
      },
    ]);
    table.upsertFile("outer.rb", [
      {
        symbolId: "Agents::Helper",
        fqName: "Agents::Helper",
        shortName: "Helper",
        relPath: "outer.rb",
        scope: ["Agents"],
      },
      {
        symbolId: "Agents::Helper.run",
        fqName: "Agents::Helper.run",
        shortName: "run",
        relPath: "outer.rb",
        scope: ["Agents", "Helper"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "caller.rb",
      callerScope: ["Agents", "StubhubAgent"],
      imports: [],
      symbolTable: table,
    };
    // Ruby's actual lookup would pick the innermost — but the resolver
    // walks each prefix as an INDEPENDENT lookup and would find one
    // candidate at the innermost prefix and one at the outer prefix.
    // The innermost SHOULD win deterministically (Ruby semantics).
    const target = resolver.resolve({ callText: "Helper.run", receiver: "Helper", member: "run", startLine: 3 }, ctx);
    // Innermost wins (Module.nesting semantics).
    expect(target?.targetSymbolId).toBe("Agents::StubhubAgent::Helper.run");
    expect(target?.targetRelPath).toBe("inner.rb");
  });

  it("regression: top-level constant lookup still works when no enclosing-scope match exists", () => {
    // `User.find` from a controller at callerScope=[] (top-level file).
    // The enclosing-scope walk should produce zero candidates (empty
    // scope) and fall through to the existing direct-fqName +
    // Zeitwerk-convention passes.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/user.rb", [
      { symbolId: "User", fqName: "User", shortName: "User", relPath: "app/models/user.rb", scope: [] },
      {
        symbolId: "User.find",
        fqName: "User.find",
        shortName: "find",
        relPath: "app/models/user.rb",
        scope: ["User"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/controllers/users_controller.rb",
      callerScope: [],
      imports: [],
      symbolTable: table,
    };
    const target = resolver.resolve({ callText: "User.find(1)", receiver: "User", member: "find", startLine: 4 }, ctx);
    expect(target?.targetSymbolId).toBe("User.find");
    expect(target?.targetRelPath).toBe("app/models/user.rb");
  });
});

// bd tea-rags-mcp-brp1 — `super` walks the parent class chain via classAncestors
// rather than dispatching on a textual receiver. Walker emits CallRef with
// receiver = SUPER_RECEIVER_SENTINEL ("<super>") and member = enclosing method
// name. Resolver detects the sentinel and reuses the same ancestor-walk logic
// the Zeitwerk `Class.method` branch uses, scoped to instance-method shapes.
describe("RubyCallResolver — super keyword resolution (bd brp1)", () => {
  it("resolves bare `super` to the parent class's same-named instance method", () => {
    // class A < B; def foo; super; end; end + B has def foo → resolves to B#foo.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [{ symbolId: "A", fqName: "A", shortName: "A", relPath: "a.rb", scope: [] }]);
    table.upsertFile("b.rb", [
      { symbolId: "B", fqName: "B", shortName: "B", relPath: "b.rb", scope: [] },
      { symbolId: "B#foo", fqName: "B#foo", shortName: "foo", relPath: "b.rb", scope: ["B"] },
    ]);
    const ctx: CallContext = {
      callerFile: "a.rb",
      callerScope: ["A"],
      imports: [],
      symbolTable: table,
      classAncestors: { A: ["B"] },
    };
    const target = resolver.resolve({ callText: "super", receiver: "<super>", member: "foo", startLine: 3 }, ctx);
    expect(target?.targetSymbolId).toBe("B#foo");
    expect(target?.targetRelPath).toBe("b.rb");
  });

  it("walks multi-level inheritance — A < B < C resolves `super` from A through to C#foo", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [{ symbolId: "A", fqName: "A", shortName: "A", relPath: "a.rb", scope: [] }]);
    table.upsertFile("b.rb", [{ symbolId: "B", fqName: "B", shortName: "B", relPath: "b.rb", scope: [] }]);
    table.upsertFile("c.rb", [
      { symbolId: "C", fqName: "C", shortName: "C", relPath: "c.rb", scope: [] },
      { symbolId: "C#foo", fqName: "C#foo", shortName: "foo", relPath: "c.rb", scope: ["C"] },
    ]);
    const ctx: CallContext = {
      callerFile: "a.rb",
      callerScope: ["A"],
      imports: [],
      symbolTable: table,
      // B defines no foo — chain walks past it to C.
      classAncestors: { A: ["B"], B: ["C"] },
    };
    const target = resolver.resolve({ callText: "super", receiver: "<super>", member: "foo", startLine: 3 }, ctx);
    expect(target?.targetSymbolId).toBe("C#foo");
    expect(target?.targetRelPath).toBe("c.rb");
  });

  it("returns null targetSymbolId when parent class is outside the project (ApplicationRecord case)", () => {
    // class User < ApplicationRecord; def save; super; end; end — ApplicationRecord
    // is indexed but its parent ActiveRecord::Base lives outside the project.
    // Resolver returns file-only edge when ancestor's file known but method missing;
    // returns null entirely when neither ancestor file nor method is found.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("user.rb", [
      { symbolId: "User", fqName: "User", shortName: "User", relPath: "user.rb", scope: [] },
    ]);
    // ApplicationRecord NOT in symbol table — represents an out-of-project parent.
    const ctx: CallContext = {
      callerFile: "user.rb",
      callerScope: ["User"],
      imports: [],
      symbolTable: table,
      classAncestors: { User: ["ApplicationRecord"] },
    };
    const target = resolver.resolve({ callText: "super", receiver: "<super>", member: "save", startLine: 5 }, ctx);
    // Parent class file unknown, method unknown — drop the edge cleanly.
    expect(target).toBeNull();
  });

  it("returns null when no classAncestors entry exists for the caller's class", () => {
    // Defensive: bare `class A` with no superclass declared — super can't resolve.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [{ symbolId: "A", fqName: "A", shortName: "A", relPath: "a.rb", scope: [] }]);
    const ctx: CallContext = {
      callerFile: "a.rb",
      callerScope: ["A"],
      imports: [],
      symbolTable: table,
    };
    const target = resolver.resolve({ callText: "super", receiver: "<super>", member: "foo", startLine: 3 }, ctx);
    expect(target).toBeNull();
  });

  it("resolves super for qualified enclosing class (`Acme::User`)", () => {
    // huginn-shape: class Agents::JavaScriptAgent::ConditionalFollowRedirects < Faraday::Middleware.
    // callerScope is the lexical scope chain, joined by `::` to obtain the FQ class key.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("middleware.rb", [
      {
        symbolId: "Faraday::Middleware",
        fqName: "Faraday::Middleware",
        shortName: "Middleware",
        relPath: "middleware.rb",
        scope: ["Faraday"],
      },
      {
        symbolId: "Faraday::Middleware#call",
        fqName: "Faraday::Middleware#call",
        shortName: "call",
        relPath: "middleware.rb",
        scope: ["Faraday", "Middleware"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "javascript_agent.rb",
      callerScope: ["Agents", "JavaScriptAgent", "ConditionalFollowRedirects"],
      imports: [],
      symbolTable: table,
      classAncestors: {
        "Agents::JavaScriptAgent::ConditionalFollowRedirects": ["Faraday::Middleware"],
      },
    };
    const target = resolver.resolve({ callText: "super", receiver: "<super>", member: "call", startLine: 30 }, ctx);
    expect(target?.targetSymbolId).toBe("Faraday::Middleware#call");
    expect(target?.targetRelPath).toBe("middleware.rb");
  });
});

// bd tea-rags-mcp-hbie — Bare-identifier CallRefs emitted by the walker for
// parenless method references must reach the global short-name fallback path
// (since they have receiver=null) and bind to a real edge when the symbol
// table holds a same-class candidate.
describe("RubyCallResolver — bare identifier calls (bd hbie)", () => {
  it("resolves a bare CallRef to a same-class method via the t5iw scope filter", () => {
    // Fixture: class A defines two methods; `foo` calls `bar` as a bare
    // identifier (`receiver = null`). With the walker now emitting bare
    // identifiers, the resolver's same-class scope filter should bind the
    // bare call to A#bar.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.rb", [
      { symbolId: "A", fqName: "A", shortName: "A", relPath: "a.rb", scope: [] },
      { symbolId: "A#foo", fqName: "A#foo", shortName: "foo", relPath: "a.rb", scope: ["A"] },
      { symbolId: "A#bar", fqName: "A#bar", shortName: "bar", relPath: "a.rb", scope: ["A"] },
    ]);
    const ctx: CallContext = {
      callerFile: "a.rb",
      callerScope: ["A"],
      imports: [],
      symbolTable: table,
    };
    const target = resolver.resolve({ callText: "bar", receiver: null, member: "bar", startLine: 3 }, ctx);
    expect(target?.targetRelPath).toBe("a.rb");
    expect(target?.targetSymbolId).toBe("A#bar");
  });

  it("resolves a bare CallRef to a same-class override across multiple definitions", () => {
    // huginn shape: WebRequestConcern#user_agent + PhantomJsCloudAgent#user_agent
    // both exist. Bare `user_agent` inside PhantomJsCloudAgent must bind to
    // the same-class override via the t5iw scope filter, not to the concern.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/concerns/web_request_concern.rb", [
      {
        symbolId: "WebRequestConcern#user_agent",
        fqName: "WebRequestConcern#user_agent",
        shortName: "user_agent",
        relPath: "app/concerns/web_request_concern.rb",
        scope: ["WebRequestConcern"],
      },
    ]);
    table.upsertFile("app/models/agents/phantom_js_cloud_agent.rb", [
      {
        symbolId: "Agents::PhantomJsCloudAgent#user_agent",
        fqName: "Agents::PhantomJsCloudAgent#user_agent",
        shortName: "user_agent",
        relPath: "app/models/agents/phantom_js_cloud_agent.rb",
        scope: ["Agents", "PhantomJsCloudAgent"],
      },
      {
        symbolId: "Agents::PhantomJsCloudAgent#page_request_settings",
        fqName: "Agents::PhantomJsCloudAgent#page_request_settings",
        shortName: "page_request_settings",
        relPath: "app/models/agents/phantom_js_cloud_agent.rb",
        scope: ["Agents", "PhantomJsCloudAgent"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/models/agents/phantom_js_cloud_agent.rb",
      callerScope: ["Agents", "PhantomJsCloudAgent"],
      imports: [],
      symbolTable: table,
    };
    const target = resolver.resolve(
      { callText: "user_agent", receiver: null, member: "user_agent", startLine: 12 },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("Agents::PhantomJsCloudAgent#user_agent");
  });
});

// Bug tea-rags-mcp-8ss5 — end-to-end resolver check for send-dispatch.
// The walker normalises `self.send(:foo)` and bare `send(:foo)` to a bare
// CallRef (receiver=null, member="foo"). The resolver's existing same-class
// bare-call fallback then picks the enclosing class via callerScope. This
// test asserts the union of the two pieces lands the edge on the right
// instance method.
describe("RubyCallResolver — send-dispatch end-to-end with literal symbol", () => {
  it("resolves `self.send(:foo)` (walker-unwrapped to bare member) to enclosing class member", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    // Two same-shortName entries to make pickSingleCandidate fail without
    // the callerScope filter — only callerScope discriminates here.
    table.upsertFile("app/services/foo.rb", [
      {
        symbolId: "Foo#helper",
        fqName: "Foo#helper",
        shortName: "helper",
        relPath: "app/services/foo.rb",
        scope: ["Foo"],
      },
    ]);
    table.upsertFile("app/services/bar.rb", [
      {
        symbolId: "Bar#helper",
        fqName: "Bar#helper",
        shortName: "helper",
        relPath: "app/services/bar.rb",
        scope: ["Bar"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/services/foo.rb",
      callerScope: ["Foo"],
      imports: [],
      symbolTable: table,
    };
    // The walker would have emitted this CallRef from `self.send(:helper)`.
    const target = resolver.resolve(
      { callText: "self.send(:helper)", receiver: null, member: "helper", startLine: 2 },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("Foo#helper");
  });
});

// bd tea-rags-mcp-meh1 — Symbol#to_proc synthetic call edges. The walker emits
// the to-proc symbol as a bare CallRef (receiver=null, member=symbol-text).
// Resolution piggybacks on the existing same-class scope filter (t5iw): when
// the synthetic call sits inside a class whose `scope[last]` matches one of
// the global short-name candidates, that candidate wins.
describe("RubyCallResolver — Symbol#to_proc bare-call resolution (bd meh1)", () => {
  it("resolves &:active? synthetic call to the same class's #active? method", () => {
    // class User; def active?; end; def filter_active; users.filter(&:active?); end; end
    // Walker emits a synthetic `active?` CallRef with receiver=null inside
    // `User#filter_active`'s chunk. The resolver's same-class scope filter
    // picks `User#active?` over any other class-level `active?` definition.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/user.rb", [
      { symbolId: "User", fqName: "User", shortName: "User", relPath: "app/models/user.rb", scope: [] },
      {
        symbolId: "User#active?",
        fqName: "User#active?",
        shortName: "active?",
        relPath: "app/models/user.rb",
        scope: ["User"],
      },
      {
        symbolId: "User#filter_active",
        fqName: "User#filter_active",
        shortName: "filter_active",
        relPath: "app/models/user.rb",
        scope: ["User"],
      },
    ]);
    // Another class with a same-short-name method would otherwise be
    // selected by global lookup; the same-class filter must prefer User.
    table.upsertFile("app/models/post.rb", [
      {
        symbolId: "Post#active?",
        fqName: "Post#active?",
        shortName: "active?",
        relPath: "app/models/post.rb",
        scope: ["Post"],
      },
    ]);
    const ctx: CallContext = {
      callerFile: "app/models/user.rb",
      callerScope: ["User"],
      imports: [],
      symbolTable: table,
    };
    const target = resolver.resolve({ callText: "&:active?", receiver: null, member: "active?", startLine: 3 }, ctx);
    expect(target?.targetSymbolId).toBe("User#active?");
    expect(target?.targetRelPath).toBe("app/models/user.rb");
  });
});

// bd tea-rags-mcp-3pnz — ActiveSupport::Concern `included do` / `class_methods do`
// mixin propagation. A Concern module `Trackable` is mixed into `User` via
// `include Trackable`; the walker already records `classAncestors.User =
// ["Trackable"]`. This characterization suite pins the EXACT resolver boundary:
// instance-method and `.`-form class-method propagation already work end-to-end
// through the existing ancestor walk, so the remaining gap is purely at the
// symbol-EXTRACTION layer — methods declared in `class_methods do ... end` must
// be indexed in class-method (`.`) form, not instance (`#`) form. Once they are,
// these tests show the resolver routes `User.<method>` to the Concern with NO
// resolver change. See the design-decision note in the bd issue.
describe("RubyCallResolver — ActiveSupport::Concern mixin propagation (bd tea-rags-mcp-3pnz)", () => {
  // Build a symbol table for a Concern `Trackable` (declaring `track_change`
  // as an instance method and `find_tracked` as a class method whose indexed
  // FORM is parameterised) mixed into `User`. `classMethodForm` toggles how the
  // `class_methods do` method is indexed: `"#"` = today's reality (the shared
  // chunker emits a plain `def` as instance-form), `"."` = the promoted form
  // the symbol-extraction fix must produce.
  function tableWithConcern(classMethodForm: "#" | "."): InMemoryGlobalSymbolTable {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/concerns/trackable.rb", [
      {
        symbolId: "Trackable",
        fqName: "Trackable",
        shortName: "Trackable",
        relPath: "app/concerns/trackable.rb",
        scope: [],
      },
      {
        // `def track_change` in the Concern body (or in `included do`) — an
        // instance method on every includer.
        symbolId: "Trackable#track_change",
        fqName: "Trackable#track_change",
        shortName: "track_change",
        relPath: "app/concerns/trackable.rb",
        scope: ["Trackable"],
      },
      {
        // `def find_tracked` declared inside `class_methods do ... end` — a
        // CLASS method on every includer (`User.find_tracked`).
        symbolId: `Trackable${classMethodForm}find_tracked`,
        fqName: `Trackable${classMethodForm}find_tracked`,
        shortName: "find_tracked",
        relPath: "app/concerns/trackable.rb",
        scope: ["Trackable"],
      },
    ]);
    table.upsertFile("app/models/user.rb", [
      { symbolId: "User", fqName: "User", shortName: "User", relPath: "app/models/user.rb", scope: [] },
    ]);
    return table;
  }

  it("WORKS TODAY: instance `track_change` propagates to includer via classAncestors", () => {
    // Bare call from inside `User` to a method only the Concern defines. The
    // bare-call / ancestor walk resolves it to `Trackable#track_change`.
    const resolver = new RubyCallResolver();
    const ctx: CallContext = {
      callerFile: "app/models/user.rb",
      callerScope: ["User"],
      imports: [],
      symbolTable: tableWithConcern("#"),
      classAncestors: { User: ["Trackable"] },
    };
    const target = resolver.resolve(
      { callText: "track_change", receiver: null, member: "track_change", startLine: 5 },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("Trackable#track_change");
    expect(target?.targetRelPath).toBe("app/concerns/trackable.rb");
  });

  it("WORKS TODAY: `User.find_tracked` propagates when class method is indexed in `.` form", () => {
    // GIVEN the symbol-extraction fix promotes `class_methods do` methods to
    // class-method (`.`) form, the EXISTING walkAncestorsForConstantCall routes
    // `User.find_tracked` to `Trackable.find_tracked` with no resolver change.
    const resolver = new RubyCallResolver();
    const ctx: CallContext = {
      callerFile: "app/controllers/users_controller.rb",
      callerScope: [],
      imports: [],
      symbolTable: tableWithConcern("."),
      classAncestors: { User: ["Trackable"] },
    };
    const target = resolver.resolve(
      { callText: "User.find_tracked", receiver: "User", member: "find_tracked", startLine: 9 },
      ctx,
    );
    expect(target?.targetSymbolId).toBe("Trackable.find_tracked");
    expect(target?.targetRelPath).toBe("app/concerns/trackable.rb");
  });

  it("BOUNDARY: `User.find_tracked` is file-only when the class method is indexed in `#` form", () => {
    // Today's reality: the shared cross-language chunker emits a plain `def`
    // inside `class_methods do` as instance-form (`Trackable#find_tracked`).
    // `Klass.method` dispatch only accepts `.`-form ancestors, so the call
    // degrades to a file-only edge on `User` (method-level attribution lost).
    // Closing this requires class-method PROMOTION at symbol extraction — the
    // design decision recorded on the bd issue. This test documents the current
    // contract so the future fix has a regression anchor to flip.
    const resolver = new RubyCallResolver();
    const ctx: CallContext = {
      callerFile: "app/controllers/users_controller.rb",
      callerScope: [],
      imports: [],
      symbolTable: tableWithConcern("#"),
      classAncestors: { User: ["Trackable"] },
    };
    const target = resolver.resolve(
      { callText: "User.find_tracked", receiver: "User", member: "find_tracked", startLine: 9 },
      ctx,
    );
    expect(target?.targetSymbolId).toBeNull();
    expect(target?.targetRelPath).toBe("app/models/user.rb");
  });
});
