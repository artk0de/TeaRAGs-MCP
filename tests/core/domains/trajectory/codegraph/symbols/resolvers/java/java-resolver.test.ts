import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import {
  JavaCallResolver,
  mapJavaImportToFile,
} from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/java/java-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table };
}

describe("mapJavaImportToFile", () => {
  it("translates `com.foo.Bar` → com/foo/Bar.java", () => {
    expect(mapJavaImportToFile("com.foo.Bar")).toBe("com/foo/Bar.java");
  });

  it("wildcards return null (point at directory, not file)", () => {
    expect(mapJavaImportToFile("com.foo.*")).toBeNull();
  });

  it("static import drops trailing method segment", () => {
    expect(mapJavaImportToFile("com.foo.Bar.method")).toBe("com/foo/Bar.java");
  });

  it("returns null when no uppercase class segment found", () => {
    expect(mapJavaImportToFile("all.lowercase.package")).toBeNull();
  });
});

describe("JavaCallResolver", () => {
  it("resolves `Bar.method()` to com/foo/Bar.java", () => {
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("com/foo/Bar.java", [
      {
        symbolId: "Bar.method",
        fqName: "Bar.method",
        shortName: "method",
        relPath: "com/foo/Bar.java",
        scope: ["Bar"],
      },
    ]);
    const target = r.resolve(
      { callText: "Bar.method()", receiver: "Bar", member: "method", startLine: 1 },
      ctx("X.java", [{ importText: "com.foo.Bar", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("com/foo/Bar.java");
  });

  it("wildcards do not match — falls through to global lookup", () => {
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("com/foo/Bar.java", [
      {
        symbolId: "Bar.method",
        fqName: "Bar.method",
        shortName: "method",
        relPath: "com/foo/Bar.java",
        scope: ["Bar"],
      },
    ]);
    const target = r.resolve(
      { callText: "Bar.method()", receiver: "Bar", member: "method", startLine: 1 },
      ctx("X.java", [{ importText: "com.foo.*", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("com/foo/Bar.java");
  });

  it("returns null when nothing resolves", () => {
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    const target = r.resolve(
      { callText: "Ghost.find()", receiver: "Ghost", member: "find", startLine: 1 },
      ctx("X.java", [], t),
    );
    expect(target).toBeNull();
  });

  // When the import resolves to a target file but the symbol table has
  // no matching short-name (e.g. file isn't indexed yet, partial reindex,
  // or symbol declared inside a method) the resolver still anchors the
  // edge to the file path. `targetSymbolId: null` signals "file known,
  // symbol unknown" to downstream consumers. Drives the
  // `return { targetRelPath: targetFile, targetSymbolId: null }` branch
  // (line 32 of java-resolver.ts).
  it("returns target file with null symbol id when import resolves but symbol unknown", () => {
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    // No symbol-table entry for `Bar` → candidates[] is empty → fall
    // through to the file-level anchor with null symbol id.
    const target = r.resolve(
      { callText: "Bar.ghost()", receiver: "Bar", member: "ghost", startLine: 1 },
      ctx("X.java", [{ importText: "com.foo.Bar", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("com/foo/Bar.java");
    expect(target?.targetSymbolId).toBeNull();
  });

  it("drops the edge when receiver is a chained expression (parens / dots) and no import matches", () => {
    // Real-world case (commons-lang RandomUtils#randomBytes):
    //   random().nextBytes(result)  — receiver "random()" returns
    //   java.util.Random (external). The old behaviour fell back to
    //   global short-name lookup of "nextBytes" and matched the unique
    //   same-class static `RandomUtils.nextBytes`, fabricating a
    //   false-positive cycle. Resolver must drop the edge instead.
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("RandomUtils.java", [
      {
        symbolId: "RandomUtils.nextBytes",
        fqName: "RandomUtils.nextBytes",
        shortName: "nextBytes",
        relPath: "RandomUtils.java",
        scope: ["RandomUtils"],
      },
    ]);
    const target = r.resolve(
      { callText: "random().nextBytes(result)", receiver: "random()", member: "nextBytes", startLine: 1 },
      ctx("RandomUtils.java", [], t),
    );
    expect(target).toBeNull();
  });

  it("drops the edge when receiver is an external class identifier with no import match", () => {
    // Real-world (commons-lang StringUtils#isBlank):
    //   Character.isWhitespace(cs.charAt(i))
    // Receiver "Character" is java.lang.* (implicit, no explicit import).
    // Old behaviour: fallback to global short-name "isWhitespace" matched
    // the unique same-class `StringUtils.isWhitespace`, fabricating a
    // false-positive edge. Resolver must drop the edge.
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("StringUtils.java", [
      {
        symbolId: "StringUtils.isWhitespace",
        fqName: "StringUtils.isWhitespace",
        shortName: "isWhitespace",
        relPath: "StringUtils.java",
        scope: ["StringUtils"],
      },
    ]);
    const target = r.resolve(
      { callText: "Character.isWhitespace(cs.charAt(i))", receiver: "Character", member: "isWhitespace", startLine: 1 },
      ctx("StringUtils.java", [], t),
    );
    expect(target).toBeNull();
  });

  it("drops the edge when receiver is a local-variable identifier with no import match", () => {
    // `cs.charAt(i)` — receiver "cs" is a local CharSequence variable.
    // Without receiver-type tracking, falling back to global short-name
    // for "charAt" matches an unrelated `StrBuilder#charAt`, fabricating
    // a false-positive edge. Drop instead.
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("StrBuilder.java", [
      {
        symbolId: "StrBuilder#charAt",
        fqName: "StrBuilder#charAt",
        shortName: "charAt",
        relPath: "StrBuilder.java",
        scope: ["StrBuilder"],
      },
    ]);
    const target = r.resolve(
      { callText: "cs.charAt(i)", receiver: "cs", member: "charAt", startLine: 1 },
      ctx("StringUtils.java", [], t),
    );
    expect(target).toBeNull();
  });

  it("bare-call (no receiver) falls back to global short-name lookup and returns the unique match", () => {
    // Top-level `helper()` invocation (no receiver) — Java's static-import
    // case or same-class private/static method. The resolver bypasses the
    // import/scope filtering branches and consults the symbol table
    // directly via `lookupByShortName`. Exercises the no-receiver
    // fallback path (lines 57-60 of java-resolver.ts) which previously
    // lacked test coverage.
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("Helpers.java", [
      { symbolId: "Helpers.run", fqName: "Helpers.run", shortName: "run", relPath: "Helpers.java", scope: ["Helpers"] },
    ]);
    const target = r.resolve(
      { callText: "run()", receiver: null, member: "run", startLine: 1 },
      ctx("Main.java", [], t),
    );
    expect(target?.targetRelPath).toBe("Helpers.java");
    expect(target?.targetSymbolId).toBe("Helpers.run");
  });

  it("bare-call returns null when global short-name lookup is ambiguous", () => {
    // Two files define `helper()` — without a receiver to disambiguate,
    // pickSingleCandidate returns null (default mode rejects ambiguous
    // multi-candidate sets). Drives the trailing `return null` branch.
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("A.java", [{ symbolId: "A.run", fqName: "A.run", shortName: "run", relPath: "A.java", scope: ["A"] }]);
    t.upsertFile("B.java", [{ symbolId: "B.run", fqName: "B.run", shortName: "run", relPath: "B.java", scope: ["B"] }]);
    const target = r.resolve(
      { callText: "run()", receiver: null, member: "run", startLine: 1 },
      ctx("Main.java", [], t),
    );
    expect(target).toBeNull();
  });

  it("resolves wildcard-imported `Bar.method()` via scope-filtered short-name fallback", () => {
    // Wildcard imports (`import com.foo.*`) bring all package classes into
    // scope without a per-class import line, so importMatchesReceiver
    // returns false. The resolver salvages this safe case via the
    // scope-filter short-name fallback: candidates whose `scope` ends in
    // the receiver class name are accepted (rejects the false-positive
    // cases like Character.isWhitespace against StringUtils.isWhitespace).
    // Exercises the scope-filtered short-name fallback (java-resolver
    // lines 50-54) which the bug-fix path introduced and which is
    // otherwise unreached when no import line matches the receiver.
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("com/foo/Bar.java", [
      {
        symbolId: "Bar.method",
        fqName: "Bar.method",
        shortName: "method",
        relPath: "com/foo/Bar.java",
        scope: ["Bar"],
      },
    ]);
    // Wildcard import — javaImportMatchesReceiver returns false, so the
    // resolver enters the scope-filter fallback. `scope[last]` is "Bar",
    // matches receiver "Bar" → candidate accepted, edge resolved.
    const target = r.resolve(
      { callText: "Bar.method()", receiver: "Bar", member: "method", startLine: 1 },
      ctx("X.java", [{ importText: "com.foo.*", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("com/foo/Bar.java");
    expect(target?.targetSymbolId).toBe("Bar.method");
  });

  it("drops the edge when receiver is a multi-segment dotted expression and no import matches", () => {
    // `this.foo.bar.baz()` → receiver "this.foo.bar" is a chain.
    // Without receiver-type tracking we cannot know the dynamic type
    // of the chain endpoint. Drop instead of guessing via shortName.
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("Sibling.java", [
      { symbolId: "Sibling#baz", fqName: "Sibling#baz", shortName: "baz", relPath: "Sibling.java", scope: ["Sibling"] },
    ]);
    const target = r.resolve(
      { callText: "this.foo.bar.baz()", receiver: "this.foo.bar", member: "baz", startLine: 1 },
      ctx("X.java", [], t),
    );
    expect(target).toBeNull();
  });

  // bd tea-rags-mcp-9t8z — implicit-receiver intra-class call. Java
  // `append(element)` inside `HashCodeBuilder#append` is an implicit
  // `this.append(element)` recursive call. Before the fix the resolver
  // had no enclosing-class awareness, so bare calls walked straight
  // into the global short-name lookup and were either ambiguous-dropped
  // or pinned to the wrong file. Use `callerScope[last]` as the
  // enclosing class and check `<Class>#<member>` / `<Class>.<member>`
  // in the caller file before falling back to global short-name.
  it("resolves an implicit-receiver bare call to the enclosing class's instance method (same file)", () => {
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("HashCodeBuilder.java", [
      {
        symbolId: "HashCodeBuilder#append",
        fqName: "HashCodeBuilder#append",
        shortName: "append",
        relPath: "HashCodeBuilder.java",
        scope: ["HashCodeBuilder"],
      },
    ]);
    const target = r.resolve(
      { callText: "append(element)", receiver: null, member: "append", startLine: 5 },
      {
        callerFile: "HashCodeBuilder.java",
        callerScope: ["HashCodeBuilder"],
        imports: [],
        symbolTable: t,
      },
    );
    expect(target?.targetRelPath).toBe("HashCodeBuilder.java");
    expect(target?.targetSymbolId).toBe("HashCodeBuilder#append");
  });

  it("resolves an implicit-receiver bare call to the enclosing class's static method when only the static form exists", () => {
    // `helper()` invoked inside an instance method but `helper` is declared
    // static — the `.` form must win when the `#` form is absent.
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("Foo.java", [
      { symbolId: "Foo.helper", fqName: "Foo.helper", shortName: "helper", relPath: "Foo.java", scope: ["Foo"] },
    ]);
    const target = r.resolve(
      { callText: "helper()", receiver: null, member: "helper", startLine: 4 },
      { callerFile: "Foo.java", callerScope: ["Foo"], imports: [], symbolTable: t },
    );
    expect(target?.targetRelPath).toBe("Foo.java");
    expect(target?.targetSymbolId).toBe("Foo.helper");
  });

  it("resolves `this.X()` to the enclosing class's instance method (same file)", () => {
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("Foo.java", [
      { symbolId: "Foo#helper", fqName: "Foo#helper", shortName: "helper", relPath: "Foo.java", scope: ["Foo"] },
    ]);
    const target = r.resolve(
      { callText: "this.helper()", receiver: "this", member: "helper", startLine: 1 },
      { callerFile: "Foo.java", callerScope: ["Foo"], imports: [], symbolTable: t },
    );
    expect(target?.targetRelPath).toBe("Foo.java");
    expect(target?.targetSymbolId).toBe("Foo#helper");
  });

  it("prefers the enclosing-class instance method over an ambiguous global short-name (no misroute)", () => {
    // `append` exists in BOTH the caller's class (HashCodeBuilder) AND
    // another file (StringBuffer). Without the enclosing-class check the
    // global short-name lookup is ambiguous (strict-mode → null). With
    // the check the bare call must pin to HashCodeBuilder#append.
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("HashCodeBuilder.java", [
      {
        symbolId: "HashCodeBuilder#append",
        fqName: "HashCodeBuilder#append",
        shortName: "append",
        relPath: "HashCodeBuilder.java",
        scope: ["HashCodeBuilder"],
      },
    ]);
    t.upsertFile("StringBuffer.java", [
      {
        symbolId: "StringBuffer#append",
        fqName: "StringBuffer#append",
        shortName: "append",
        relPath: "StringBuffer.java",
        scope: ["StringBuffer"],
      },
    ]);
    const target = r.resolve(
      { callText: "append(element)", receiver: null, member: "append", startLine: 5 },
      {
        callerFile: "HashCodeBuilder.java",
        callerScope: ["HashCodeBuilder"],
        imports: [],
        symbolTable: t,
      },
    );
    expect(target?.targetRelPath).toBe("HashCodeBuilder.java");
    expect(target?.targetSymbolId).toBe("HashCodeBuilder#append");
  });

  // bd tea-rags-mcp-cvv9 — receiver-type tracking. The walker now records
  // `localBindings` (param + local-var types) and `classFieldTypes`
  // (field types). The resolver consults them BEFORE the ambiguous
  // short-name fallback/drop so `param.method()` / `localVar.method()` /
  // `this.field.method()` pin to the receiver's declared type.
  describe("local-type / field-type receiver resolution", () => {
    it("resolves `cs.charAt(i)` to the type-qualified `CharSequence#charAt` for an external param type", () => {
      // Real commons-lang StringUtils#isBlank: `cs` is a parameter typed
      // CharSequence (a JDK interface NOT in the indexed repo). The walker
      // binds `{ cs: "CharSequence" }`. The resolver emits the
      // type-qualified best-effort target — `CharSequence#charAt` — anchored
      // to the bare type name rather than fabricating a wrong project file.
      const r = new JavaCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      // An unrelated `StrBuilder#charAt` exists — the OLD short-name fallback
      // would have misrouted to it. The binding must win and route to
      // CharSequence instead.
      t.upsertFile("StrBuilder.java", [
        {
          symbolId: "StrBuilder#charAt",
          fqName: "StrBuilder#charAt",
          shortName: "charAt",
          relPath: "StrBuilder.java",
          scope: ["StrBuilder"],
        },
      ]);
      const target = r.resolve(
        { callText: "cs.charAt(i)", receiver: "cs", member: "charAt", startLine: 3 },
        {
          callerFile: "StringUtils.java",
          callerScope: ["StringUtils"],
          imports: [],
          symbolTable: t,
          localBindings: { cs: "CharSequence" },
        },
      );
      expect(target?.targetSymbolId).toBe("CharSequence#charAt");
      expect(target?.targetRelPath).toBe("CharSequence");
    });

    it("resolves `localVar.method()` to the indexed type's method when the bound type is in the table", () => {
      // `Bar b = makeBar(); b.run();` — walker binds `{ b: "Bar" }`. Bar is
      // an indexed project class with an instance method `run`, so the
      // resolver returns the real `Bar#run` symbol + its file.
      const r = new JavaCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("Bar.java", [
        { symbolId: "Bar#run", fqName: "Bar#run", shortName: "run", relPath: "Bar.java", scope: ["Bar"] },
      ]);
      const target = r.resolve(
        { callText: "b.run()", receiver: "b", member: "run", startLine: 4 },
        {
          callerFile: "X.java",
          callerScope: ["X"],
          imports: [],
          symbolTable: t,
          localBindings: { b: "Bar" },
        },
      );
      expect(target?.targetRelPath).toBe("Bar.java");
      expect(target?.targetSymbolId).toBe("Bar#run");
    });

    it("resolves `this.foo.bar()` to `Foo#bar` via classFieldTypes", () => {
      // Field `private Foo foo;` → classFieldTypes { Owner: { foo: "Foo" } }.
      // `this.foo.bar()` has receiver "this.foo"; the resolver reads the
      // field type from the enclosing class and resolves `Foo#bar`.
      const r = new JavaCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("Foo.java", [
        { symbolId: "Foo#bar", fqName: "Foo#bar", shortName: "bar", relPath: "Foo.java", scope: ["Foo"] },
      ]);
      const target = r.resolve(
        { callText: "this.foo.bar()", receiver: "this.foo", member: "bar", startLine: 3 },
        {
          callerFile: "Owner.java",
          callerScope: ["Owner"],
          imports: [],
          symbolTable: t,
          classFieldTypes: { Owner: { foo: "Foo" } },
        },
      );
      expect(target?.targetRelPath).toBe("Foo.java");
      expect(target?.targetSymbolId).toBe("Foo#bar");
    });

    it("NEGATIVE: drops the edge when the receiver has no binding and no import (no fabricated edge)", () => {
      // `cs.charAt(i)` with NO localBindings and NO import — the resolver
      // must NOT misroute to the unrelated `StrBuilder#charAt`. Drop.
      const r = new JavaCallResolver();
      const t = new InMemoryGlobalSymbolTable();
      t.upsertFile("StrBuilder.java", [
        {
          symbolId: "StrBuilder#charAt",
          fqName: "StrBuilder#charAt",
          shortName: "charAt",
          relPath: "StrBuilder.java",
          scope: ["StrBuilder"],
        },
      ]);
      const target = r.resolve(
        { callText: "cs.charAt(i)", receiver: "cs", member: "charAt", startLine: 3 },
        { callerFile: "StringUtils.java", callerScope: ["StringUtils"], imports: [], symbolTable: t },
      );
      expect(target).toBeNull();
    });
  });

  it("does not misroute a bare call when the enclosing-class entry is absent (falls through to global lookup)", () => {
    // Enclosing class `Foo` has no `helper` member, but a unique global
    // `helper` exists. The enclosing-class check must miss cleanly and
    // delegate to the existing no-receiver global fallback.
    const r = new JavaCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("Helpers.java", [
      { symbolId: "Helpers.run", fqName: "Helpers.run", shortName: "run", relPath: "Helpers.java", scope: ["Helpers"] },
    ]);
    const target = r.resolve(
      { callText: "run()", receiver: null, member: "run", startLine: 2 },
      { callerFile: "Foo.java", callerScope: ["Foo"], imports: [], symbolTable: t },
    );
    expect(target?.targetRelPath).toBe("Helpers.java");
    expect(target?.targetSymbolId).toBe("Helpers.run");
  });
});
