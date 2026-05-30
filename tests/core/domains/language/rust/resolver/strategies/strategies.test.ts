import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  RustBareSelfMethodSymbolResolutionStrategy,
  RustGlobalShortNameSymbolResolutionStrategy,
  RustImportMatchSymbolResolutionStrategy,
  RustLocalBindingSymbolResolutionStrategy,
  RustSelfFieldSymbolResolutionStrategy,
  RustSelfMethodSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/rust/resolver/strategies/index.js";
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
  callerFile: "src/caller.rs",
  callerScope: [],
  imports: [],
  ...over,
});

describe("RustSelfMethodSymbolResolutionStrategy", () => {
  const strat = new RustSelfMethodSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "self.clone()", receiver: "self", member: "clone", startLine: 1 };

  it("continues when the receiver is not `self`", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: "obj" }, ctx({ symbolTable, callerScope: ["Worker"] }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when callerScope is empty (no enclosing impl)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable, callerScope: [] }));
    expect(outcome.kind).toBe("continue");
  });

  it("resolves `self.method()` to the same-file enclosing instance method", () => {
    const symbolTable = tableWith(
      ["src/worker.rs", [sym("Worker#clone", "clone", "src/worker.rs", ["Worker"])]],
      ["src/error.rs", [sym("Error#clone", "clone", "src/error.rs", ["Error"])]],
    );
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/worker.rs", callerScope: ["Worker"] }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/worker.rs", targetSymbolId: "Worker#clone" },
    });
  });

  it("continues (never drops) when the enclosing member is not in the caller's file", () => {
    const symbolTable = tableWith(["src/other.rs", [sym("Worker#clone", "clone", "src/other.rs", ["Worker"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/worker.rs", callerScope: ["Worker"] }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("RustSelfFieldSymbolResolutionStrategy", () => {
  const strat = new RustSelfFieldSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "self.engine.start()", receiver: "self.engine", member: "start", startLine: 1 };

  it("continues when the receiver is not a `self.<field>` access", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: "obj" }, ctx({ symbolTable, callerScope: ["Worker"] }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues on chained access `self.a.b.c()` (out of scope)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { ...call, receiver: "self.a.b" },
      ctx({ symbolTable, callerScope: ["Worker"], classFieldTypes: { Worker: { a: "T" } } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("resolves `self.field.method()` to the field type's instance method", () => {
    const symbolTable = tableWith(
      ["src/engine.rs", [sym("Engine#start", "start", "src/engine.rs", ["Engine"])]],
      ["src/motor.rs", [sym("Motor#start", "start", "src/motor.rs", ["Motor"])]],
    );
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerScope: ["Worker"], classFieldTypes: { Worker: { engine: "Engine" } } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/engine.rs", targetSymbolId: "Engine#start" },
    });
  });

  it("resolves `self.field.assocFn()` to the field type's associated function on instance miss", () => {
    const symbolTable = tableWith(["src/engine.rs", [sym("Engine.make", "make", "src/engine.rs", ["Engine"])]]);
    const outcome = strat.attempt(
      { ...call, callText: "self.engine.make()", member: "make" },
      ctx({ symbolTable, callerScope: ["Worker"], classFieldTypes: { Worker: { engine: "Engine" } } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/engine.rs", targetSymbolId: "Engine.make" },
    });
  });

  it("DROPS when the field type is known but lacks the member — guard q1pl", () => {
    const symbolTable = tableWith(["src/other.rs", [sym("Other#absent", "absent", "src/other.rs", ["Other"])]]);
    const outcome = strat.attempt(
      { ...call, callText: "self.engine.absent()", member: "absent" },
      ctx({ symbolTable, callerScope: ["Worker"], classFieldTypes: { Worker: { engine: "Engine" } } }),
    );
    // Field type known but member missing must DROP — never fall through to a
    // global short-name lookup that would route to an unrelated type's member.
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS when the field type is NOT recorded — guard q1pl", () => {
    const symbolTable = tableWith(["src/other.rs", [sym("Other#foo", "foo", "src/other.rs", ["Other"])]]);
    const outcome = strat.attempt(
      { ...call, callText: "self.unknown.foo()", receiver: "self.unknown", member: "foo" },
      ctx({ symbolTable, callerScope: ["Worker"], classFieldTypes: { Worker: { engine: "Engine" } } }),
    );
    // A `self.<field>` receiver is an instance-field access, never a
    // module/import name — DROP rather than fall through to short-name lookup.
    expect(outcome.kind).toBe("drop");
  });
});

describe("RustLocalBindingSymbolResolutionStrategy", () => {
  const strat = new RustLocalBindingSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "x.run()", receiver: "x", member: "run", startLine: 1 };

  it("continues when the receiver is null", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: null }, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the receiver has no bound type", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: {} }));
    expect(outcome.kind).toBe("continue");
  });

  it("resolves a bound-type receiver to the type's instance method", () => {
    const symbolTable = tableWith(
      ["src/worker.rs", [sym("Worker#run", "run", "src/worker.rs", ["Worker"])]],
      ["src/server.rs", [sym("Server#run", "run", "src/server.rs", ["Server"])]],
    );
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { x: "Worker" } }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/worker.rs", targetSymbolId: "Worker#run" },
    });
  });

  it("prefers the same-file definition when the bound type name collides across files — p8wz", () => {
    const symbolTable = tableWith(
      ["crates/core/flags/parse.rs", [sym("Parser#parse", "parse", "crates/core/flags/parse.rs", ["Parser"])]],
      ["crates/globset/src/glob.rs", [sym("Parser#parse", "parse", "crates/globset/src/glob.rs", ["Parser"])]],
    );
    const outcome = strat.attempt(
      { callText: "parser.parse()", receiver: "parser", member: "parse", startLine: 1 },
      ctx({ symbolTable, callerFile: "crates/core/flags/parse.rs", localBindings: { parser: "Parser" } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "crates/core/flags/parse.rs", targetSymbolId: "Parser#parse" },
    });
  });

  it("DROPS when the bound type is known but lacks the member — guard c5by", () => {
    const symbolTable = tableWith(
      ["src/error.rs", [sym("Error#clone", "clone", "src/error.rs", ["Error"])]],
      ["src/worker.rs", [sym("Worker#run", "run", "src/worker.rs", ["Worker"])]],
    );
    const outcome = strat.attempt(
      { callText: "obj.clone()", receiver: "obj", member: "clone", startLine: 1 },
      ctx({ symbolTable, localBindings: { obj: "Worker" } }),
    );
    // Worker has no `clone` — DROP rather than silently route to Error#clone.
    expect(outcome.kind).toBe("drop");
  });
});

describe("RustImportMatchSymbolResolutionStrategy", () => {
  const strat = new RustImportMatchSymbolResolutionStrategy(cfg);

  it("continues when the receiver is null", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "util()", receiver: null, member: "util", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("resolves a receiver matching `use crate::foo::bar` to a file ending in foo/bar.rs", () => {
    const symbolTable = tableWith(["src/foo/bar.rs", [sym("baz", "baz", "src/foo/bar.rs", [])]]);
    const outcome = strat.attempt(
      { callText: "bar::baz()", receiver: "bar", member: "baz", startLine: 1 },
      ctx({ symbolTable, callerFile: "src/main.rs", imports: [{ importText: "crate::foo::bar", startLine: 1 }] }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/foo/bar.rs", targetSymbolId: "baz" } });
  });

  it("resolves a braced group member `use foo::{bar, baz}` to the bar module file", () => {
    // The braced group reduces the suffix to `foo`, so a file ending in
    // `foo.rs` (the `bar` module re-exported under foo) is the basename match.
    const symbolTable = tableWith(["crate/foo.rs", [sym("run", "run", "crate/foo.rs", [])]]);
    const outcome = strat.attempt(
      { callText: "bar::run()", receiver: "bar", member: "run", startLine: 1 },
      ctx({
        symbolTable,
        callerFile: "crate/main.rs",
        imports: [{ importText: "crate::foo::{bar, baz}", startLine: 1 }],
      }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "crate/foo.rs", targetSymbolId: "run" } });
  });

  it("resolves to `<module>/mod.rs` when the bare `.rs` path is absent", () => {
    const symbolTable = tableWith(["src/foo/bar/mod.rs", [sym("baz", "baz", "src/foo/bar/mod.rs", [])]]);
    const outcome = strat.attempt(
      { callText: "bar::baz()", receiver: "bar", member: "baz", startLine: 1 },
      ctx({ symbolTable, callerFile: "src/main.rs", imports: [{ importText: "crate::foo::bar", startLine: 1 }] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/foo/bar/mod.rs", targetSymbolId: "baz" },
    });
  });

  it("continues when the receiver is outside the braced group", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "qux()", receiver: "qux", member: "qux", startLine: 1 },
      ctx({
        symbolTable,
        callerFile: "crate/main.rs",
        imports: [{ importText: "crate::foo::{bar, baz}", startLine: 1 }],
      }),
    );
    expect(outcome.kind).toBe("continue");
  });
});

describe("RustBareSelfMethodSymbolResolutionStrategy", () => {
  const strat = new RustBareSelfMethodSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "helper()", receiver: null, member: "helper", startLine: 1 };

  it("continues when the receiver is not null", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: "self" }, ctx({ symbolTable, callerScope: ["Worker"] }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when callerScope is empty (not inside an impl)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable, callerScope: [] }));
    expect(outcome.kind).toBe("continue");
  });

  it("resolves a bare call inside an impl to the enclosing-type member first", () => {
    const symbolTable = tableWith(
      ["src/worker.rs", [sym("Worker#helper", "helper", "src/worker.rs", ["Worker"])]],
      ["src/other.rs", [sym("Other#helper", "helper", "src/other.rs", ["Other"])]],
    );
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/worker.rs", callerScope: ["Worker"] }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/worker.rs", targetSymbolId: "Worker#helper" },
    });
  });

  it("continues (never drops) when neither instance nor associated form exists in the caller's file", () => {
    const symbolTable = tableWith(["src/other.rs", [sym("Worker#helper", "helper", "src/other.rs", ["Worker"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/worker.rs", callerScope: ["Worker"] }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("RustGlobalShortNameSymbolResolutionStrategy", () => {
  const strat = new RustGlobalShortNameSymbolResolutionStrategy(cfg);

  it("resolves a sole short-name candidate", () => {
    const symbolTable = tableWith(["helpers.rs", [sym("util", "util", "helpers.rs", [])]]);
    const outcome = strat.attempt(
      { callText: "util()", receiver: null, member: "util", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "helpers.rs", targetSymbolId: "util" } });
  });

  it("continues when no candidate matches", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "ghost()", receiver: null, member: "ghost", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("continue");
  });
});
