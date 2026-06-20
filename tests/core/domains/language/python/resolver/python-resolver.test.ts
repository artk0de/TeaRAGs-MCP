import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { mapPythonImportToFile } from "../../../../../../src/core/domains/language/python/resolver/python-path-mapper.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("mapPythonImportToFile", () => {
  it("absolute single-segment module → .py", () => {
    expect(mapPythonImportToFile("foo", "a/b.py")).toBe("foo.py");
  });

  it("absolute dotted module → path.py", () => {
    expect(mapPythonImportToFile("foo.bar.baz", "x.py")).toBe("foo/bar/baz.py");
  });

  it("relative one-dot resolves to sibling", () => {
    expect(mapPythonImportToFile(".foo", "pkg/main.py")).toBe("pkg/foo.py");
  });

  it("relative two-dot resolves to parent", () => {
    expect(mapPythonImportToFile("..foo", "pkg/sub/main.py")).toBe("pkg/foo.py");
  });

  it("relative two-dot dotted module: ..foo.bar from pkg/sub/x.py → pkg/foo/bar.py", () => {
    expect(mapPythonImportToFile("..foo.bar", "pkg/sub/x.py")).toBe("pkg/foo/bar.py");
  });

  it("triple-dot resolves two levels up", () => {
    expect(mapPythonImportToFile("...foo", "a/b/c/main.py")).toBe("a/foo.py");
  });

  it("`.` alone (from . import x) returns null (no specific file)", () => {
    expect(mapPythonImportToFile(".", "pkg/x.py")).toBeNull();
  });

  it("strips ` as alias` suffix tolerantly (walker normalises but guard helps)", () => {
    expect(mapPythonImportToFile("numpy as np", "a.py")).toBe("numpy.py");
  });

  it("empty input returns null", () => {
    expect(mapPythonImportToFile("", "a.py")).toBeNull();
  });
});

describe("PythonCallResolver", () => {
  function makeCtx(
    callerFile: string,
    imports: { importText: string; startLine: number }[],
    symbolTable: InMemoryGlobalSymbolTable,
  ): CallContext {
    return { callerFile, callerScope: [], imports, symbolTable };
  }

  it("resolves `foo.bar()` when the import matches the receiver", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo.py", [
      { symbolId: "foo.bar", fqName: "foo.bar", shortName: "bar", relPath: "foo.py", scope: ["foo"] },
    ]);
    const target = resolver.resolve(
      { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 5 },
      makeCtx("main.py", [{ importText: "foo", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("foo.py");
    expect(target?.targetSymbolId).toBe("foo.bar");
  });

  it("matches dotted import by trailing segment (from a.b import => receiver b)", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a/b.py", [
      { symbolId: "a.b.c", fqName: "a.b.c", shortName: "c", relPath: "a/b.py", scope: ["a", "b"] },
    ]);
    const target = resolver.resolve(
      { callText: "b.c()", receiver: "b", member: "c", startLine: 4 },
      makeCtx("main.py", [{ importText: "a.b", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("a/b.py");
  });

  it("matches relative imports by trailing segment", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("pkg/foo.py", [
      { symbolId: "pkg.foo.bar", fqName: "pkg.foo.bar", shortName: "bar", relPath: "pkg/foo.py", scope: [] },
    ]);
    const target = resolver.resolve(
      { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 3 },
      makeCtx("pkg/main.py", [{ importText: ".foo", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("pkg/foo.py");
  });

  it("returns null when the import resolves but no symbol matches by short-name (target file is known)", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    const target = resolver.resolve(
      { callText: "foo.ghost()", receiver: "foo", member: "ghost", startLine: 1 },
      makeCtx("main.py", [{ importText: "foo", startLine: 1 }], table),
    );
    // No matching symbol in table — resolver records target file with
    // null symbol id so the file-edge still gets attribution.
    expect(target?.targetRelPath).toBe("foo.py");
    expect(target?.targetSymbolId).toBeNull();
  });

  it("falls back to global short-name lookup when no receiver", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("helper.py", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "helper.py", scope: [] },
    ]);
    const target = resolver.resolve(
      { callText: "do_thing()", receiver: null, member: "do_thing", startLine: 1 },
      makeCtx("main.py", [], table),
    );
    expect(target?.targetRelPath).toBe("helper.py");
  });

  it("returns null when global short-name lookup is ambiguous", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("a.py", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "a.py", scope: [] },
    ]);
    table.upsertFile("b.py", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "b.py", scope: [] },
    ]);
    const target = resolver.resolve(
      { callText: "do_thing()", receiver: null, member: "do_thing", startLine: 1 },
      makeCtx("main.py", [], table),
    );
    // Two candidates — resolver refuses to guess.
    expect(target).toBeNull();
  });

  it("is case-sensitive (Python convention)", () => {
    const resolver = new PythonCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("foo.py", [
      { symbolId: "Foo.do", fqName: "Foo.do", shortName: "do", relPath: "foo.py", scope: ["Foo"] },
    ]);
    const target = resolver.resolve(
      { callText: "FOO.do()", receiver: "FOO", member: "do", startLine: 1 },
      // 'FOO' doesn't match 'foo' (case-sensitive), so the import-list
      // path fails → falls back to global short-name (do unique here).
      makeCtx("main.py", [{ importText: "foo", startLine: 1 }], table),
    );
    expect(target?.targetRelPath).toBe("foo.py");
  });

  describe("CODEGRAPH_AMBIGUOUS_RESOLVE_MODE", () => {
    // Reproduces the ugnest false positive: `serializer.is_valid(...)` in a
    // DRF view where `serializer` has no matching import (Serializer class
    // ships from a 3rd-party venv excluded by `ignoreFilter`). The short-name
    // `is_valid` is defined on multiple project models. Strict mode must NOT
    // attribute the call to one of them; `first` mode keeps legacy behavior.
    function ambiguousCtx(): {
      resolverArgs: undefined;
      table: InMemoryGlobalSymbolTable;
      call: { callText: string; receiver: string; member: string; startLine: number };
    } {
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("identity/confirmation.py", [
        {
          symbolId: "ConfirmationCode#is_valid",
          fqName: "ConfirmationCode#is_valid",
          shortName: "is_valid",
          relPath: "identity/confirmation.py",
          scope: ["ConfirmationCode"],
        },
      ]);
      table.upsertFile("billing/coupon.py", [
        {
          symbolId: "Coupon#is_valid",
          fqName: "Coupon#is_valid",
          shortName: "is_valid",
          relPath: "billing/coupon.py",
          scope: ["Coupon"],
        },
      ]);
      return {
        resolverArgs: undefined,
        table,
        call: {
          callText: "serializer.is_valid(raise_exception=True)",
          receiver: "serializer",
          member: "is_valid",
          startLine: 12,
        },
      };
    }

    it("strict mode (default) drops ambiguous short-name fallback", () => {
      const resolver = new PythonCallResolver();
      const { table, call } = ambiguousCtx();
      const target = resolver.resolve(call, makeCtx("engagement/views.py", [], table));
      expect(target).toBeNull();
    });

    it("strict mode explicit drops ambiguous short-name fallback", () => {
      const resolver = new PythonCallResolver("strict");
      const { table, call } = ambiguousCtx();
      const target = resolver.resolve(call, makeCtx("engagement/views.py", [], table));
      expect(target).toBeNull();
    });

    it("`first` mode picks first candidate (legacy behavior)", () => {
      const resolver = new PythonCallResolver("first");
      const { table, call } = ambiguousCtx();
      const target = resolver.resolve(call, makeCtx("engagement/views.py", [], table));
      // Exactly the false positive the strict mode prevents — emitted ONLY
      // when the user opts back into legacy `first` mode.
      expect(target).not.toBeNull();
      expect(target?.targetSymbolId).toBe("ConfirmationCode#is_valid");
    });

    it("unique short-name resolves identically in both modes", () => {
      const tableUnique = new InMemoryGlobalSymbolTable();
      tableUnique.upsertFile("svc/subscriptions.py", [
        {
          symbolId: "process_user_subscription",
          fqName: "process_user_subscription",
          shortName: "process_user_subscription",
          relPath: "svc/subscriptions.py",
          scope: [],
        },
      ]);
      const call = {
        callText: "process_user_subscription()",
        receiver: null,
        member: "process_user_subscription",
        startLine: 1,
      };

      const strict = new PythonCallResolver("strict").resolve(call, makeCtx("main.py", [], tableUnique));
      const first = new PythonCallResolver("first").resolve(call, makeCtx("main.py", [], tableUnique));
      expect(strict?.targetSymbolId).toBe("process_user_subscription");
      expect(first?.targetSymbolId).toBe("process_user_subscription");
    });

    it("zero candidates returns null in both modes", () => {
      const empty = new InMemoryGlobalSymbolTable();
      const call = { callText: "unknown()", receiver: null, member: "unknown", startLine: 1 };
      expect(new PythonCallResolver("strict").resolve(call, makeCtx("main.py", [], empty))).toBeNull();
      expect(new PythonCallResolver("first").resolve(call, makeCtx("main.py", [], empty))).toBeNull();
    });

    it("import-restricted path also honors mode: 2 same-file candidates → strict drops, first picks", () => {
      // Same file declares two classes with same-named method. The
      // import-restricted path filters to `targetFile`, but cardinality
      // still > 1 — the mode controls the pick.
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("foo.py", [
        { symbolId: "ClassA#run", fqName: "ClassA#run", shortName: "run", relPath: "foo.py", scope: ["ClassA"] },
        { symbolId: "ClassB#run", fqName: "ClassB#run", shortName: "run", relPath: "foo.py", scope: ["ClassB"] },
      ]);
      const call = { callText: "foo.run()", receiver: "foo", member: "run", startLine: 1 };
      const ctx = makeCtx("main.py", [{ importText: "foo", startLine: 1 }], table);

      const strict = new PythonCallResolver("strict").resolve(call, ctx);
      // Strict: same file, ambiguous → file-edge with null symbol, not arbitrary pick.
      expect(strict?.targetRelPath).toBe("foo.py");
      expect(strict?.targetSymbolId).toBeNull();

      const first = new PythonCallResolver("first").resolve(call, ctx);
      expect(first?.targetRelPath).toBe("foo.py");
      expect(first?.targetSymbolId).toBe("ClassA#run");
    });
  });

  describe("localBindings (walker-inferred receiver types)", () => {
    function makeCtxLocal(
      callerFile: string,
      imports: { importText: string; startLine: number }[],
      symbolTable: InMemoryGlobalSymbolTable,
      localBindings?: CallContext["localBindings"],
    ): CallContext {
      return { callerFile, callerScope: [], imports, symbolTable, localBindings };
    }

    it("drops false positive: serializer (no import) → is_valid in unrelated class is NOT attributed", () => {
      // Reproduces the exact ugnest bug. `serializer = ToggleReactionSerializer(...)`
      // — but ToggleReactionSerializer.is_valid is NOT in the symbol
      // table (it lives in a 3rd-party DRF class outside the project).
      // Project has ConfirmationCode#is_valid as the ONLY `is_valid`.
      // Strict guard alone passes that single candidate through and
      // wrongly attributes the call. With localBindings, the resolver
      // sees the receiver's true type and refuses.
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("domains/identity/models/confirmation.py", [
        {
          symbolId: "ConfirmationCode#is_valid",
          fqName: "ConfirmationCode#is_valid",
          shortName: "is_valid",
          relPath: "domains/identity/models/confirmation.py",
          scope: ["ConfirmationCode"],
        },
      ]);
      table.upsertFile("engagement/serializers/reaction.py", [
        {
          symbolId: "ToggleReactionSerializer",
          fqName: "ToggleReactionSerializer",
          shortName: "ToggleReactionSerializer",
          relPath: "engagement/serializers/reaction.py",
          scope: [],
        },
      ]);
      const target = resolver.resolve(
        {
          callText: "serializer.is_valid(raise_exception=True)",
          receiver: "serializer",
          member: "is_valid",
          startLine: 12,
        },
        makeCtxLocal("engagement/views.py", [{ importText: "engagement.serializers.reaction", startLine: 1 }], table, {
          serializer: [{ line: 1, type: "ToggleReactionSerializer" }],
        }),
      );
      // Type's file resolved (engagement/serializers/reaction.py) but
      // is_valid not defined on ToggleReactionSerializer → file-only
      // attribution, NEVER ConfirmationCode#is_valid.
      expect(target?.targetSymbolId).toBeNull();
      expect(target?.targetRelPath).toBe("engagement/serializers/reaction.py");
    });

    it("resolves correctly when the method IS defined on the bound type", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("services/reaction/toggle.py", [
        {
          symbolId: "ToggleReactionService",
          fqName: "ToggleReactionService",
          shortName: "ToggleReactionService",
          relPath: "services/reaction/toggle.py",
          scope: [],
        },
        {
          symbolId: "ToggleReactionService#execute",
          fqName: "ToggleReactionService#execute",
          shortName: "execute",
          relPath: "services/reaction/toggle.py",
          scope: ["ToggleReactionService"],
        },
      ]);
      const target = resolver.resolve(
        { callText: "service.execute()", receiver: "service", member: "execute", startLine: 8 },
        makeCtxLocal("engagement/views.py", [], table, { service: [{ line: 1, type: "ToggleReactionService" }] }),
      );
      expect(target?.targetSymbolId).toBe("ToggleReactionService#execute");
      expect(target?.targetRelPath).toBe("services/reaction/toggle.py");
    });

    it("falls back to short-name path when localBindings is empty / receiver not bound", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("svc.py", [
        { symbolId: "Helper.do", fqName: "Helper.do", shortName: "do", relPath: "svc.py", scope: ["Helper"] },
      ]);
      // No localBindings — same legacy behavior. `obj.do()` with no
      // import or binding falls through to global short-name and the
      // strict guard passes the single match.
      const target = resolver.resolve(
        { callText: "obj.do()", receiver: "obj", member: "do", startLine: 1 },
        makeCtxLocal("main.py", [], table, {}),
      );
      expect(target?.targetSymbolId).toBe("Helper.do");
    });

    it("PEP 526 annotation binds the variable (var: ClassName = ...)", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("domain/cls.py", [
        { symbolId: "MyClass", fqName: "MyClass", shortName: "MyClass", relPath: "domain/cls.py", scope: [] },
        {
          symbolId: "MyClass#run",
          fqName: "MyClass#run",
          shortName: "run",
          relPath: "domain/cls.py",
          scope: ["MyClass"],
        },
      ]);
      const target = resolver.resolve(
        { callText: "obj.run()", receiver: "obj", member: "run", startLine: 1 },
        makeCtxLocal("main.py", [], table, { obj: [{ line: 1, type: "MyClass" }] }),
      );
      expect(target?.targetSymbolId).toBe("MyClass#run");
    });

    it("function arg type hint binds the parameter inside the function body", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("http.py", [
        { symbolId: "HttpRequest", fqName: "HttpRequest", shortName: "HttpRequest", relPath: "http.py", scope: [] },
        {
          symbolId: "HttpRequest#json",
          fqName: "HttpRequest#json",
          shortName: "json",
          relPath: "http.py",
          scope: ["HttpRequest"],
        },
      ]);
      const target = resolver.resolve(
        { callText: "request.json()", receiver: "request", member: "json", startLine: 5 },
        makeCtxLocal("views.py", [], table, { request: [{ line: 1, type: "HttpRequest" }] }),
      );
      expect(target?.targetSymbolId).toBe("HttpRequest#json");
    });

    it("qualified constructor type (module.ClassName) — strips qualifier to find class", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("internal/cls.py", [
        { symbolId: "Engine", fqName: "Engine", shortName: "Engine", relPath: "internal/cls.py", scope: [] },
        {
          symbolId: "Engine#start",
          fqName: "Engine#start",
          shortName: "start",
          relPath: "internal/cls.py",
          scope: ["Engine"],
        },
      ]);
      const target = resolver.resolve(
        { callText: "eng.start()", receiver: "eng", member: "start", startLine: 1 },
        makeCtxLocal("main.py", [], table, { eng: [{ line: 1, type: "internal.cls.Engine" }] }),
      );
      expect(target?.targetSymbolId).toBe("Engine#start");
    });

    it("drops binding silently when the type is not in the symbol table AND no import resolves to it (external lib)", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      // No symbols at all — bare-identifier RHS like `factory()` was
      // emitted as a binding by the walker but resolver can't find a
      // class to attribute. Returns null rather than guessing.
      const target = resolver.resolve(
        { callText: "x.run()", receiver: "x", member: "run", startLine: 1 },
        makeCtxLocal("main.py", [], table, { x: [{ line: 1, type: "factory" }] }),
      );
      expect(target).toBeNull();
    });

    // resolveTypeFile second pass — type appears in MULTIPLE files in
    // the project's symbol table; disambiguation requires matching the
    // file against the caller's import list. Covers the ambiguous
    // branch (lines 133-142 of python-resolver.ts).
    it("disambiguates an ambiguous bare class name via imports (multiple files declare same shortName)", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      // Two files declare a `User` class — only one is imported by the
      // caller so disambiguation must pick that file.
      table.upsertFile("domain/models/user.py", [
        { symbolId: "User", fqName: "User", shortName: "User", relPath: "domain/models/user.py", scope: [] },
        {
          symbolId: "User#save",
          fqName: "User#save",
          shortName: "save",
          relPath: "domain/models/user.py",
          scope: ["User"],
        },
      ]);
      table.upsertFile("legacy/user.py", [
        { symbolId: "User", fqName: "User", shortName: "User", relPath: "legacy/user.py", scope: [] },
      ]);
      const target = resolver.resolve(
        { callText: "u.save()", receiver: "u", member: "save", startLine: 5 },
        makeCtxLocal("svc.py", [{ importText: "domain.models.user", startLine: 1 }], table, {
          u: [{ line: 1, type: "User" }],
        }),
      );
      expect(target?.targetSymbolId).toBe("User#save");
      expect(target?.targetRelPath).toBe("domain/models/user.py");
    });

    it("returns null when ambiguous bare class still resolves to multiple imported files", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      // BOTH `User` files are imported — disambiguation refuses to guess.
      table.upsertFile("a/user.py", [
        { symbolId: "User", fqName: "User", shortName: "User", relPath: "a/user.py", scope: [] },
      ]);
      table.upsertFile("b/user.py", [
        { symbolId: "User", fqName: "User", shortName: "User", relPath: "b/user.py", scope: [] },
      ]);
      const target = resolver.resolve(
        { callText: "u.foo()", receiver: "u", member: "foo", startLine: 1 },
        makeCtxLocal(
          "main.py",
          [
            { importText: "a.user", startLine: 1 },
            { importText: "b.user", startLine: 2 },
          ],
          table,
          { u: [{ line: 1, type: "User" }] },
        ),
      );
      expect(target).toBeNull();
    });

    // resolveTypeFile third pass — type NOT in symbol table (external
    // class like DRF Serializer); fall back to scanning imports whose
    // last segment matches the bare type name. Covers lines 148-151.
    it("attributes an external type via import path whose last segment matches the bare type (third-pass fallback)", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      // No `Serializer` symbol in project — but caller imports it as
      // `rest_framework.serializers.Serializer` (relative-resolved here
      // via `.serializers.Serializer` for posix join).
      const target = resolver.resolve(
        { callText: "s.is_valid()", receiver: "s", member: "is_valid", startLine: 3 },
        makeCtxLocal("views.py", [{ importText: ".lib.Serializer", startLine: 1 }], table, {
          s: [{ line: 1, type: "Serializer" }],
        }),
      );
      // mapPythonImportToFile resolves `.lib.Serializer` → "lib/Serializer.py"
      expect(target?.targetRelPath).toBe("lib/Serializer.py");
      expect(target?.targetSymbolId).toBeNull();
    });
  });

  // bd tea-rags-mcp-pic4 — `super().method()` Python call. Walker
  // emits `class App(Scaffold):` into `ctx.classExtends["App"] =
  // "Scaffold"`. Resolver detects call `super().__init__()` (member
  // call on super()), walks classExtends from the enclosing class to
  // the parent, and resolves `Scaffold#__init__` against the symbol
  // table.
  describe("super().method() resolution (bd pic4)", () => {
    function makeCtxSuper(
      callerFile: string,
      callerScope: string[],
      symbolTable: InMemoryGlobalSymbolTable,
      classExtends: Record<string, string>,
    ): CallContext {
      return {
        callerFile,
        callerScope,
        imports: [],
        symbolTable,
        classExtends,
      };
    }

    it("resolves super().__init__() to Parent#__init__ even when short-name is ambiguous", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      // Two classes define `__init__` in the project — the fallback
      // `lookupByShortName("__init__")` is ambiguous and strict-mode
      // returns null. Only an explicit super() walk via classExtends
      // can disambiguate to the parent class.
      table.upsertFile("scaffold.py", [
        {
          symbolId: "Scaffold#__init__",
          fqName: "Scaffold#__init__",
          shortName: "__init__",
          relPath: "scaffold.py",
          scope: ["Scaffold"],
        },
      ]);
      table.upsertFile("blueprint.py", [
        {
          symbolId: "Blueprint#__init__",
          fqName: "Blueprint#__init__",
          shortName: "__init__",
          relPath: "blueprint.py",
          scope: ["Blueprint"],
        },
      ]);
      const target = resolver.resolve(
        // The Python walker produces receiver="super()" for super().method() calls.
        { callText: "super().__init__()", receiver: "super()", member: "__init__", startLine: 5 },
        makeCtxSuper("app.py", ["App"], table, { App: "Scaffold" }),
      );
      expect(target?.targetRelPath).toBe("scaffold.py");
      expect(target?.targetSymbolId).toBe("Scaffold#__init__");
    });

    it("returns null when the enclosing class is unknown to classExtends", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      const target = resolver.resolve(
        { callText: "super().method()", receiver: "super()", member: "method", startLine: 5 },
        makeCtxSuper("app.py", ["App"], table, {}),
      );
      expect(target).toBeNull();
    });

    it("walks transitively to grandparent when direct parent lacks the method", () => {
      // Child → Mid → Base — `foo` lives on Base only. The resolver
      // walks the chain through Mid (no foo) up to Base.
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("base.py", [
        {
          symbolId: "Base#foo",
          fqName: "Base#foo",
          shortName: "foo",
          relPath: "base.py",
          scope: ["Base"],
        },
      ]);
      const target = resolver.resolve(
        { callText: "super().foo()", receiver: "super()", member: "foo", startLine: 1 },
        makeCtxSuper("child.py", ["Child"], table, { Child: "Mid", Mid: "Base" }),
      );
      expect(target?.targetSymbolId).toBe("Base#foo");
      expect(target?.targetRelPath).toBe("base.py");
    });

    it("falls back to static (.) form on parent when instance (#) form is missing", () => {
      // Parent defines `Parent.classMethod` (classmethod-style),
      // not `Parent#classMethod`. The resolver tries the instance
      // form first, then the static form.
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("parent.py", [
        {
          symbolId: "Parent.classMethod",
          fqName: "Parent.classMethod",
          shortName: "classMethod",
          relPath: "parent.py",
          scope: ["Parent"],
        },
      ]);
      const target = resolver.resolve(
        { callText: "super().classMethod()", receiver: "super()", member: "classMethod", startLine: 1 },
        makeCtxSuper("child.py", ["Child"], table, { Child: "Parent" }),
      );
      expect(target?.targetSymbolId).toBe("Parent.classMethod");
      expect(target?.targetRelPath).toBe("parent.py");
    });

    it("returns null when classExtends cycles back to a visited class (no method found)", () => {
      // A → B → A — the visited guard breaks the walk. Without a hit,
      // returns null. Defensive coverage for malformed extends data.
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      const target = resolver.resolve(
        { callText: "super().method()", receiver: "super()", member: "method", startLine: 1 },
        makeCtxSuper("a.py", ["A"], table, { A: "B", B: "A" }),
      );
      expect(target).toBeNull();
    });
  });

  // bd tea-rags-mcp-w3pr — Lazy / function-scoped imports. When a Python
  // function body opens with `from asgiref.sync import async_to_sync as
  // _async_to_sync` and the body calls `_async_to_sync(...)`, the
  // resolver must see that scoped import in addition to the module-level
  // ones. The walker carries scoped imports on the chunk; the provider
  // merges them into `ctx.imports` before the resolver dispatches.
  describe("function-scoped imports (bd w3pr)", () => {
    it("resolves a bare call whose import lives inside the function body via scoped imports", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("asgiref/sync.py", [
        {
          symbolId: "async_to_sync",
          fqName: "async_to_sync",
          shortName: "async_to_sync",
          relPath: "asgiref/sync.py",
          scope: [],
        },
      ]);
      // Resolver must work when imports[] contains the function-scoped
      // import (the walker's job — `extractFromPythonFile` puts both
      // module + scoped imports on the chunk's contextual import list
      // via the provider's merge step).
      const target = resolver.resolve(
        {
          callText: "async_to_sync(awaitable)",
          receiver: null,
          member: "async_to_sync",
          startLine: 3,
        },
        {
          callerFile: "x.py",
          callerScope: [],
          imports: [{ importText: "asgiref.sync", startLine: 2 }],
          symbolTable: table,
        },
      );
      expect(target?.targetRelPath).toBe("asgiref/sync.py");
      expect(target?.targetSymbolId).toBe("async_to_sync");
    });
  });

  // bd tea-rags-mcp-rjuc — cross-method `self.<field>.<method>()`.
  // Instance fields declared in `__init__` (`self.service = SomeService()`)
  // are recorded as class-level state in `classFieldTypes`; the resolver
  // looks the field's type up keyed by the enclosing class and resolves
  // `<Type>#<method>`. Mirrors the TS `this.field.method()` path.
  describe("classFieldTypes (self.field cross-method)", () => {
    it("resolves `self.service.process()` to the field's class instance method", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("service.py", [
        {
          symbolId: "SomeService#process",
          fqName: "SomeService#process",
          shortName: "process",
          relPath: "service.py",
          scope: ["SomeService"],
        },
      ]);
      const ctx: CallContext = {
        callerFile: "handler.py",
        callerScope: ["Handler"],
        imports: [],
        symbolTable: table,
        classFieldTypes: { Handler: { service: "SomeService" } },
      };
      const target = resolver.resolve(
        { callText: "self.service.process()", receiver: "self.service", member: "process", startLine: 8 },
        ctx,
      );
      expect(target?.targetRelPath).toBe("service.py");
      expect(target?.targetSymbolId).toBe("SomeService#process");
    });

    it("falls back to the static (`.`) form when no instance method exists", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("service.py", [
        {
          symbolId: "SomeService.build",
          fqName: "SomeService.build",
          shortName: "build",
          relPath: "service.py",
          scope: ["SomeService"],
        },
      ]);
      const ctx: CallContext = {
        callerFile: "handler.py",
        callerScope: ["Handler"],
        imports: [],
        symbolTable: table,
        classFieldTypes: { Handler: { service: "SomeService" } },
      };
      const target = resolver.resolve(
        { callText: "self.service.build()", receiver: "self.service", member: "build", startLine: 8 },
        ctx,
      );
      expect(target?.targetRelPath).toBe("service.py");
      expect(target?.targetSymbolId).toBe("SomeService.build");
    });

    it("NEGATIVE: `self.unknown.process()` (field has no recorded type) drops the edge — no fabrication", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      // A `process` symbol exists on an UNRELATED class — must NOT be
      // attributed to `self.unknown` since the field type is unknown.
      table.upsertFile("other.py", [
        {
          symbolId: "Other#process",
          fqName: "Other#process",
          shortName: "process",
          relPath: "other.py",
          scope: ["Other"],
        },
      ]);
      const ctx: CallContext = {
        callerFile: "handler.py",
        callerScope: ["Handler"],
        imports: [],
        symbolTable: table,
        classFieldTypes: { Handler: { service: "SomeService" } }, // no `unknown`
      };
      const target = resolver.resolve(
        { callText: "self.unknown.process()", receiver: "self.unknown", member: "process", startLine: 8 },
        ctx,
      );
      expect(target).toBeNull();
    });

    it("emits an external best-effort target when the field type is known but the method is external", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("service.py", [
        {
          symbolId: "SomeService#process",
          fqName: "SomeService#process",
          shortName: "process",
          relPath: "service.py",
          scope: ["SomeService"],
        },
      ]);
      const ctx: CallContext = {
        callerFile: "handler.py",
        callerScope: ["Handler"],
        imports: [],
        symbolTable: table,
        classFieldTypes: { Handler: { service: "SomeService" } },
      };
      // `inherited()` not defined on SomeService anywhere in the table —
      // inherited from a base class outside the project. The field type
      // IS known, so emit a type-qualified best-effort target anchored to
      // the bare type name rather than dropping. Mirrors the Java resolver's
      // CharSequence#charAt external path.
      const target = resolver.resolve(
        { callText: "self.service.inherited()", receiver: "self.service", member: "inherited", startLine: 8 },
        ctx,
      );
      expect(target?.targetRelPath).toBe("SomeService");
      expect(target?.targetSymbolId).toBe("SomeService#inherited");
    });

    it("resolves `self._context_stack.close()` to an external `ExitStack#close` target (stdlib type, not in table)", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      // ExitStack is `contextlib` stdlib — NOT in the indexed repo. The
      // field's type is known from the `__init__` constructor assignment
      // (`self._context_stack = ExitStack()`), so the call resolves to a
      // type-qualified best-effort target instead of being dropped.
      const ctx: CallContext = {
        callerFile: "flask/testing.py",
        callerScope: ["FlaskClient"],
        imports: [],
        symbolTable: table,
        classFieldTypes: { FlaskClient: { _context_stack: "ExitStack" } },
      };
      const target = resolver.resolve(
        { callText: "self._context_stack.close()", receiver: "self._context_stack", member: "close", startLine: 12 },
        ctx,
      );
      expect(target?.targetRelPath).toBe("ExitStack");
      expect(target?.targetSymbolId).toBe("ExitStack#close");
    });

    it("resolves `self._context_stack.enter_context(cm)` to an external `ExitStack#enter_context` target", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      const ctx: CallContext = {
        callerFile: "flask/testing.py",
        callerScope: ["FlaskClient"],
        imports: [],
        symbolTable: table,
        classFieldTypes: { FlaskClient: { _context_stack: "ExitStack" } },
      };
      const target = resolver.resolve(
        {
          callText: "self._context_stack.enter_context(cm)",
          receiver: "self._context_stack",
          member: "enter_context",
          startLine: 14,
        },
        ctx,
      );
      expect(target?.targetRelPath).toBe("ExitStack");
      expect(target?.targetSymbolId).toBe("ExitStack#enter_context");
    });

    it("does not apply field resolution outside a class scope (callerScope empty)", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      const ctx: CallContext = {
        callerFile: "handler.py",
        callerScope: [],
        imports: [],
        symbolTable: table,
        classFieldTypes: { Handler: { service: "SomeService" } },
      };
      const target = resolver.resolve(
        { callText: "self.service.process()", receiver: "self.service", member: "process", startLine: 8 },
        ctx,
      );
      expect(target).toBeNull();
    });

    // BOUNDARY (bd tea-rags-mcp-rjuc) — `self.x = <literal>` in `__init__`
    // records NO field type (the walker only records a type for a call /
    // PEP-526-annotated RHS; a list/dict/scalar literal has no class name
    // to attribute). With no recorded type for the field, the `self.<field>`
    // receiver path DROPS rather than fall through to the ambiguous
    // short-name fallback — never attributing `self.x.method()` to an
    // unrelated class that happens to define `method`. This is the genuine
    // "no classFieldType -> drop" boundary. The walker side (literal RHS ->
    // {}) is asserted in python-walker.test.ts; here we lock the resolver
    // drop given the empty field map.
    it("NEGATIVE: literal-assigned field (no recorded type) → `self.x.method()` DROPS — no fabrication", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      // An unrelated class defines `method` — must NOT be attributed.
      table.upsertFile("other.py", [
        {
          symbolId: "Other#method",
          fqName: "Other#method",
          shortName: "method",
          relPath: "other.py",
          scope: ["Other"],
        },
      ]);
      const ctx: CallContext = {
        callerFile: "handler.py",
        callerScope: ["Handler"],
        imports: [],
        symbolTable: table,
        // `self.x = []` records nothing → Handler has an empty field map.
        classFieldTypes: { Handler: {} },
      };
      const target = resolver.resolve(
        { callText: "self.x.method()", receiver: "self.x", member: "method", startLine: 8 },
        ctx,
      );
      expect(target).toBeNull();
    });

    // BOUNDARY (bd tea-rags-mcp-m46z) — `self.x = some_func()` where the RHS
    // is a NON-constructor function call (lowercase / unknown return type).
    // The walker's CapWords gate (PEP8: classes are CapWords, functions
    // lowercase) DROPS such an assignment — `some_func` is NOT recorded as a
    // field type. So the resolver never receives a lowercase candidate from
    // real code: `classFieldTypes` for the field is empty, the `self.<field>`
    // branch finds no recorded type, and the call DROPS rather than emitting
    // the phantom external edge `some_func#method` that earlier blessed this
    // boundary. (Earlier the walker recorded the lowercase name and the
    // resolver anchored an external best-effort — a phantom edge to a symbol
    // that can never exist. The CapWords gate eliminates the phantom at the
    // source; only genuine CapWords stdlib types like `ExitStack` reach the
    // external best-effort path, covered by the tests above.)
    it("function-call-assigned field (lowercase) is not recorded by the walker → resolver DROPS, never a phantom external edge", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      // An unrelated class defines `method` — the resolver must NOT pick it.
      table.upsertFile("other.py", [
        {
          symbolId: "Other#method",
          fqName: "Other#method",
          shortName: "method",
          relPath: "other.py",
          scope: ["Other"],
        },
      ]);
      const ctx: CallContext = {
        callerFile: "handler.py",
        callerScope: ["Handler"],
        imports: [],
        symbolTable: table,
        // Walker CapWords gate dropped `self.x = some_func()` → no field type
        // recorded for `x`. This is the realistic post-gate input shape.
        classFieldTypes: { Handler: {} },
      };
      const target = resolver.resolve(
        { callText: "self.x.method()", receiver: "self.x", member: "method", startLine: 8 },
        ctx,
      );
      // No recorded type → DROP. No phantom `some_func#method`, no unrelated
      // `Other#method`, no fabricated `.py` file edge.
      expect(target).toBeNull();
    });
  });

  // bd tea-rags-mcp-yrs0 — inherited-method resolution via base-class walk.
  // `self.method()` (and typed-receiver `var.method()`) where the method is
  // NOT defined on the enclosing/bound class must walk that class's
  // `classExtends` chain and resolve to the first IN-PROJECT ancestor that
  // defines it. Restricted to base classes present in the symbol table —
  // external bases (Django CBVs, werkzeug) stop the branch and the edge is
  // dropped rather than fabricated.
  describe("inherited method resolution via classExtends walk (bd yrs0)", () => {
    function makeCtxExtends(
      callerFile: string,
      callerScope: string[],
      symbolTable: InMemoryGlobalSymbolTable,
      classExtends: Record<string, string>,
    ): CallContext {
      return { callerFile, callerScope, imports: [], symbolTable, classExtends };
    }

    it("resolves self.shared() to Base#shared walked Leaf → Mid → Base", () => {
      // `shared` lives only on Base. Leaf and Mid do not define it. The
      // resolver walks Leaf → Mid → Base and lands on Base#shared.
      //
      // A SECOND, unrelated class (`Decoy`) also defines `shared`, so the
      // global short-name fallback is AMBIGUOUS (strict-mode would drop):
      // only an explicit classExtends walk can disambiguate to Base.
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("base.py", [
        { symbolId: "Base#shared", fqName: "Base#shared", shortName: "shared", relPath: "base.py", scope: ["Base"] },
      ]);
      table.upsertFile("decoy.py", [
        {
          symbolId: "Decoy#shared",
          fqName: "Decoy#shared",
          shortName: "shared",
          relPath: "decoy.py",
          scope: ["Decoy"],
        },
      ]);
      // Register Mid and Leaf as known classes so the bases are in-project.
      table.upsertFile("mid.py", [{ symbolId: "Mid", fqName: "Mid", shortName: "Mid", relPath: "mid.py", scope: [] }]);
      table.upsertFile("leaf.py", [
        { symbolId: "Leaf", fqName: "Leaf", shortName: "Leaf", relPath: "leaf.py", scope: [] },
        { symbolId: "Leaf#run", fqName: "Leaf#run", shortName: "run", relPath: "leaf.py", scope: ["Leaf"] },
      ]);
      const target = resolver.resolve(
        { callText: "self.shared()", receiver: "self", member: "shared", startLine: 3 },
        makeCtxExtends("leaf.py", ["Leaf"], table, { Leaf: "Mid", Mid: "Base" }),
      );
      expect(target?.targetSymbolId).toBe("Base#shared");
      expect(target?.targetRelPath).toBe("base.py");
    });

    it("(a) method on the direct enclosing class wins — no walk", () => {
      // Leaf defines `run` itself. The resolver must resolve to Leaf#run,
      // never walk up to a parent that also defines `run`.
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("base.py", [
        { symbolId: "Base#run", fqName: "Base#run", shortName: "run", relPath: "base.py", scope: ["Base"] },
      ]);
      table.upsertFile("leaf.py", [
        { symbolId: "Leaf#run", fqName: "Leaf#run", shortName: "run", relPath: "leaf.py", scope: ["Leaf"] },
        { symbolId: "Leaf#go", fqName: "Leaf#go", shortName: "go", relPath: "leaf.py", scope: ["Leaf"] },
      ]);
      const target = resolver.resolve(
        { callText: "self.run()", receiver: "self", member: "run", startLine: 4 },
        makeCtxExtends("leaf.py", ["Leaf"], table, { Leaf: "Base" }),
      );
      expect(target?.targetSymbolId).toBe("Leaf#run");
      expect(target?.targetRelPath).toBe("leaf.py");
    });

    it("(b) external/unknown base class → DROP (no fabricated edge)", () => {
      // Leaf extends an external base (werkzeug.test.Client) that is NOT in
      // the symbol table. `self.foo()` is defined nowhere in-project → the
      // walk stops at the unknown base and the edge is dropped.
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("leaf.py", [
        { symbolId: "Leaf#run", fqName: "Leaf#run", shortName: "run", relPath: "leaf.py", scope: ["Leaf"] },
      ]);
      const target = resolver.resolve(
        { callText: "self.foo()", receiver: "self", member: "foo", startLine: 5 },
        makeCtxExtends("leaf.py", ["Leaf"], table, { Leaf: "werkzeug.test.Client" }),
      );
      expect(target).toBeNull();
    });

    it("(c) cyclic classExtends (A → B → A) terminates and drops", () => {
      // A extends B, B extends A — a malformed cycle. The walk must
      // terminate via the visited guard and drop (no infinite loop) when
      // no ancestor defines `missing`.
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("a.py", [{ symbolId: "A", fqName: "A", shortName: "A", relPath: "a.py", scope: [] }]);
      table.upsertFile("b.py", [{ symbolId: "B", fqName: "B", shortName: "B", relPath: "b.py", scope: [] }]);
      const target = resolver.resolve(
        { callText: "self.missing()", receiver: "self", member: "missing", startLine: 2 },
        makeCtxExtends("a.py", ["A"], table, { A: "B", B: "A" }),
      );
      expect(target).toBeNull();
    });

    // BOUNDARY (bd tea-rags-mcp-q1pl — multiple-inheritance follow-up).
    // KNOWN SINGLE-BASE LIMITATION: the Python walker's
    // `collectPythonClassExtends` records ONLY the FIRST base of a
    // `class A(B, C)` declaration (`classExtends["A"] = "B"`). When the
    // called method lives on the SECOND base `C` (not on `B` or `A`), the
    // classExtends walk follows only the `B` chain, never reaches `C`, and
    // DROPS the edge. This is the deliberate safe boundary — recording only
    // the first base avoids modelling full MRO; the trade-off is that
    // methods inherited from non-first bases are not resolved (dropped, not
    // fabricated). A future multi-base walk (bd q1pl) would make this
    // resolve to `C#second`; until then this test locks the current drop so
    // a regression that started guessing wrongly is caught.
    it("KNOWN LIMITATION: method on SECOND base `class A(B, C)` is DROPPED (single-base classExtends only)", () => {
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      // `second` is defined ONLY on the second base C.
      table.upsertFile("c.py", [
        { symbolId: "C#second", fqName: "C#second", shortName: "second", relPath: "c.py", scope: ["C"] },
      ]);
      // B is a known in-project base but does not define `second`.
      table.upsertFile("b.py", [{ symbolId: "B", fqName: "B", shortName: "B", relPath: "b.py", scope: [] }]);
      // The walker would only have recorded the FIRST base → { A: "B" }.
      // C is invisible to the classExtends chain, so the walk drops.
      const target = resolver.resolve(
        { callText: "self.second()", receiver: "self", member: "second", startLine: 5 },
        makeCtxExtends("a.py", ["A"], table, { A: "B" }),
      );
      expect(target).toBeNull();
    });

    it("resolves typed-receiver var.method() to an inherited Base#shared", () => {
      // `leaf.shared()` where `leaf: Leaf` (localBindings) and `shared` is
      // inherited from Base. The walk runs from Leaf's bound type up the
      // classExtends chain rather than dropping to a file-only edge.
      const resolver = new PythonCallResolver();
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("base.py", [
        { symbolId: "Base#shared", fqName: "Base#shared", shortName: "shared", relPath: "base.py", scope: ["Base"] },
      ]);
      table.upsertFile("leaf.py", [
        { symbolId: "Leaf", fqName: "Leaf", shortName: "Leaf", relPath: "leaf.py", scope: [] },
      ]);
      const ctx: CallContext = {
        callerFile: "caller.py",
        callerScope: ["Caller"],
        imports: [],
        symbolTable: table,
        localBindings: { leaf: [{ line: 1, type: "Leaf" }] },
        classExtends: { Leaf: "Base" },
      };
      const target = resolver.resolve(
        { callText: "leaf.shared()", receiver: "leaf", member: "shared", startLine: 9 },
        ctx,
      );
      expect(target?.targetSymbolId).toBe("Base#shared");
      expect(target?.targetRelPath).toBe("base.py");
    });
  });
});
