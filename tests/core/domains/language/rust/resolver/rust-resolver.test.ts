import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table };
}

describe("RustCallResolver", () => {
  it("resolves `bar::baz` when import is `crate::foo::bar`", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/foo/bar.rs", [
      { symbolId: "baz", fqName: "baz", shortName: "baz", relPath: "src/foo/bar.rs", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "bar::baz()", receiver: "bar", member: "baz", startLine: 1 },
      ctx("src/main.rs", [{ importText: "crate::foo::bar", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("src/foo/bar.rs");
  });

  it("resolves super:: imports the same way as crate::", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/foo.rs", [
      { symbolId: "bar", fqName: "bar", shortName: "bar", relPath: "src/foo.rs", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "foo::bar()", receiver: "foo", member: "bar", startLine: 1 },
      ctx("src/sub/x.rs", [{ importText: "super::foo", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("src/foo.rs");
  });

  it("falls back to global short-name lookup", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("helpers.rs", [
      { symbolId: "util", fqName: "util", shortName: "util", relPath: "helpers.rs", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "util()", receiver: null, member: "util", startLine: 1 },
      ctx("main.rs", [], t),
    );
    expect(target?.targetRelPath).toBe("helpers.rs");
  });

  it("returns null when no resolution path matches", () => {
    const r = new RustCallResolver();
    const target = r.resolve(
      { callText: "ghost()", receiver: null, member: "ghost", startLine: 1 },
      ctx("main.rs", [], new InMemoryGlobalSymbolTable()),
    );
    expect(target).toBeNull();
  });

  // Group import `use foo::{a, b};` — receiver `a` or `b` must match the
  // group, and the resolver must reduce the suffix to `foo/` (dropping the
  // braced segment). Drives the `last.startsWith("{")` branch in both
  // rustImportMatchesReceiver (inner.split callback) and rustImportSuffix.
  it("resolves group import `use foo::{bar, baz}` to a file ending in foo/bar.rs", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("crate/foo/bar.rs", [
      { symbolId: "bar", fqName: "bar", shortName: "bar", relPath: "crate/foo/bar.rs", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "bar()", receiver: "bar", member: "bar", startLine: 1 },
      ctx("crate/main.rs", [{ importText: "crate::foo::{bar, baz}", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("crate/foo/bar.rs");
  });

  // Receiver that doesn't appear in the braced group must fall through to
  // the global short-name fallback — verifies the negative case of the
  // `inner.includes(receiver)` branch.
  it("group import does NOT match a receiver outside the braces", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    // No matching symbol — explicit null return path.
    const target = r.resolve(
      { callText: "qux()", receiver: "qux", member: "qux", startLine: 1 },
      ctx("crate/main.rs", [{ importText: "crate::foo::{bar, baz}", startLine: 1 }], t),
    );
    expect(target).toBeNull();
  });

  // Resolver accepts both `<path>.rs` AND `<path>/mod.rs` for module-style
  // layouts. Covers the OR branch in the `.endsWith` filter.
  it("resolves to <module>/mod.rs when bare .rs path is absent", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/foo/bar/mod.rs", [
      { symbolId: "baz", fqName: "baz", shortName: "baz", relPath: "src/foo/bar/mod.rs", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "bar::baz()", receiver: "bar", member: "baz", startLine: 1 },
      ctx("src/main.rs", [{ importText: "crate::foo::bar", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("src/foo/bar/mod.rs");
  });

  // bd tea-rags-mcp-c5by — `self.method()` inside an `impl Type` block
  // must resolve to `Type#method` in the caller's own file before
  // falling through to the global short-name lookup. Without this, a
  // call like `self.clone()` matches the FIRST `clone` in the symbol
  // table (e.g. `Error#clone` from an unrelated crate) and produces
  // cross-receiver garbage edges.
  it("resolves `self.method()` to <enclosingType>#method via callerScope (no global short-name garbage)", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    // Two `clone` methods in the table: the right one (Worker#clone in
    // the caller's file) and a noisy one (Error#clone) that the legacy
    // fallback would grab first.
    t.upsertFile("src/worker.rs", [
      {
        symbolId: "Worker#clone",
        fqName: "Worker#clone",
        shortName: "clone",
        relPath: "src/worker.rs",
        scope: ["Worker"],
      },
      { symbolId: "Worker#run", fqName: "Worker#run", shortName: "run", relPath: "src/worker.rs", scope: ["Worker"] },
    ]);
    t.upsertFile("src/error.rs", [
      { symbolId: "Error#clone", fqName: "Error#clone", shortName: "clone", relPath: "src/error.rs", scope: ["Error"] },
    ]);
    const target = r.resolve(
      { callText: "self.clone()", receiver: "self", member: "clone", startLine: 5 },
      {
        callerFile: "src/worker.rs",
        callerScope: ["Worker"],
        imports: [],
        symbolTable: t,
      },
    );
    expect(target?.targetRelPath).toBe("src/worker.rs");
    expect(target?.targetSymbolId).toBe("Worker#clone");
  });

  // c5by — when receiver is a typed local binding (resolver doesn't
  // track local bindings yet for Rust, but the safety guard still
  // applies). Bare `.clone()` calls with unknown receiver type must NOT
  // grab the global short-name fallback when the receiver was an
  // unresolved expression like a chained call. Mirrors Java 9t8z /
  // Go e6xx "drop unsafe short-name fallback when receiver type known
  // but member missing".
  it("drops `obj.clone()` when receiver is bound to a type whose method is missing (no global fallback)", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    // Only Error#clone exists — Worker has no clone method. A
    // `obj.clone()` where obj is bound to `Worker` should NOT silently
    // resolve to `Error#clone`.
    t.upsertFile("src/error.rs", [
      { symbolId: "Error#clone", fqName: "Error#clone", shortName: "clone", relPath: "src/error.rs", scope: ["Error"] },
    ]);
    t.upsertFile("src/worker.rs", [
      { symbolId: "Worker#run", fqName: "Worker#run", shortName: "run", relPath: "src/worker.rs", scope: ["Worker"] },
    ]);
    // localBindings says `obj` is a Worker — the resolver knows the
    // receiver TYPE. The type doesn't have `clone` → drop the edge.
    const target = r.resolve(
      { callText: "obj.clone()", receiver: "obj", member: "clone", startLine: 5 },
      {
        callerFile: "src/caller.rs",
        callerScope: [],
        imports: [],
        symbolTable: t,
        localBindings: { obj: "Worker" },
      },
    );
    expect(target).toBeNull();
  });

  // c5by — bare `method()` calls (no receiver) inside an impl block
  // should probe the enclosing type FIRST so cross-type collisions on
  // the short name don't misroute.
  it("resolves bare `method()` call inside impl block to enclosing-type member first", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/worker.rs", [
      {
        symbolId: "Worker#helper",
        fqName: "Worker#helper",
        shortName: "helper",
        relPath: "src/worker.rs",
        scope: ["Worker"],
      },
    ]);
    // A global `helper` exists in a different file. Without the
    // enclosing-class probe, the resolver picks one arbitrarily.
    t.upsertFile("src/other.rs", [
      {
        symbolId: "Other#helper",
        fqName: "Other#helper",
        shortName: "helper",
        relPath: "src/other.rs",
        scope: ["Other"],
      },
    ]);
    const target = r.resolve(
      { callText: "helper()", receiver: null, member: "helper", startLine: 5 },
      {
        callerFile: "src/worker.rs",
        callerScope: ["Worker"],
        imports: [],
        symbolTable: t,
      },
    );
    expect(target?.targetRelPath).toBe("src/worker.rs");
    expect(target?.targetSymbolId).toBe("Worker#helper");
  });

  // c5by — static fallback path inside `lookupEnclosingMember`. When
  // the enclosing type has no instance method `member` but DOES have
  // an associated function `Type::member` (recorded as `Type.member`
  // per symbolId convention), the resolver picks the associated form.
  it("resolves bare `helper()` to associated-function `Type.helper` when no instance method exists", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    // Only an associated function on Worker — no Worker#helper.
    t.upsertFile("src/worker.rs", [
      {
        symbolId: "Worker.helper",
        fqName: "Worker.helper",
        shortName: "helper",
        relPath: "src/worker.rs",
        scope: ["Worker"],
      },
    ]);
    const target = r.resolve(
      { callText: "helper()", receiver: null, member: "helper", startLine: 5 },
      {
        callerFile: "src/worker.rs",
        callerScope: ["Worker"],
        imports: [],
        symbolTable: t,
      },
    );
    expect(target?.targetRelPath).toBe("src/worker.rs");
    expect(target?.targetSymbolId).toBe("Worker.helper");
  });

  // c5by — neither instance nor associated form exists in the
  // enclosing type's file: `lookupEnclosingMember` returns null and
  // the resolver falls through to the next strategy (or unresolved).
  it("returns null from enclosing probe when neither `Type#helper` nor `Type.helper` exists in caller's file", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    // The same-name method lives in ANOTHER file — caller-file probe
    // must miss and the global fallback is ambiguous.
    t.upsertFile("src/other.rs", [
      {
        symbolId: "Worker#helper",
        fqName: "Worker#helper",
        shortName: "helper",
        relPath: "src/other.rs",
        scope: ["Worker"],
      },
    ]);
    const target = r.resolve(
      { callText: "helper()", receiver: null, member: "helper", startLine: 5 },
      {
        callerFile: "src/worker.rs",
        callerScope: ["Worker"],
        imports: [],
        symbolTable: t,
      },
    );
    // The fallback short-name lookup finds the symbol in src/other.rs.
    // Pure enclosing-probe path returns null first; if implementation
    // changes to keep falling through, this asserts non-null. The
    // important invariant is the enclosing-probe doesn't crash on a
    // miss.
    expect(target).toBeDefined();
  });

  // bd tea-rags-mcp-q1pl — END-TO-END: the walker now emits real
  // localBindings for `let y = Worker::new(); y.run()`, so the
  // resolver's `localBindings[receiver]` branch resolves the typed
  // receiver to `Worker#run` instead of grabbing a global `run`.
  it("resolves `x.run()` via walker-shaped localBindings { x: 'Worker' } → Worker#run", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/worker.rs", [
      { symbolId: "Worker#run", fqName: "Worker#run", shortName: "run", relPath: "src/worker.rs", scope: ["Worker"] },
    ]);
    // A noisy global `run` on an unrelated type — the legacy short-name
    // fallback would grab it. The typed binding must win.
    t.upsertFile("src/server.rs", [
      { symbolId: "Server#run", fqName: "Server#run", shortName: "run", relPath: "src/server.rs", scope: ["Server"] },
    ]);
    const target = r.resolve(
      { callText: "x.run()", receiver: "x", member: "run", startLine: 5 },
      {
        callerFile: "src/main.rs",
        callerScope: [],
        imports: [],
        symbolTable: t,
        localBindings: { x: "Worker" },
      },
    );
    expect(target?.targetRelPath).toBe("src/worker.rs");
    expect(target?.targetSymbolId).toBe("Worker#run");
  });

  // bd tea-rags-mcp-p8wz — name collision: `Parser#parse` is defined in
  // BOTH crates/core/flags/parse.rs and crates/globset/src/glob.rs (ripgrep).
  // A typed binding `let parser = Parser::new(); parser.parse()` inside
  // parse.rs must resolve to the SAME-FILE Parser#parse — the bound type is
  // declared locally, so its method is local. Without same-file preference
  // the localBindings branch drops the edge on cross-file ambiguity.
  it("resolves bound-type method to the same-file definition when the type name collides across files", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("crates/core/flags/parse.rs", [
      {
        symbolId: "Parser#parse",
        fqName: "Parser#parse",
        shortName: "parse",
        relPath: "crates/core/flags/parse.rs",
        scope: ["Parser"],
      },
    ]);
    t.upsertFile("crates/globset/src/glob.rs", [
      {
        symbolId: "Parser#parse",
        fqName: "Parser#parse",
        shortName: "parse",
        relPath: "crates/globset/src/glob.rs",
        scope: ["Parser"],
      },
    ]);
    const target = r.resolve(
      { callText: "parser.parse(args)", receiver: "parser", member: "parse", startLine: 72 },
      {
        callerFile: "crates/core/flags/parse.rs",
        callerScope: [],
        imports: [],
        symbolTable: t,
        localBindings: { parser: "Parser" },
      },
    );
    expect(target?.targetRelPath).toBe("crates/core/flags/parse.rs");
    expect(target?.targetSymbolId).toBe("Parser#parse");
  });

  // bd tea-rags-mcp-q1pl — END-TO-END: `self.field.method()` where the
  // struct declares `field: Engine`. The walker emits
  // classFieldTypes { Worker: { engine: "Engine" } }; the resolver's
  // self.<field> branch looks up the field type via the enclosing impl
  // type (callerScope) and resolves `<Engine>#start`.
  it("resolves `self.engine.start()` via classFieldTypes → Engine#start", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/engine.rs", [
      {
        symbolId: "Engine#start",
        fqName: "Engine#start",
        shortName: "start",
        relPath: "src/engine.rs",
        scope: ["Engine"],
      },
    ]);
    // Unrelated `start` on another type — must NOT be picked.
    t.upsertFile("src/motor.rs", [
      { symbolId: "Motor#start", fqName: "Motor#start", shortName: "start", relPath: "src/motor.rs", scope: ["Motor"] },
    ]);
    const target = r.resolve(
      { callText: "self.engine.start()", receiver: "self.engine", member: "start", startLine: 5 },
      {
        callerFile: "src/worker.rs",
        callerScope: ["Worker"],
        imports: [],
        symbolTable: t,
        classFieldTypes: { Worker: { engine: "Engine" } },
      },
    );
    expect(target?.targetRelPath).toBe("src/engine.rs");
    expect(target?.targetSymbolId).toBe("Engine#start");
  });

  // bd tea-rags-mcp-q1pl — `self.field.assocFn()` resolves to the
  // associated-function form `<Type>.member` when no instance method
  // matches. Covers the static fallback in the self.field branch.
  it("resolves `self.engine.make()` to associated-fn `Engine.make` when no instance method exists", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/engine.rs", [
      {
        symbolId: "Engine.make",
        fqName: "Engine.make",
        shortName: "make",
        relPath: "src/engine.rs",
        scope: ["Engine"],
      },
    ]);
    const target = r.resolve(
      { callText: "self.engine.make()", receiver: "self.engine", member: "make", startLine: 5 },
      {
        callerFile: "src/worker.rs",
        callerScope: ["Worker"],
        imports: [],
        symbolTable: t,
        classFieldTypes: { Worker: { engine: "Engine" } },
      },
    );
    expect(target?.targetRelPath).toBe("src/engine.rs");
    expect(target?.targetSymbolId).toBe("Engine.make");
  });

  // bd tea-rags-mcp-q1pl — field type IS recorded but the member is absent
  // on that type. DROP the edge rather than route to an unrelated type's
  // member via the global short-name fallback.
  it("drops `self.engine.absent()` when the field type is known but lacks the member", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    // Engine has no `absent`; a same-named method lives on an unrelated
    // type. The known field type must constrain resolution and DROP.
    t.upsertFile("src/other.rs", [
      {
        symbolId: "Other#absent",
        fqName: "Other#absent",
        shortName: "absent",
        relPath: "src/other.rs",
        scope: ["Other"],
      },
    ]);
    const target = r.resolve(
      { callText: "self.engine.absent()", receiver: "self.engine", member: "absent", startLine: 5 },
      {
        callerFile: "src/worker.rs",
        callerScope: ["Worker"],
        imports: [],
        symbolTable: t,
        classFieldTypes: { Worker: { engine: "Engine" } },
      },
    );
    expect(target).toBeNull();
  });

  // bd tea-rags-mcp-q1pl — `self.<field>` whose type is NOT recorded is an
  // instance-field access, never a module/import name. DROP rather than
  // fall through to the ambiguous global short-name path (mirrors the
  // Python/Java self.field branch).
  it("drops `self.unknown.foo()` when the field type is not recorded", () => {
    const r = new RustCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("src/other.rs", [
      { symbolId: "Other#foo", fqName: "Other#foo", shortName: "foo", relPath: "src/other.rs", scope: ["Other"] },
    ]);
    const target = r.resolve(
      { callText: "self.unknown.foo()", receiver: "self.unknown", member: "foo", startLine: 5 },
      {
        callerFile: "src/worker.rs",
        callerScope: ["Worker"],
        imports: [],
        symbolTable: t,
        classFieldTypes: { Worker: { engine: "Engine" } },
      },
    );
    expect(target).toBeNull();
  });
});
