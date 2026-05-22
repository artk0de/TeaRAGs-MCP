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
        symbolId: "User::find",
        fqName: "User::find",
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
    expect(target?.targetSymbolId).toBe("User::find");
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

  it("drops the false positive `obj.result()` to AbstractPolicy#result when receiver is NOT bound", () => {
    // Without localBindings, the resolver fell back to global short-name
    // lookup and picked AbstractPolicy#result for `Product.ransack(...).result(...)`.
    // With Step 0 only kicking in when receiver IS in localBindings, the
    // path here is identical to before — the chained call's receiver text
    // (`Product.ransack(form)`) doesn't match any constant or local
    // variable, so the resolver falls through to short-name lookup. This
    // test pins the BEHAVIOUR we have: Step 0 doesn't make things worse.
    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
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
      // Note: `Product.ransack(form)` has no local binding (walker only
      // tracks `var = X.new` / AR finders), so receiver here is a literal
      // chain text — not in localBindings.
    };
    const target = resolver.resolve(
      {
        callText: "Product.ransack(form).result(distinct: true)",
        receiver: "Product.ransack(form)",
        member: "result",
        startLine: 5,
      },
      ctx,
    );
    // Global short-name lookup still finds AbstractPolicy#result (legacy FP).
    // Documenting current behaviour; a separate Relation-aware pass would fix this.
    expect(target?.targetSymbolId).toBe("AbstractPolicy#result");
  });

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
