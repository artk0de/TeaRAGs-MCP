import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import {
  PythonGlobalShortNameSymbolResolutionStrategy,
  PythonImportMatchSymbolResolutionStrategy,
  PythonLocalBindingSymbolResolutionStrategy,
  PythonSelfFieldSymbolResolutionStrategy,
  PythonSelfMemberSymbolResolutionStrategy,
  PythonSuperSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/python/resolver/strategies/index.js";

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
  callerFile: "src/caller.py",
  callerScope: [],
  imports: [],
  ...over,
});

describe("PythonSuperSymbolResolutionStrategy", () => {
  const strat = new PythonSuperSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "super().__init__()", receiver: "super()", member: "__init__", startLine: 1 };

  it("continues when the receiver is not `super`", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: "self" }, ctx({ symbolTable, callerScope: ["Child"] }));
    expect(outcome.kind).toBe("continue");
  });

  it("DROPS (not continue) when classExtends has no entry for the enclosing class — guard pic4", () => {
    const symbolTable = tableWith(["child.py", [sym("Child#__init__", "__init__", "child.py", ["Child"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "child.py", callerScope: ["Child"] }));
    // `super` is terminal: a miss must DROP, never fall through to the
    // ambiguous short-name fallback that would attribute to a sibling class.
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS when the enclosing class is unknown to classExtends (empty extends map)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerFile: "app.py", callerScope: ["App"], classExtends: {} }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("resolves to the PARENT class method via the classExtends chain", () => {
    const symbolTable = tableWith(
      ["app.py", [sym("App#__init__", "__init__", "app.py", ["App"])]],
      ["scaffold.py", [sym("Scaffold#__init__", "__init__", "scaffold.py", ["Scaffold"])]],
    );
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerFile: "app.py", callerScope: ["App"], classExtends: { App: "Scaffold" } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "scaffold.py", targetSymbolId: "Scaffold#__init__" },
    });
  });

  it("accepts the `super` (no parens) receiver shape too", () => {
    const symbolTable = tableWith(["base.py", [sym("Base#foo", "foo", "base.py", ["Base"])]]);
    const outcome = strat.attempt(
      { callText: "super.foo()", receiver: "super", member: "foo", startLine: 1 },
      ctx({ symbolTable, callerFile: "child.py", callerScope: ["Child"], classExtends: { Child: "Base" } }),
    );
    expect(outcome.kind).toBe("resolved");
  });
});

describe("PythonSelfFieldSymbolResolutionStrategy", () => {
  const strat = new PythonSelfFieldSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "self.service.process()", receiver: "self.service", member: "process", startLine: 1 };

  it("resolves `self.<field>.X()` via the declared field type (instance form)", () => {
    const symbolTable = tableWith(["service.py", [sym("SomeService#process", "process", "service.py", ["SomeService"])]]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerScope: ["Handler"], classFieldTypes: { Handler: { service: "SomeService" } } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "service.py", targetSymbolId: "SomeService#process" },
    });
  });

  it("emits an external best-effort target when the field type is known but the method is external", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { ...call, member: "close", callText: "self._stack.close()", receiver: "self._stack" },
      ctx({ symbolTable, callerScope: ["Client"], classFieldTypes: { Client: { _stack: "ExitStack" } } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "ExitStack", targetSymbolId: "ExitStack#close" },
    });
  });

  it("DROPS when the field has no recorded type — never falls through (guard rjuc)", () => {
    // An unrelated class defines `process`; the guard must NOT attribute it.
    const symbolTable = tableWith(["other.py", [sym("Other#process", "process", "other.py", ["Other"])]]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerScope: ["Handler"], classFieldTypes: { Handler: {} } }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("continues outside a class scope (callerScope empty)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable, classFieldTypes: { Handler: { service: "SomeService" } } }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues on chained access `self.a.b.x()` (out of scope)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { ...call, receiver: "self.a.b" },
      ctx({ symbolTable, callerScope: ["Handler"], classFieldTypes: { Handler: { a: "A" } } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the receiver is not a `self.<field>` access", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { ...call, receiver: "foo" },
      ctx({ symbolTable, callerScope: ["Handler"], classFieldTypes: { Handler: { service: "SomeService" } } }),
    );
    expect(outcome.kind).toBe("continue");
  });
});

describe("PythonSelfMemberSymbolResolutionStrategy", () => {
  const strat = new PythonSelfMemberSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "self.shared()", receiver: "self", member: "shared", startLine: 1 };

  it("resolves `self.X()` walking the enclosing class + classExtends chain", () => {
    const symbolTable = tableWith(
      ["base.py", [sym("Base#shared", "shared", "base.py", ["Base"])]],
      ["leaf.py", [sym("Leaf", "Leaf", "leaf.py", [])]],
    );
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerFile: "leaf.py", callerScope: ["Leaf"], classExtends: { Leaf: "Base" } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "base.py", targetSymbolId: "Base#shared" },
    });
  });

  it("DROPS when no class in the chain defines the member (guard yrs0)", () => {
    // An unrelated class defines `shared`; the guard must NOT attribute it.
    const symbolTable = tableWith(
      ["decoy.py", [sym("Decoy#shared", "shared", "decoy.py", ["Decoy"])]],
      ["leaf.py", [sym("Leaf#run", "run", "leaf.py", ["Leaf"])]],
    );
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerFile: "leaf.py", callerScope: ["Leaf"], classExtends: { Leaf: "werkzeug.Client" } }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("continues when the receiver is not `self`", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: "obj" }, ctx({ symbolTable, callerScope: ["Leaf"] }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when callerScope is empty (module-level self call)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable, callerScope: [] }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("PythonLocalBindingSymbolResolutionStrategy", () => {
  const strat = new PythonLocalBindingSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "service.execute()", receiver: "service", member: "execute", startLine: 1 };

  it("resolves `var.X()` via the walker-bound local type", () => {
    const symbolTable = tableWith([
      "toggle.py",
      [
        sym("ToggleReactionService", "ToggleReactionService", "toggle.py", []),
        sym("ToggleReactionService#execute", "execute", "toggle.py", ["ToggleReactionService"]),
      ],
    ]);
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { service: "ToggleReactionService" } }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "toggle.py", targetSymbolId: "ToggleReactionService#execute" },
    });
  });

  it("emits a file-only edge when the bound type's file is known but the method is external (does NOT continue)", () => {
    // `ToggleReactionSerializer` is in the table but `is_valid` is not — DRF
    // inherits it from a base outside the project. File-only attribution.
    const symbolTable = tableWith([
      "reaction.py",
      [sym("ToggleReactionSerializer", "ToggleReactionSerializer", "reaction.py", [])],
    ]);
    const outcome = strat.attempt(
      { ...call, member: "is_valid", receiver: "serializer", callText: "serializer.is_valid()" },
      ctx({ symbolTable, localBindings: { serializer: "ToggleReactionSerializer" } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "reaction.py", targetSymbolId: null },
    });
  });

  it("DROPS when the bound type's file is unknown (external lib, no import) — never falls through", () => {
    // No symbols, no import resolving to the type — the guard refuses to guess.
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { ...call, member: "run", receiver: "x", callText: "x.run()" },
      ctx({ symbolTable, localBindings: { x: "factory" } }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("walks the bound class's base chain to an inherited method", () => {
    const symbolTable = tableWith(
      ["base.py", [sym("Base#shared", "shared", "base.py", ["Base"])]],
      ["leaf.py", [sym("Leaf", "Leaf", "leaf.py", [])]],
    );
    const outcome = strat.attempt(
      { ...call, member: "shared", receiver: "leaf", callText: "leaf.shared()" },
      ctx({ symbolTable, localBindings: { leaf: "Leaf" }, classExtends: { Leaf: "Base" } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "base.py", targetSymbolId: "Base#shared" },
    });
  });

  it("continues when the receiver has no local binding", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: {} }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when there is no receiver", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: null }, ctx({ symbolTable, localBindings: {} }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("PythonImportMatchSymbolResolutionStrategy", () => {
  const strat = new PythonImportMatchSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 1 };

  it("resolves via an import whose trailing segment matches the receiver", () => {
    const symbolTable = tableWith(["foo.py", [sym("foo.bar", "bar", "foo.py", ["foo"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, imports: [{ importText: "foo", startLine: 1 }] }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "foo.py", targetSymbolId: "foo.bar" },
    });
  });

  it("emits a terminal file-only edge when the import maps but no symbol matches (does NOT continue)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { ...call, member: "ghost", callText: "foo.ghost()" },
      ctx({ symbolTable, imports: [{ importText: "foo", startLine: 1 }] }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "foo.py", targetSymbolId: null } });
  });

  it("continues when no import's trailing segment matches the receiver", () => {
    const symbolTable = tableWith(["foo.py", [sym("foo.bar", "bar", "foo.py", ["foo"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, imports: [{ importText: "unrelated", startLine: 1 }] }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when there is no receiver", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: null }, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("PythonGlobalShortNameSymbolResolutionStrategy", () => {
  const strat = new PythonGlobalShortNameSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "do_thing()", receiver: null, member: "do_thing", startLine: 1 };

  it("resolves a unique global short-name", () => {
    const symbolTable = tableWith(["helper.py", [sym("do_thing", "do_thing", "helper.py", [])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "helper.py", targetSymbolId: "do_thing" } });
  });

  it("continues (strict) when the short-name is ambiguous across files — terminal CONTINUE", () => {
    const symbolTable = tableWith(
      ["a.py", [sym("do_thing", "do_thing", "a.py", [])]],
      ["b.py", [sym("do_thing", "do_thing", "b.py", [])]],
    );
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when there are zero candidates", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });
});
