import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  JavaEnclosingBareCallSymbolResolutionStrategy,
  JavaFieldTypeSymbolResolutionStrategy,
  JavaGlobalShortNameSymbolResolutionStrategy,
  JavaImportReceiverSymbolResolutionStrategy,
  JavaLocalBindingSymbolResolutionStrategy,
  JavaThisMemberSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/java/resolver/strategies/index.js";
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
  callerFile: "Caller.java",
  callerScope: [],
  imports: [],
  ...over,
});

describe("JavaThisMemberSymbolResolutionStrategy", () => {
  const strat = new JavaThisMemberSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "this.helper()", receiver: "this", member: "helper", startLine: 1 };

  it("resolves `this.X()` against the enclosing class in the SAME file (instance form)", () => {
    const symbolTable = tableWith(["Foo.java", [sym("Foo#helper", "helper", "Foo.java", ["Foo"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "Foo.java", callerScope: ["Foo"] }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "Foo.java", targetSymbolId: "Foo#helper" },
    });
  });

  it("continues when the receiver is not `this`", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: "obj" }, ctx({ symbolTable, callerScope: ["Foo"] }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when `this.X` is not found in the caller's own file", () => {
    const symbolTable = tableWith(["Other.java", [sym("Other#helper", "helper", "Other.java", ["Other"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "Foo.java", callerScope: ["Foo"] }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("JavaFieldTypeSymbolResolutionStrategy", () => {
  const strat = new JavaFieldTypeSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "this.foo.bar()", receiver: "this.foo", member: "bar", startLine: 1 };

  it("resolves `this.field.X()` via the declared field type", () => {
    const symbolTable = tableWith(["Foo.java", [sym("Foo#bar", "bar", "Foo.java", ["Foo"])]]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerScope: ["Owner"], classFieldTypes: { Owner: { foo: "Foo" } } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "Foo.java", targetSymbolId: "Foo#bar" },
    });
  });

  it("resolves to the EXTERNAL type-qualified target when the field type is not indexed", () => {
    // Field type known but absent from the symbol table — the bound type is
    // authoritative, so emit `Foo#bar` anchored to the bare type name rather
    // than continue. resolveByLocalType returns a target unconditionally.
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerScope: ["Owner"], classFieldTypes: { Owner: { foo: "Foo" } } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "Foo", targetSymbolId: "Foo#bar" },
    });
  });

  it("continues when the field type is unknown", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable, callerScope: ["Owner"] }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues on multi-segment chained access `this.a.b.x()` (out of scope)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { ...call, receiver: "this.foo.bar" },
      ctx({ symbolTable, callerScope: ["Owner"], classFieldTypes: { Owner: { foo: "Foo" } } }),
    );
    expect(outcome.kind).toBe("continue");
  });
});

describe("JavaLocalBindingSymbolResolutionStrategy", () => {
  const strat = new JavaLocalBindingSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "b.run()", receiver: "b", member: "run", startLine: 1 };

  it("resolves `localVar.X()` to the indexed type's method via the walker-bound type", () => {
    const symbolTable = tableWith(["Bar.java", [sym("Bar#run", "run", "Bar.java", ["Bar"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { b: [{ line: 1, type: "Bar" }] } }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "Bar.java", targetSymbolId: "Bar#run" },
    });
  });

  it("resolves to the EXTERNAL type-qualified target for a non-indexed bound type (JDK interface)", () => {
    // `cs.charAt(i)` with `cs: CharSequence` — CharSequence is not indexed, so
    // the bound type wins and emits `CharSequence#charAt` anchored to the type.
    const symbolTable = tableWith([
      "StrBuilder.java",
      [sym("StrBuilder#charAt", "charAt", "StrBuilder.java", ["StrBuilder"])],
    ]);
    const outcome = strat.attempt(
      { callText: "cs.charAt(i)", receiver: "cs", member: "charAt", startLine: 1 },
      ctx({ symbolTable, localBindings: { cs: [{ line: 1, type: "CharSequence" }] } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "CharSequence", targetSymbolId: "CharSequence#charAt" },
    });
  });

  it("continues when the receiver has no local binding", () => {
    const symbolTable = tableWith(["Bar.java", [sym("Bar#run", "run", "Bar.java", ["Bar"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the receiver is null (bare call)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: null }, ctx({ symbolTable, localBindings: { b: [{ line: 1, type: "Bar" }] } }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("JavaImportReceiverSymbolResolutionStrategy", () => {
  const strat = new JavaImportReceiverSymbolResolutionStrategy(cfg);

  it("resolves `Bar.method()` to the imported file's symbol", () => {
    const symbolTable = tableWith(["com/foo/Bar.java", [sym("Bar.method", "method", "com/foo/Bar.java", ["Bar"])]]);
    const outcome = strat.attempt(
      { callText: "Bar.method()", receiver: "Bar", member: "method", startLine: 1 },
      ctx({ symbolTable, imports: [{ importText: "com.foo.Bar", startLine: 1 }] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "com/foo/Bar.java", targetSymbolId: "Bar.method" },
    });
  });

  it("resolves to the file-only edge (targetSymbolId null) when the import maps but the symbol is unknown", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "Bar.ghost()", receiver: "Bar", member: "ghost", startLine: 1 },
      ctx({ symbolTable, imports: [{ importText: "com.foo.Bar", startLine: 1 }] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "com/foo/Bar.java", targetSymbolId: null },
    });
  });

  it("resolves a wildcard-imported `Bar.method()` via the scope-filtered short-name salvage", () => {
    const symbolTable = tableWith(["com/foo/Bar.java", [sym("Bar.method", "method", "com/foo/Bar.java", ["Bar"])]]);
    const outcome = strat.attempt(
      { callText: "Bar.method()", receiver: "Bar", member: "method", startLine: 1 },
      ctx({ symbolTable, imports: [{ importText: "com.foo.*", startLine: 1 }] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "com/foo/Bar.java", targetSymbolId: "Bar.method" },
    });
  });

  it("resolves a java.lang whitelist receiver to an EXTERNAL static target (no import)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "Math.max(a, b)", receiver: "Math", member: "max", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "Math", targetSymbolId: "Math.max" },
    });
  });

  it("continues when the receiver is null (bare call — not this pass's case)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "run()", receiver: null, member: "run", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("DROPS a chained-expression receiver with no import — must NOT fall through to short-name (bug guard)", () => {
    // `random().nextBytes()` against same-class `RandomUtils.nextBytes` — the
    // terminal drop prevents the false-positive self-cycle.
    const symbolTable = tableWith([
      "RandomUtils.java",
      [sym("RandomUtils.nextBytes", "nextBytes", "RandomUtils.java", ["RandomUtils"])],
    ]);
    const outcome = strat.attempt(
      { callText: "random().nextBytes(result)", receiver: "random()", member: "nextBytes", startLine: 1 },
      ctx({ symbolTable, callerFile: "RandomUtils.java", callerScope: ["RandomUtils"] }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS a NON-whitelisted capitalized receiver with no import match (whitelist must not loosen)", () => {
    const symbolTable = tableWith([
      "StringUtils.java",
      [sym("StringUtils.compute", "compute", "StringUtils.java", ["StringUtils"])],
    ]);
    const outcome = strat.attempt(
      { callText: "Helper.compute(x)", receiver: "Helper", member: "compute", startLine: 1 },
      ctx({ symbolTable, callerFile: "StringUtils.java", callerScope: ["StringUtils"] }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS a local-variable receiver with no import / binding (no fabricated edge)", () => {
    const symbolTable = tableWith([
      "StrBuilder.java",
      [sym("StrBuilder#charAt", "charAt", "StrBuilder.java", ["StrBuilder"])],
    ]);
    const outcome = strat.attempt(
      { callText: "cs.charAt(i)", receiver: "cs", member: "charAt", startLine: 1 },
      ctx({ symbolTable, callerFile: "StringUtils.java", callerScope: ["StringUtils"] }),
    );
    expect(outcome.kind).toBe("drop");
  });

  it("DROPS a multi-segment dotted receiver (`this.foo.bar`) with no import match", () => {
    const symbolTable = tableWith(["Sibling.java", [sym("Sibling#baz", "baz", "Sibling.java", ["Sibling"])]]);
    const outcome = strat.attempt(
      { callText: "this.foo.bar.baz()", receiver: "this.foo.bar", member: "baz", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("drop");
  });
});

describe("JavaEnclosingBareCallSymbolResolutionStrategy", () => {
  const strat = new JavaEnclosingBareCallSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "append(e)", receiver: null, member: "append", startLine: 1 };

  it("resolves a bare call to the enclosing class's instance method (same file)", () => {
    const symbolTable = tableWith([
      "HashCodeBuilder.java",
      [sym("HashCodeBuilder#append", "append", "HashCodeBuilder.java", ["HashCodeBuilder"])],
    ]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerFile: "HashCodeBuilder.java", callerScope: ["HashCodeBuilder"] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "HashCodeBuilder.java", targetSymbolId: "HashCodeBuilder#append" },
    });
  });

  it("resolves to the enclosing class's static method when only the static form exists", () => {
    const symbolTable = tableWith(["Foo.java", [sym("Foo.helper", "helper", "Foo.java", ["Foo"])]]);
    const outcome = strat.attempt(
      { callText: "helper()", receiver: null, member: "helper", startLine: 1 },
      ctx({ symbolTable, callerFile: "Foo.java", callerScope: ["Foo"] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "Foo.java", targetSymbolId: "Foo.helper" },
    });
  });

  it("continues when the enclosing-class entry is absent", () => {
    const symbolTable = tableWith(["Helpers.java", [sym("Helpers.run", "run", "Helpers.java", ["Helpers"])]]);
    const outcome = strat.attempt(
      { callText: "run()", receiver: null, member: "run", startLine: 1 },
      ctx({ symbolTable, callerFile: "Foo.java", callerScope: ["Foo"] }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the caller scope is empty", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable, callerScope: [] }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("JavaGlobalShortNameSymbolResolutionStrategy", () => {
  const strat = new JavaGlobalShortNameSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "run()", receiver: null, member: "run", startLine: 1 };

  it("resolves a unique global short-name", () => {
    const symbolTable = tableWith(["Helpers.java", [sym("Helpers.run", "run", "Helpers.java", ["Helpers"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "Helpers.java", targetSymbolId: "Helpers.run" },
    });
  });

  it("continues (strict) when the short-name is ambiguous across files", () => {
    const symbolTable = tableWith(
      ["A.java", [sym("A.run", "run", "A.java", ["A"])]],
      ["B.java", [sym("B.run", "run", "B.java", ["B"])]],
    );
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });
});
