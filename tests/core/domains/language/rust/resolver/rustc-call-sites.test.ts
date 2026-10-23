/**
 * The rustc call-site driver as a Rust resolution source (bd s3i8m T6 + T7;
 * research/rustc-driver/SPEC.md §3, §8.5): the `RustCallSiteIndex` port reaches
 * the chain through the resolve environment (`rustcCallSitesOf`), the
 * `rustcCallSites` slot answers BEFORE the SCIP slot, and the miss classifier's
 * external gate reads the driver first, then SCIP — the same R3b/R3c/R3d rules
 * over either source. A derived impl is no project edge and no external call:
 * the row lands in `noInProjectDef`.
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
  RustCallSiteDefinition,
  RustCallSiteIndex,
  RustCallSiteSource,
  RustScipDefinition,
} from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import {
  rustAnalyzerScipOf,
  rustcCallSitesOf,
  RustResolveEnvironment,
} from "../../../../../../src/core/domains/language/rust/resolver/resolve-environment.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import { RustcCallSiteSymbolResolutionStrategy } from "../../../../../../src/core/domains/language/rust/resolver/strategies/index.js";
import { classifyResolveMiss } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ROOT = "/repo";
const CALLER = "src/main.rs";

/** A stub index answering `${relPath}:${line}:${col}` keys; records every question. */
function stubIndex<D extends RustScipDefinition>(answers: Record<string, D>) {
  const asked: string[] = [];
  return {
    identity: "stub",
    asked,
    definitionAt: (relPath: string, line: number, utf16Col: number): D | null => {
      const key = `${relPath}:${line}:${utf16Col}`;
      asked.push(key);
      return answers[key] ?? null;
    },
  };
}

function inProject(
  name: string,
  relPath: string,
  line: number,
  kind: RustScipDefinition["kind"] = "callable",
): RustCallSiteDefinition {
  return {
    symbol: `rustc mini ${name}`,
    package: "mini",
    inProject: true,
    relPath,
    line,
    name,
    kind,
    packageInProject: true,
  };
}

const STD_PUSH: RustCallSiteDefinition = {
  symbol: "rustc alloc std::vec::Vec::<T, A>::push",
  package: "alloc",
  inProject: false,
  name: "push",
  kind: "callable",
  packageInProject: false,
};

/** `#[derive(Clone)]`'s impl, as the decoder maps it (§3) plus the T6 marker. */
const DERIVED_CLONE: RustCallSiteDefinition = {
  symbol: "rustc mini <shape::Tally as std::clone::Clone>::clone",
  package: "mini",
  inProject: false,
  name: "clone",
  kind: "callable",
  implTrait: "Clone",
  packageInProject: true,
  implIsDerived: true,
};

function stdTraitMember(trait: string, member: string): RustCallSiteDefinition {
  return {
    symbol: `rustc core std::convert::${trait}::${member}`,
    package: "core",
    inProject: false,
    name: member,
    kind: "callable",
    declaringTrait: trait,
    packageInProject: false,
  };
}

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
  sources: { callSites?: RustCallSiteIndex; scip?: RustAnalyzerScipIndex } = {},
  typeDeclarations?: Record<string, TypeDeclarationFact[]>,
): CallContext {
  const environment =
    sources.callSites === undefined && sources.scip === undefined
      ? undefined
      : new RustResolveEnvironment(undefined, undefined, sources.scip, sources.callSites);
  return {
    callerFile: CALLER,
    callerScope: [],
    imports: [],
    symbolTable: t,
    projectRoot: ROOT,
    ...(environment === undefined ? {} : { languageConfig: environment }),
    ...(typeDeclarations === undefined ? {} : { typeDeclarations }),
  };
}

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

function call(callText: string, receiver: string | null, member: string, line: number, col: number): CallRef {
  return { callText, receiver, member, startLine: line, startColumn: 4, memberStartLine: line, memberStartColumn: col };
}

function callSiteSource(index: RustCallSiteIndex): RustCallSiteSource {
  return { acquire: async () => ({ kind: "indexed", index, cacheHit: true }) };
}

function scipSource(index: RustAnalyzerScipIndex): RustAnalyzerScipSource {
  return { acquire: async () => ({ kind: "indexed", index, cacheHit: true, toolchainSkew: false }) };
}

async function warmedResolver(
  sources: { callSites?: RustCallSiteIndex; scip?: RustAnalyzerScipIndex } = {},
): Promise<RustCallResolver> {
  const resolver = new RustCallResolver(
    undefined,
    undefined,
    undefined,
    sources.scip === undefined ? undefined : scipSource(sources.scip),
    sources.callSites === undefined ? undefined : callSiteSource(sources.callSites),
  );
  await resolver.warmResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
  return resolver;
}

async function facade(
  sources: { callSites?: RustCallSiteIndex; scip?: RustAnalyzerScipIndex } = {},
): Promise<LanguageSymbolResolver> {
  const resolver = new LanguageFactory({
    ...(sources.scip === undefined ? {} : { rustAnalyzerScipSource: scipSource(sources.scip) }),
    ...(sources.callSites === undefined ? {} : { rustcCallSiteSource: callSiteSource(sources.callSites) }),
  }).create("rust").resolver!;
  await resolver.warmResolvePass?.({ expectedFileCount: 1, projectRoot: ROOT });
  return resolver;
}

const strategy = new RustcCallSiteSymbolResolutionStrategy({ mode: "strict" });

describe("rustcCallSitesOf — the resolve environment carries the driver index (bd s3i8m T6)", () => {
  it("reads the driver index beside the SCIP index, and nothing off the Rust entry paths", () => {
    const callSites = stubIndex({});
    const scip = stubIndex({});
    const ctx = ctxWith(table(), { callSites, scip });
    expect(rustcCallSitesOf(ctx)).toBe(callSites);
    expect(rustAnalyzerScipOf(ctx)).toBe(scip);
    expect(rustcCallSitesOf(ctxWith(table()))).toBeUndefined();
  });

  it("acquires the index through the injected source before the pass and reports how it settled", async () => {
    const t = table(def("src/shape.rs", "bump", "Counter#bump", 6, 8), def("src/b.rs", "bump", "B#bump", 1, 3));
    const resolver = await warmedResolver({
      callSites: stubIndex({ "src/main.rs:7:12": inProject("bump", "src/shape.rs", 6) }),
    });
    expect(resolver.resolve(call("counter.bump(2)", "counter", "bump", 7, 12), ctxWith(t))?.targetSymbolId).toBe(
      "Counter#bump",
    );
    expect(resolver.diagnostics()).toEqual({ rustcCallSites: { outcome: "indexed", cacheHit: true } });
  });

  it("reports a latched acquisition and serves no index", async () => {
    const resolver = new RustCallResolver(undefined, undefined, undefined, undefined, {
      acquire: async () => ({ kind: "latched", reason: "build", detail: "crate fx failed" }),
    });
    await resolver.warmResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
    expect(resolver.diagnostics()).toEqual({ rustcCallSites: { outcome: "latched", reason: "build" } });
  });
});

describe("RustcCallSiteSymbolResolutionStrategy (bd s3i8m T7)", () => {
  it("answers an in-project callable with the narrowest table symbol containing the definition line", () => {
    const t = table(
      def("src/shape.rs", "bump", "Counter#bump", 6, 8),
      def("src/shape.rs", "bump", "outer::bump", 1, 20, "function"),
    );
    const callSites = stubIndex({ "src/main.rs:7:12": inProject("bump", "src/shape.rs", 6) });
    expect(strategy.attempt(call("counter.bump(2)", "counter", "bump", 7, 12), ctxWith(t, { callSites }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/shape.rs", targetSymbolId: "Counter#bump" },
    });
  });

  it("DROPs a provably external target", () => {
    const callSites = stubIndex({ "src/main.rs:9:6": STD_PUSH });
    expect(strategy.attempt(call("v.push(1)", "v", "push", 9, 6), ctxWith(table(), { callSites }))).toEqual({
      kind: "drop",
    });
  });

  it("DROPs a derived impl: the driver proved no project edge exists", () => {
    const t = table(def("src/shape.rs", "clone", "Shape#clone", 3, 5));
    const callSites = stubIndex({ "src/main.rs:12:8": DERIVED_CLONE });
    expect(strategy.attempt(call("t.clone()", "t", "clone", 12, 8), ctxWith(t, { callSites }))).toEqual({
      kind: "drop",
    });
  });

  it("CONTINUEs without a driver index, a member position, or a row — reading only the driver", () => {
    const scip = stubIndex({ "src/main.rs:9:6": STD_PUSH });
    const site = call("v.push(1)", "v", "push", 9, 6);
    expect(strategy.attempt(site, ctxWith(table(), { scip }))).toEqual({ kind: "continue" });
    expect(strategy.attempt(site, ctxWith(table(), { callSites: stubIndex({}) }))).toEqual({ kind: "continue" });
    const noPosition: CallRef = { callText: "v.push(1)", receiver: "v", member: "push", startLine: 9, startColumn: 4 };
    expect(strategy.attempt(noPosition, ctxWith(table(), { callSites: stubIndex({}) }))).toEqual({
      kind: "continue",
    });
    expect(scip.asked).toEqual([]);
  });

  it("CONTINUEs on an in-project definition no table symbol contains", () => {
    const callSites = stubIndex({ "src/main.rs:7:12": inProject("bump", "src/gone.rs", 40) });
    expect(
      strategy.attempt(call("counter.bump(2)", "counter", "bump", 7, 12), ctxWith(table(), { callSites })),
    ).toEqual({ kind: "continue" });
  });

  it("applies R3d to a driver answer: a std path receiver no project impl targets DROPs, a targeted one CONTINUEs", () => {
    const callSites = stubIndex({
      "src/main.rs:41:18": stdTraitMember("From", "from"),
      "src/main.rs:42:13": stdTraitMember("From", "from"),
    });
    const domString = table(def("src/domstring.rs", "from", "DOMString.from", 11, 13));
    const domImpl = { "src/domstring.rs": [traitImpl("DOMString", "From", 10, 14)] };
    expect(
      strategy.attempt(call("usize::from(byte)", "usize", "from", 41, 18), ctxWith(domString, { callSites }, domImpl)),
    ).toEqual({ kind: "drop" });
    const stringImpl = table(def("src/conv.rs", "from", "String.from", 21, 23));
    const impls = { "src/conv.rs": [traitImpl("String", "From", 20, 24)] };
    expect(
      strategy.attempt(call("String::from(x)", "String", "from", 42, 13), ctxWith(stringImpl, { callSites }, impls)),
    ).toEqual({ kind: "continue" });
  });
});

describe("RustCallResolver chain position of the driver slot (bd s3i8m T7)", () => {
  it("sits after every name pass, directly before the SCIP slot", () => {
    expect(new RustCallResolver().strategies.map((pass) => pass.name).slice(-3)).toEqual([
      "traitSelfMethod",
      "rustcCallSites",
      "rustAnalyzerScip",
    ]);
  });

  it("still reaches SCIP when the driver has no row", async () => {
    const t = table(def("src/shape.rs", "bump", "Counter#bump", 6, 8), def("src/b.rs", "bump", "B#bump", 1, 3));
    const callSites = stubIndex({});
    const resolver = await warmedResolver({
      callSites,
      scip: stubIndex({ "src/main.rs:7:12": inProject("bump", "src/shape.rs", 6) }),
    });
    expect(resolver.resolve(call("counter.bump(2)", "counter", "bump", 7, 12), ctxWith(t))?.targetSymbolId).toBe(
      "Counter#bump",
    );
    expect(callSites.asked).toEqual(["src/main.rs:7:12"]);
  });

  it("answers before SCIP where both answer", async () => {
    const t = table(def("src/shape.rs", "bump", "Counter#bump", 6, 8), def("src/b.rs", "bump", "B#bump", 1, 3));
    const scip = stubIndex({ "src/main.rs:7:12": inProject("bump", "src/b.rs", 1) });
    const resolver = await warmedResolver({
      callSites: stubIndex({ "src/main.rs:7:12": inProject("bump", "src/shape.rs", 6) }),
      scip,
    });
    expect(resolver.resolve(call("counter.bump(2)", "counter", "bump", 7, 12), ctxWith(t))?.targetSymbolId).toBe(
      "Counter#bump",
    );
    expect(scip.asked).toEqual([]);
  });

  it("never asks SCIP after the driver DROPs a derived impl", async () => {
    const t = table(def("src/shape.rs", "clone", "Shape#clone", 3, 5), def("src/b.rs", "clone", "B#clone", 1, 3));
    const scip = stubIndex({ "src/main.rs:12:8": inProject("clone", "src/shape.rs", 3) });
    const resolver = await warmedResolver({ callSites: stubIndex({ "src/main.rs:12:8": DERIVED_CLONE }), scip });
    expect(resolver.resolve(call("t.clone()", "t", "clone", 12, 8), ctxWith(t))).toBeNull();
    expect(scip.asked).toEqual([]);
  });
});

describe("the miss classifier's external gate reads the driver, then SCIP (bd s3i8m T7)", () => {
  const namesake = () => table(def("src/stack.rs", "push", "Stack#push", 1, 3));
  const pushSite = call("v.push(1)", "v", "push", 9, 6);

  it("is true on a driver-external site whose member has a project namesake", async () => {
    const callSites = stubIndex({ "src/main.rs:9:6": STD_PUSH });
    expect((await facade({ callSites })).targetsExternalImport?.(pushSite, ctxWith(namesake()))).toBe(true);
  });

  it("lets the driver win over SCIP when they disagree", async () => {
    const driverInProject = stubIndex({ "src/main.rs:9:6": inProject("push", "src/stack.rs", 1) });
    const scipExternal = stubIndex({ "src/main.rs:9:6": STD_PUSH });
    expect(
      (await facade({ callSites: driverInProject, scip: scipExternal })).targetsExternalImport?.(
        pushSite,
        ctxWith(namesake()),
      ),
    ).toBe(false);

    const driverExternal = stubIndex({ "src/main.rs:9:6": STD_PUSH });
    const scipInProject = stubIndex({ "src/main.rs:9:6": inProject("push", "src/stack.rs", 1) });
    expect(
      (await facade({ callSites: driverExternal, scip: scipInProject })).targetsExternalImport?.(
        pushSite,
        ctxWith(namesake()),
      ),
    ).toBe(true);
  });

  it("falls back to SCIP where the driver has no row", async () => {
    const scip = stubIndex({ "src/main.rs:9:6": STD_PUSH });
    expect(
      (await facade({ callSites: stubIndex({}), scip })).targetsExternalImport?.(pushSite, ctxWith(namesake())),
    ).toBe(true);
  });

  it("applies R3c to a driver answer: a project impl of the trait keeps the site in the denominator", async () => {
    const callSites = stubIndex({ "src/main.rs:30:9": stdTraitMember("Display", "fmt") });
    const t = table(def("src/shape.rs", "fmt", "Shape.fmt", 3, 5));
    const impls = { "src/shape.rs": [traitImpl("Shape", "Display", 2, 6)] };
    expect(
      (await facade({ callSites })).targetsExternalImport?.(call("s.fmt(f)", "s", "fmt", 30, 9), ctxWith(t, {}, impls)),
    ).toBe(false);
  });

  it("buckets a derived impl as noInProjectDef — never external, never a miss — even against SCIP", async () => {
    const t = table(def("src/shape.rs", "clone", "Shape#clone", 3, 5));
    const site = call("t.clone()", "t", "clone", 12, 8);
    const scipDerived = stubIndex({
      "src/main.rs:12:8": { ...DERIVED_CLONE, implIsDerived: undefined } as RustScipDefinition,
    });
    const resolver = await facade({ callSites: stubIndex({ "src/main.rs:12:8": DERIVED_CLONE }), scip: scipDerived });
    expect(resolver.targetsExternalImport?.(site, ctxWith(t))).toBe(false);
    expect(resolver.hasInProjectDefinition?.(site, ctxWith(t))).toBe(false);
    expect(classifyResolveMiss(site, ctxWith(t), resolver, t)).toBe("noInProjectDef");
  });

  it("applies R3b to a driver answer: an in-project constructor is no namesake's edge", async () => {
    const t = table(def("src/shape.rs", "Boxed", "Other#Boxed", 30, 32));
    const resolver = await warmedResolver({
      callSites: stubIndex({ "src/main.rs:22:26": inProject("Boxed", "src/shape.rs", 17, "type") }),
    });
    expect(
      resolver.hasInProjectDefinition(call("shape::Wrap::Boxed(3)", "shape::Wrap", "Boxed", 22, 26), ctxWith(t)),
    ).toBe(false);
  });

  it("keeps every bucket byte-identical without a driver index", async () => {
    const t = namesake();
    const sites = [pushSite, call("v.frobnicate()", "v", "frobnicate", 10, 6), call("10.into()", "10", "into", 11, 7)];
    const resolver = await facade();
    expect(sites.map((site) => classifyResolveMiss(site, ctxWith(t), resolver, t))).toEqual([
      "missWithInProjectDef",
      "noInProjectDef",
      "externalSkipped",
    ]);
  });
});
