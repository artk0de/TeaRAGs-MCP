import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import { ZEITWERK_PREFIX } from "../../../../../../../../src/core/domains/ingest/pipeline/chunker/extraction/ruby-walker.js";
import { RubyCallResolver } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ruby/ruby-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

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
      localBindings: { policy: "AbstractPolicy" },
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
      localBindings: { u: "User" },
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
      localBindings: { thing: "UnknownClassNotInSymbolTable" },
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
      localBindings: { form: "Product::IndexForm" },
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
      localBindings: { x: "Foo" },
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
      localBindings: { form: "Product::IndexForm" },
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
      localBindings: { x: "Foo" },
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
      localBindings: { u: "User" },
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
      localBindings: { x: "A" },
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
      localBindings: { x: "A" },
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
      localBindings: { x: "Foo" },
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
      localBindings: { x: "Foo" },
      // Foo extends First, then includes Second — First wins for `shared`.
      classAncestors: { Foo: ["First", "Second"] },
    };
    const target = resolver.resolve({ callText: "x.shared", receiver: "x", member: "shared", startLine: 1 }, ctx);
    expect(target?.targetSymbolId).toBe("First#shared");
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

  it("does NOT trigger the guard for plain receivers without dot-chained relation calls", () => {
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
    const target = resolver.resolve({ callText: "obj.go", receiver: "obj", member: "go", startLine: 1 }, ctx);
    expect(target?.targetSymbolId).toBe("Helper#go");
  });
});

describe("RubyCallResolver — looksLikeConstant guard", () => {
  // Receiver text that doesn't match constant grammar (lowercase start,
  // e.g. `obj.method` rather than `Klass.method`) skips the
  // looksLikeConstant branch. Covers the false-branch of the regex on
  // line 132.
  it("skips Zeitwerk resolution for lowercase-receiver calls (regular method calls)", () => {
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("helpers.rb", [
      { symbolId: "render", fqName: "render", shortName: "render", relPath: "helpers.rb", scope: [] },
    ]);
    // `obj` is lowercase — looksLikeConstant returns false, so the
    // Zeitwerk branch is skipped. No matching require import either.
    // Falls to global short-name lookup → unique render.
    const target = resolver.resolve(
      { callText: "obj.render", receiver: "obj", member: "render", startLine: 1 },
      makeCtx("main.rb", [], table),
    );
    expect(target?.targetRelPath).toBe("helpers.rb");
  });
});
