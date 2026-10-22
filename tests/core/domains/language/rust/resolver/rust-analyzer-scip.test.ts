/**
 * rust-analyzer SCIP as the last Rust resolution strategy (bd s3i8m.6 R3a):
 * the slot maps an in-project SCIP definition onto the narrowest table symbol
 * containing it, DROPs a proven-external site, CONTINUEs otherwise; the miss
 * classifier's external gate gains `scipExternal && hasInProjectDefinition`,
 * which carves only the residual `missWithInProjectDef`.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  SymbolDefinition,
  SymbolDefinitionKind,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type {
  LanguageSymbolResolver,
  RustAnalyzerScipIndex,
  RustAnalyzerScipSource,
  RustScipDefinition,
} from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { RustResolveEnvironment } from "../../../../../../src/core/domains/language/rust/resolver/resolve-environment.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { RustAnalyzerScipSymbolResolutionStrategy } from "../../../../../../src/core/domains/language/rust/resolver/strategies/index.js";
import { classifyResolveMiss } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ROOT = "/repo";
const CALLER = "src/main.rs";

/** A stub index answering `${relPath}:${line}:${col}` keys; records every question. */
function stubIndex(answers: Record<string, RustScipDefinition>): RustAnalyzerScipIndex & { asked: string[] } {
  const asked: string[] = [];
  return {
    identity: "stub",
    asked,
    definitionAt: (relPath, line, utf16Col) => {
      const key = `${relPath}:${line}:${utf16Col}`;
      asked.push(key);
      return answers[key] ?? null;
    },
  };
}

function inProject(name: string, relPath: string, line: number, kind: RustScipDefinition["kind"] = "callable") {
  return {
    symbol: `rust-analyzer cargo mini 0.1.0 ${name}().`,
    package: "mini",
    inProject: true,
    relPath,
    line,
    name,
    kind,
    packageInProject: true,
  } as const;
}

const STD_PUSH: RustScipDefinition = {
  symbol: "rust-analyzer cargo alloc 1.88.0 vec/impl#[`Vec<T, A>`]push().",
  package: "alloc",
  inProject: false,
  name: "push",
  kind: "callable",
  packageInProject: false,
};

const DERIVED_CLONE: RustScipDefinition = {
  symbol: "rust-analyzer cargo mini 0.1.0 shape/impl#[Tally][Clone]clone().",
  package: "mini",
  inProject: false,
  name: "clone",
  kind: "callable",
  implTrait: "Clone",
  packageInProject: true,
};

function def(
  relPath: string,
  shortName: string,
  symbolId: string,
  startLine: number,
  endLine: number,
  symbolKind: SymbolDefinitionKind = "method",
): SymbolDefinition {
  return { symbolId, fqName: symbolId, shortName, relPath, scope: [], startLine, endLine, symbolKind };
}

function table(...defs: SymbolDefinition[]): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  const byFile = new Map<string, SymbolDefinition[]>();
  for (const d of defs) byFile.set(d.relPath, [...(byFile.get(d.relPath) ?? []), d]);
  for (const [relPath, list] of byFile) t.upsertFile(relPath, list);
  return t;
}

function ctxWith(t: InMemoryGlobalSymbolTable, index?: RustAnalyzerScipIndex): CallContext {
  return {
    callerFile: CALLER,
    callerScope: [],
    imports: [],
    symbolTable: t,
    projectRoot: ROOT,
    ...(index === undefined ? {} : { languageConfig: new RustResolveEnvironment(undefined, undefined, index) }),
  };
}

function call(callText: string, receiver: string | null, member: string, line: number, col: number): CallRef {
  return { callText, receiver, member, startLine: line, startColumn: 4, memberStartLine: line, memberStartColumn: col };
}

const strategy = new RustAnalyzerScipSymbolResolutionStrategy({ mode: "strict" });

describe("RustAnalyzerScipSymbolResolutionStrategy (bd s3i8m.6 R3a)", () => {
  it("answers an in-project callable with the narrowest table symbol containing the definition line", () => {
    const t = table(
      def("src/shape.rs", "bump", "Counter#bump", 6, 8),
      def("src/shape.rs", "bump", "outer::bump", 1, 20, "function"),
      def("src/other.rs", "bump", "Other#bump", 6, 8),
    );
    const index = stubIndex({ "src/main.rs:7:12": inProject("bump", "src/shape.rs", 6) });

    expect(strategy.attempt(call("counter.bump(2)", "counter", "bump", 7, 12), ctxWith(t, index))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/shape.rs", targetSymbolId: "Counter#bump" },
    });
  });

  it("maps by the descriptor name, not the call's member, under a use-as alias", () => {
    const t = table(def("src/shape.rs", "bump_free", "bump_free", 20, 22, "function"));
    const index = stubIndex({ "src/main.rs:25:4": inProject("bump_free", "src/shape.rs", 20) });

    expect(strategy.attempt(call("bf(2)", null, "bf", 25, 4), ctxWith(t, index))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/shape.rs", targetSymbolId: "bump_free" },
    });
  });

  it("maps a macro invocation through the macro namespace only", () => {
    const t = table(
      def("src/main.rs", "twice", "twice", 13, 17, "macro"),
      def("src/main.rs", "twice", "twice_fn", 13, 30, "function"),
    );
    const index = stubIndex({ "src/main.rs:26:4": inProject("twice", "src/main.rs", 13, "macro") });

    expect(strategy.attempt(call("twice!()", null, "twice", 26, 4), ctxWith(t, index))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/main.rs", targetSymbolId: "twice" },
    });
  });

  it("CONTINUEs without an index, a member position, or an answer", () => {
    const t = table(def("src/shape.rs", "bump", "Counter#bump", 6, 8));
    const index = stubIndex({ "src/main.rs:7:12": inProject("bump", "src/shape.rs", 6) });
    const positioned = call("counter.bump(2)", "counter", "bump", 7, 12);
    const { memberStartLine: _l, memberStartColumn: _c, ...unpositioned } = positioned;

    expect(strategy.attempt(positioned, ctxWith(t))).toEqual({ kind: "continue" });
    expect(strategy.attempt(unpositioned, ctxWith(t, index))).toEqual({ kind: "continue" });
    expect(strategy.attempt(call("counter.bump(2)", "counter", "bump", 7, 13), ctxWith(t, index))).toEqual({
      kind: "continue",
    });
  });

  it("CONTINUEs on a local, a type, or an in-project definition no table symbol contains", () => {
    const t = table(
      def("src/shape.rs", "Boxed", "Wrap::Boxed", 17, 17, "class"),
      def("src/shape.rs", "bump", "Counter#bump", 6, 8),
    );
    const index = stubIndex({
      "src/main.rs:24:4": { ...inProject("", "src/main.rs", 23, "local"), symbol: "local 3" },
      "src/main.rs:22:26": inProject("Boxed", "src/shape.rs", 17, "type"),
      "src/main.rs:9:6": inProject("bump", "src/shape.rs", 40),
    });
    const ctx = ctxWith(t, index);

    expect(strategy.attempt(call("f(1)", null, "f", 24, 4), ctx)).toEqual({ kind: "continue" });
    expect(strategy.attempt(call("shape::Wrap::Boxed(3)", "shape::Wrap", "Boxed", 22, 26), ctx)).toEqual({
      kind: "continue",
    });
    expect(strategy.attempt(call("x.bump()", "x", "bump", 9, 6), ctx)).toEqual({ kind: "continue" });
  });

  it("DROPs a std/dependency answer and a derive-generated workspace impl", () => {
    const index = stubIndex({ "src/main.rs:9:6": STD_PUSH, "src/main.rs:21:20": DERIVED_CLONE });
    const ctx = ctxWith(table(), index);

    expect(strategy.attempt(call("v.push(1)", "v", "push", 9, 6), ctx)).toEqual({ kind: "drop" });
    expect(strategy.attempt(call("tally.clone()", "tally", "clone", 21, 20), ctx)).toEqual({ kind: "drop" });
  });

  it("CONTINUEs on a workspace symbol with no definition whose trait is not derivable", () => {
    const index = stubIndex({
      "src/main.rs:27:6": { ...DERIVED_CLONE, name: "greet", implTrait: "Greeter" },
      "src/main.rs:28:6": { ...DERIVED_CLONE, name: "greet", implTrait: undefined },
    });
    const ctx = ctxWith(table(), index);

    expect(strategy.attempt(call("g.greet()", "g", "greet", 27, 6), ctx)).toEqual({ kind: "continue" });
    expect(strategy.attempt(call("g.greet()", "g", "greet", 28, 6), ctx)).toEqual({ kind: "continue" });
  });
});

describe("RustCallResolver chain position of the SCIP slot (bd s3i8m.6 R3a)", () => {
  async function warmedResolver(index: RustAnalyzerScipIndex): Promise<RustCallResolver> {
    const source: RustAnalyzerScipSource = {
      acquire: async () => ({ kind: "indexed", index, cacheHit: true, toolchainSkew: false }),
    };
    const resolver = new RustCallResolver(undefined, undefined, undefined, source);
    await resolver.warmResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
    return resolver;
  }

  it("runs last, after traitSelfMethod", () => {
    expect(new RustCallResolver().strategies.map((pass) => pass.name).slice(-2)).toEqual([
      "traitSelfMethod",
      "rustAnalyzerScip",
    ]);
  });

  it("answers a site every earlier pass CONTINUEd on", async () => {
    const t = table(def("src/shape.rs", "bump", "Counter#bump", 6, 8), def("src/b.rs", "bump", "B#bump", 1, 3));
    const resolver = await warmedResolver(stubIndex({ "src/main.rs:7:12": inProject("bump", "src/shape.rs", 6) }));

    expect(resolver.resolve(call("counter.bump(2)", "counter", "bump", 7, 12), ctxWith(t))).toEqual({
      targetRelPath: "src/shape.rs",
      targetSymbolId: "Counter#bump",
    });
  });

  it("never asks the index for a site an earlier pass resolved or DROPped", async () => {
    const t = table(def("src/util.rs", "helper", "helper", 1, 1, "function"));
    const index = stubIndex({});
    const resolver = await warmedResolver(index);

    expect(resolver.resolve(call("helper()", null, "helper", 4, 4), ctxWith(t))?.targetSymbolId).toBe("helper");
    expect(resolver.resolve(call("nothere!()", null, "nothere", 5, 4), ctxWith(t))).toBeNull();
    expect(index.asked).toEqual([]);
  });
});

describe("RustCallResolver#targetsExternalImport with SCIP (bd s3i8m.6 R3a)", () => {
  const SITES = { "src/main.rs:9:6": STD_PUSH, "src/main.rs:10:6": { ...STD_PUSH, name: "frobnicate" } };

  async function facade(index?: RustAnalyzerScipIndex): Promise<LanguageSymbolResolver> {
    const source: RustAnalyzerScipSource | undefined =
      index === undefined
        ? undefined
        : { acquire: async () => ({ kind: "indexed", index, cacheHit: true, toolchainSkew: false }) };
    const resolver = new LanguageFactory(source === undefined ? {} : { rustAnalyzerScipSource: source }).create(
      "rust",
    ).resolver!;
    await resolver.warmResolvePass?.({ expectedFileCount: 1, projectRoot: ROOT });
    return resolver;
  }

  const namesake = () => table(def("src/stack.rs", "push", "Stack#push", 1, 3));

  it("is true on a SCIP-external site whose member has a project namesake", async () => {
    const site = call("v.push(1)", "v", "push", 9, 6);
    expect((await facade(stubIndex(SITES))).targetsExternalImport?.(site, ctxWith(namesake()))).toBe(true);
    expect((await facade()).targetsExternalImport?.(site, ctxWith(namesake()))).toBe(false);
  });

  it("is false on a SCIP-external site with no namesake — the row stays noInProjectDef", async () => {
    const site = call("v.frobnicate()", "v", "frobnicate", 10, 6);
    expect((await facade(stubIndex(SITES))).targetsExternalImport?.(site, ctxWith(table()))).toBe(false);
  });

  it("leaves the vocabulary's verdicts unchanged", async () => {
    const site = call("10.into()", "10", "into", 11, 7);
    expect((await facade(stubIndex(SITES))).targetsExternalImport?.(site, ctxWith(table()))).toBe(true);
  });

  it("moves only missWithInProjectDef rows: noInProjectDef and externalSkipped are identical", async () => {
    const t = namesake();
    const sites = [
      call("v.push(1)", "v", "push", 9, 6),
      call("v.frobnicate()", "v", "frobnicate", 10, 6),
      call("10.into()", "10", "into", 11, 7),
      call("w.push(2)", "w", "push", 12, 6),
    ];
    const bucketsOf = async (index?: RustAnalyzerScipIndex) => {
      const resolver = await facade(index);
      return sites.map((site) => classifyResolveMiss(site, ctxWith(t), resolver, t));
    };

    expect(await bucketsOf()).toEqual([
      "missWithInProjectDef",
      "noInProjectDef",
      "externalSkipped",
      "missWithInProjectDef",
    ]);
    expect(await bucketsOf(stubIndex(SITES))).toEqual([
      "externalSkipped",
      "noInProjectDef",
      "externalSkipped",
      "missWithInProjectDef",
    ]);
  });
});
