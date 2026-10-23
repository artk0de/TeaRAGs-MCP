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
  TypeDeclarationFact,
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

function ctxWith(
  t: InMemoryGlobalSymbolTable,
  index?: RustAnalyzerScipIndex,
  typeDeclarations?: Record<string, TypeDeclarationFact[]>,
): CallContext {
  return {
    callerFile: CALLER,
    callerScope: [],
    imports: [],
    symbolTable: t,
    projectRoot: ROOT,
    ...(index === undefined ? {} : { languageConfig: new RustResolveEnvironment(undefined, undefined, index) }),
    ...(typeDeclarations === undefined ? {} : { typeDeclarations }),
  };
}

/** `impl <trait> for <typeId>` spanning `startLine..endLine` — the walker's re-opening fact. */
function traitImpl(typeId: string, trait: string, startLine: number, endLine: number): TypeDeclarationFact {
  return {
    typeId,
    symbolKind: "class",
    line: startLine,
    reopens: true,
    conforms: [trait],
    selfConstraints: { types: [], startLine, endLine },
  };
}

/** SCIP's answer for a std trait DECLARATION member (`convert/From#from().`) — the trait, not an impl. */
function stdTraitMember(trait: string, member: string): RustScipDefinition {
  return {
    symbol: `rust-analyzer cargo core 1.88.0 convert/${trait}#${member}().`,
    package: "core",
    inProject: false,
    name: member,
    kind: "callable",
    declaringTrait: trait,
    packageInProject: false,
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

describe("SCIP trait-declaration members prove external only without a project impl (bd s3i8m.6 R3c)", () => {
  const FROM_SITE = "src/main.rs:31:14";
  const MAP_SITE = "src/main.rs:32:9";
  const index = () =>
    stubIndex({ [FROM_SITE]: stdTraitMember("From", "from"), [MAP_SITE]: stdTraitMember("Iterator", "map") });
  const fromSite = call("DOMString::from(x)", "DOMString", "from", 31, 14);
  const mapSite = call("iter.map(f)", "iter", "map", 32, 9);
  const domString = () => table(def("src/domstring.rs", "from", "DOMString.from", 11, 13));
  const domStringImpl = { "src/domstring.rs": [traitImpl("DOMString", "From", 10, 14)] };

  it("CONTINUEs when a project impl of the trait declares the member", () => {
    expect(strategy.attempt(fromSite, ctxWith(domString(), index(), domStringImpl))).toEqual({ kind: "continue" });
  });

  it("DROPs when no project impl of the trait declares the member", () => {
    expect(strategy.attempt(fromSite, ctxWith(table(), index(), {}))).toEqual({ kind: "drop" });
    // The namesake sits outside every `impl From for _` span — an inherent `from` proves nothing.
    expect(
      strategy.attempt(
        fromSite,
        ctxWith(domString(), index(), { "src/domstring.rs": [traitImpl("DOMString", "From", 20, 24)] }),
      ),
    ).toEqual({
      kind: "drop",
    });
    // An impl of ANOTHER trait declaring `from` is no impl of `From`.
    expect(
      strategy.attempt(
        fromSite,
        ctxWith(domString(), index(), { "src/domstring.rs": [traitImpl("DOMString", "Into", 10, 14)] }),
      ),
    ).toEqual({
      kind: "drop",
    });
  });

  it("DROPs a provided trait method no project impl declares", () => {
    const counter = table(def("src/counter.rs", "next", "Counter.next", 3, 5));
    const iteratorImpl = { "src/counter.rs": [traitImpl("Counter", "Iterator", 2, 6)] };
    expect(strategy.attempt(mapSite, ctxWith(counter, index(), iteratorImpl))).toEqual({ kind: "drop" });
  });

  it("keeps the site in the denominator: targetsExternalImport is false on a project impl", async () => {
    const source: RustAnalyzerScipSource = {
      acquire: async () => ({ kind: "indexed", index: index(), cacheHit: true, toolchainSkew: false }),
    };
    const resolver = new LanguageFactory({ rustAnalyzerScipSource: source }).create("rust").resolver!;
    await resolver.warmResolvePass?.({ expectedFileCount: 1, projectRoot: ROOT });
    expect(resolver.targetsExternalImport?.(fromSite, ctxWith(domString(), undefined, domStringImpl))).toBe(false);
    expect(resolver.targetsExternalImport?.(fromSite, ctxWith(domString(), undefined, {}))).toBe(true);
  });
});

describe("SCIP trait-declaration members on a proven external receiver (bd s3i8m.6 R3d)", () => {
  const PATH_SITE = "src/main.rs:41:18";
  const STRING_SITE = "src/main.rs:42:13";
  const TURBOFISH_SITE = "src/main.rs:43:20";
  const CLONE_SITE = "src/main.rs:44:12";
  const index = () =>
    stubIndex({
      [PATH_SITE]: stdTraitMember("From", "from"),
      [STRING_SITE]: stdTraitMember("From", "from"),
      [TURBOFISH_SITE]: stdTraitMember("From", "from"),
      [CLONE_SITE]: stdTraitMember("Clone", "clone"),
    });
  const usizeFrom = call("usize::from(byte)", "usize", "from", 41, 18);
  const stringFrom = call("String::from(x)", "String", "from", 42, 13);
  const vecFrom = call("Vec::<u8>::from(x)", "Vec::<u8>", "from", 43, 20);
  const txClone = call("tx.clone()", "tx", "clone", 44, 12);
  const domString = () => table(def("src/domstring.rs", "from", "DOMString.from", 11, 13));
  const domStringImpl = { "src/domstring.rs": [traitImpl("DOMString", "From", 10, 14)] };
  const withBindings = (ctx: CallContext, bindings: CallContext["localBindings"]): CallContext => ({
    ...ctx,
    localBindings: bindings,
  });

  it("DROPs a std path receiver whose type no project impl of the trait targets", () => {
    expect(strategy.attempt(usizeFrom, ctxWith(domString(), index(), domStringImpl))).toEqual({ kind: "drop" });
    expect(strategy.attempt(stringFrom, ctxWith(domString(), index(), domStringImpl))).toEqual({ kind: "drop" });
    expect(strategy.attempt(vecFrom, ctxWith(domString(), index(), domStringImpl))).toEqual({ kind: "drop" });
  });

  it("CONTINUEs a std path receiver a project impl of the trait targets", () => {
    const stringImpl = table(def("src/conv.rs", "from", "String.from", 21, 23));
    const impls = { "src/conv.rs": [traitImpl("String", "From", 20, 24)] };
    expect(strategy.attempt(stringFrom, ctxWith(stringImpl, index(), impls))).toEqual({ kind: "continue" });
  });

  it("DROPs a receiver typed to a std type no project impl of the trait targets", () => {
    const shape = table(def("src/shape.rs", "clone", "Shape.clone", 3, 5));
    const cloneImpl = { "src/shape.rs": [traitImpl("Shape", "Clone", 2, 6)] };
    const ctx = withBindings(ctxWith(shape, index(), cloneImpl), {
      tx: [{ line: 40, type: "std::sync::mpsc::Sender" }],
    });
    expect(strategy.attempt(txClone, ctx)).toEqual({ kind: "drop" });
  });

  it("keeps R3c's rule when the path spells the trait, not the receiver type", () => {
    const ufcs = call("std::io::Write::write(&mut w, buf)", "std::io::Write", "write", 45, 25);
    const writer = table(def("src/sink.rs", "write", "Sink.write", 3, 5));
    const writeImpl = { "src/sink.rs": [traitImpl("Sink", "Write", 2, 6)] };
    const ufcsIndex = stubIndex({ "src/main.rs:45:25": stdTraitMember("Write", "write") });
    expect(strategy.attempt(ufcs, ctxWith(writer, ufcsIndex, writeImpl))).toEqual({ kind: "continue" });
  });

  it("keeps R3c's rule on an untyped receiver", () => {
    const shape = table(def("src/shape.rs", "clone", "Shape.clone", 3, 5));
    const cloneImpl = { "src/shape.rs": [traitImpl("Shape", "Clone", 2, 6)] };
    expect(strategy.attempt(txClone, ctxWith(shape, index(), cloneImpl))).toEqual({ kind: "continue" });
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

  // PIN-UPDATED (RESIDUAL R2): the rustc driver slot moved to the head of the chain.
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

describe("RustCallResolver#hasInProjectDefinition with SCIP (bd s3i8m.6 R3b)", () => {
  async function warmedResolver(index: RustAnalyzerScipIndex): Promise<RustCallResolver> {
    const source: RustAnalyzerScipSource = {
      acquire: async () => ({ kind: "indexed", index, cacheHit: true, toolchainSkew: false }),
    };
    const resolver = new RustCallResolver(undefined, undefined, undefined, source);
    await resolver.warmResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
    return resolver;
  }

  it("is false when SCIP proves the target an in-project type or local", async () => {
    const t = table(
      def("src/shape.rs", "Boxed", "Other#Boxed", 30, 32),
      def("src/util.rs", "f", "f", 1, 3, "function"),
    );
    const resolver = await warmedResolver(
      stubIndex({
        "src/main.rs:22:26": inProject("Boxed", "src/shape.rs", 17, "type"),
        "src/main.rs:24:4": { ...inProject("", "src/main.rs", 23, "local"), symbol: "local 3" },
      }),
    );

    expect(
      resolver.hasInProjectDefinition(call("shape::Wrap::Boxed(3)", "shape::Wrap", "Boxed", 22, 26), ctxWith(t)),
    ).toBe(false);
    expect(resolver.hasInProjectDefinition(call("f(1)", null, "f", 24, 4), ctxWith(t))).toBe(false);
  });

  it("keeps the table's answer for a callable, an external, no answer and no index", async () => {
    const t = table(def("src/stack.rs", "push", "Stack#push", 1, 3), def("src/util.rs", "f", "f", 1, 3, "function"));
    const resolver = await warmedResolver(
      stubIndex({ "src/main.rs:9:6": STD_PUSH, "src/main.rs:24:4": inProject("f", "src/util.rs", 1) }),
    );

    expect(resolver.hasInProjectDefinition(call("f(1)", null, "f", 24, 4), ctxWith(t))).toBe(true);
    expect(resolver.hasInProjectDefinition(call("v.push(1)", "v", "push", 9, 6), ctxWith(t))).toBe(true);
    expect(resolver.hasInProjectDefinition(call("v.push(1)", "v", "push", 40, 6), ctxWith(t))).toBe(true);
    expect(new RustCallResolver().hasInProjectDefinition(call("f(1)", null, "f", 24, 4), ctxWith(t))).toBe(true);
  });
});
