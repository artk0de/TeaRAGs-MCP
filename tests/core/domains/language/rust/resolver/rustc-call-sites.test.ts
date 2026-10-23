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
import { rustImplSelfTypeName } from "../../../../../../src/core/domains/language/rust/resolver/scip-resolution.js";
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
    expect(resolver.diagnostics()).toEqual({
      rustcCallSites: { outcome: "latched", reason: "build", detail: "crate fx failed" },
    });
  });

  it("forwards the run's units and failed crate targets for the status line (bd s3i8m T8)", async () => {
    const resolver = new RustCallResolver(undefined, undefined, undefined, undefined, {
      acquire: async () => ({
        kind: "indexed",
        index: stubIndex({}),
        cacheHit: false,
        wallMs: 9000,
        units: 12,
        failedCrates: ["fx_bench"],
      }),
    });
    await resolver.warmResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
    expect(resolver.diagnostics()).toEqual({
      rustcCallSites: { outcome: "indexed", cacheHit: false, wallMs: 9000, units: 12, failedCrates: ["fx_bench"] },
    });
  });

  it("keeps unavailable (with its install hint) apart from disabled (bd s3i8m T8)", async () => {
    const skipped = async (acquisition: { kind: "skipped"; reason: "unavailable" | "disabled"; hint?: string }) => {
      const resolver = new RustCallResolver(undefined, undefined, undefined, undefined, {
        acquire: async () => acquisition,
      });
      await resolver.warmResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
      return resolver.diagnostics();
    };
    expect(await skipped({ kind: "skipped", reason: "unavailable", hint: "rustup toolchain install …" })).toEqual({
      rustcCallSites: { outcome: "skipped", reason: "unavailable", hint: "rustup toolchain install …" },
    });
    expect(await skipped({ kind: "skipped", reason: "disabled" })).toEqual({
      rustcCallSites: { outcome: "skipped", reason: "disabled" },
    });
  });

  it("forwards a latch's hint", async () => {
    const resolver = new RustCallResolver(undefined, undefined, undefined, undefined, {
      acquire: async () => ({ kind: "latched", reason: "allUnitsFailed", detail: "E0463", hint: "cargo fetch" }),
    });
    await resolver.warmResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
    expect(resolver.diagnostics()).toEqual({
      rustcCallSites: { outcome: "latched", reason: "allUnitsFailed", detail: "E0463", hint: "cargo fetch" },
    });
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
  // PIN-UPDATED (RESIDUAL R2): the driver slot moved to the head of the chain;
  // SCIP stays the residual's slot after every name pass.
  it("keeps the SCIP slot after every name pass", () => {
    expect(new RustCallResolver().strategies.map((pass) => pass.name).slice(-2)).toEqual([
      "traitSelfMethod",
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

describe("macroInvocation rows through the driver slot (research/rustc-driver/RESIDUAL.md R3)", () => {
  /** `write!` as the decoder serves a `macroInvocation` row of `std::write`. */
  const STD_WRITE: RustCallSiteDefinition = {
    symbol: "rustc core std::write",
    package: "core",
    inProject: false,
    name: "write",
    kind: "macro",
    packageInProject: false,
  };
  const writeSite = call('write!(f, "x")', null, "write", 9, 4);

  it("resolves an in-project macro_rules invocation to the macro's table symbol", () => {
    const t = table(
      def("src/log.rs", "my_log", "my_log", 4, 8, "macro"),
      def("src/log.rs", "my_log", "Logger#my_log", 12, 14),
    );
    const callSites = stubIndex({ "src/main.rs:9:4": inProject("my_log", "src/log.rs", 4, "macro") });
    expect(strategy.attempt(call('my_log!("x")', null, "my_log", 9, 4), ctxWith(t, { callSites }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/log.rs", targetSymbolId: "my_log" },
    });
  });

  it("DROPs `write!(f, …)` as external although the project declares `fn write`", () => {
    const t = table(def("src/io.rs", "write", "Sink#write", 3, 6));
    const callSites = stubIndex({ "src/main.rs:9:4": STD_WRITE });
    expect(strategy.attempt(writeSite, ctxWith(t, { callSites }))).toEqual({ kind: "drop" });
  });

  it("moves a std macro whose name a project macro_rules shares out of the residual", async () => {
    const t = table(def("src/doc/help.rs", "write", "write", 19, 24, "macro"));
    const without = await facade();
    expect(classifyResolveMiss(writeSite, ctxWith(t), without, t)).toBe("missWithInProjectDef");
    const resolver = await facade({ callSites: stubIndex({ "src/main.rs:9:4": STD_WRITE }) });
    expect(resolver.resolve(writeSite, ctxWith(t))).toBeNull();
    expect(classifyResolveMiss(writeSite, ctxWith(t), resolver, t)).toBe("externalSkipped");
  });
});

describe("driver authority over the static chain (RESIDUAL R2)", () => {
  const OPTION_UNWRAP: RustCallSiteDefinition = {
    symbol: "rustc core core::option::Option::<T>::unwrap",
    package: "core",
    inProject: false,
    name: "unwrap",
    kind: "callable",
    packageInProject: false,
  };
  const PRELUDE_OK: RustCallSiteDefinition = {
    symbol: "rustc core std::prelude::v1::Ok",
    package: "core",
    inProject: false,
    name: "Ok",
    kind: "callable",
    packageInProject: false,
  };
  const resNamesake = () => table(def("src/decimal.rs", "unwrap", "Res#unwrap", 10, 14));
  const unwrapSite = call("x.unwrap()", "x", "unwrap", 9, 6);

  it("keeps today's static edge where the driver has no row", async () => {
    const resolver = await warmedResolver({ callSites: stubIndex({}) });
    expect(resolver.resolve(unwrapSite, ctxWith(resNamesake()))?.targetSymbolId).toBe("Res#unwrap");
  });

  it("drops the static namesake edge of `x.unwrap()` where the driver names core's Option::unwrap", async () => {
    const callSites = stubIndex({ "src/main.rs:9:6": OPTION_UNWRAP });
    const resolver = await facade({ callSites });
    const t = resNamesake();
    expect(resolver.resolve(unwrapSite, ctxWith(t))).toBeNull();
    expect(classifyResolveMiss(unwrapSite, ctxWith(t), resolver, t)).toBe("externalSkipped");
  });

  it("drops the static namesake edge of an `Ok(…)` bareCall where the driver names the prelude's Ok", async () => {
    const t = table(def("src/response.rs", "Ok", "Response#Ok", 4, 6));
    const okSite = call("Ok(v)", null, "Ok", 11, 4);
    expect((await warmedResolver({ callSites: stubIndex({}) })).resolve(okSite, ctxWith(t))?.targetSymbolId).toBe(
      "Response#Ok",
    );
    const resolver = await warmedResolver({ callSites: stubIndex({ "src/main.rs:11:4": PRELUDE_OK }) });
    expect(resolver.resolve(okSite, ctxWith(t))).toBeNull();
  });

  it("re-targets `self.m()` from the same-file static answer to the driver's inherent def in another file", async () => {
    const t = table(def(CALLER, "m", "Local#m", 3, 5), def("src/debug.rs", "m", "DebuggerImpl#m", 313, 320));
    const selfSite = call("self.m()", "self", "m", 20, 13);
    const scoped = (): CallContext => ({ ...ctxWith(t), callerScope: ["Local"] });
    expect((await warmedResolver({ callSites: stubIndex({}) })).resolve(selfSite, scoped())?.targetSymbolId).toBe(
      "Local#m",
    );
    const resolver = await warmedResolver({
      callSites: stubIndex({ "src/main.rs:20:13": inProject("m", "src/debug.rs", 313) }),
    });
    expect(resolver.resolve(selfSite, scoped())).toEqual({
      targetRelPath: "src/debug.rs",
      targetSymbolId: "DebuggerImpl#m",
    });
  });

  it("falls through to the static chain on an unmappable in-project row and counts the site once per pass", async () => {
    const callSites = stubIndex({ "src/main.rs:9:6": inProject("unwrap", "src/gone.rs", 40) });
    const resolver = await warmedResolver({ callSites });
    expect(resolver.resolve(unwrapSite, ctxWith(resNamesake()))?.targetSymbolId).toBe("Res#unwrap");
    resolver.resolve(unwrapSite, ctxWith(resNamesake()));
    expect(resolver.diagnostics()).toEqual({
      rustcCallSites: { outcome: "indexed", cacheHit: true, inProjectUnmapped: 1 },
    });
    resolver.prepareResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
    expect(resolver.diagnostics()).toEqual({ rustcCallSites: { outcome: "indexed", cacheHit: true } });
  });

  it("leaves a macro invocation to the macro pass unless the driver row is a macro row", async () => {
    const t = table(def("src/log.rs", "info", "info", 1, 9, "macro"));
    const macroSite = call("info!(x)", null, "info", 30, 4);
    const resolver = await warmedResolver({ callSites: stubIndex({ "src/main.rs:30:4": OPTION_UNWRAP }) });
    expect(resolver.resolve(macroSite, ctxWith(t))?.targetSymbolId).toBe("info");
  });

  describe("the trait cone yields to a decisive driver row", () => {
    const member = (symbolId: string, relPath: string, owner: string, line: number): SymbolDefinition => ({
      ...def(relPath, "run", symbolId, line, line + 2),
      scope: [owner],
    });
    const coneTable = () =>
      table(
        { ...def("src/runner.rs", "Runner", "Runner", 1, 5, "interface") },
        member("Runner#run", "src/runner.rs", "Runner", 2),
        { ...def("src/worker.rs", "Worker", "Worker", 1, 9, "class") },
        member("Worker#run", "src/worker.rs", "Worker", 3),
        { ...def("src/server.rs", "Server", "Server", 1, 9, "class") },
        member("Server#run", "src/server.rs", "Server", 3),
      );
    const runSite = call("runner.run()", "runner", "run", 9, 13);
    const coneCtx = (): CallContext => ({
      ...ctxWith(coneTable()),
      localBindings: { runner: [{ line: 1, type: "Runner" }] },
      hierarchy: {
        getAncestors: () => [],
        getDescendants: (ancestor: string) =>
          ancestor === "Runner"
            ? ["Worker", "Server"].map((sourceFqName) => ({
                sourceFqName,
                ancestorFqName: "Runner",
                ancestorSymbolId: null,
                kind: "implements" as const,
                depth: 1,
              }))
            : [],
      },
    });
    const fanned = async (answers: Record<string, RustCallSiteDefinition>) => {
      const outcome = (await warmedResolver({ callSites: stubIndex(answers) })).resolveDispatch(runSite, coneCtx());
      return outcome.kind === "edges" ? outcome.edges.map((edge) => edge.targetSymbolId) : outcome.kind;
    };

    it("keeps the cone without a row and where the driver names the trait's declaration", async () => {
      expect(await fanned({})).toEqual(["Worker#run", "Server#run"]);
      const traitDecl = { ...inProject("run", "src/runner.rs", 2), declaringTrait: "Runner" };
      expect(await fanned({ "src/main.rs:9:13": traitDecl })).toEqual(["Worker#run", "Server#run"]);
    });

    it("declines the cone where the driver names one concrete method or an external target", async () => {
      expect(await fanned({ "src/main.rs:9:13": inProject("run", "src/worker.rs", 3) })).toEqual([]);
      expect(await fanned({ "src/main.rs:9:13": { ...STD_PUSH, name: "run" } })).toEqual([]);
    });
  });

  it("answers ahead of every static pass", () => {
    expect(new RustCallResolver().strategies.map((pass) => pass.name).slice(0, 2)).toEqual([
      "rustcCallSites",
      "macroInvocation",
    ]);
  });
});

describe("local and indirect callee rows through the driver slot (research/rustc-driver/RESIDUAL.md R4)", () => {
  /** `insert(k, v)` where `insert` is a closure binding, as the decoder serves the driver's row. */
  const CLOSURE_INSERT: RustCallSiteDefinition = {
    symbol: "rustc local closure insert",
    package: "",
    inProject: false,
    name: "insert",
    kind: "local",
    packageInProject: false,
    indirectCallee: "closure",
  };
  /** A std callable at the same token: proof of a target, never of an undecidable one. */
  const STD_CALLABLE: RustCallSiteDefinition = {
    symbol: "rustc alloc std::collections::HashMap::insert",
    package: "alloc",
    inProject: false,
    name: "insert",
    kind: "callable",
    packageInProject: false,
  };
  const insertSite = call("insert(k, v)", null, "insert", 33, 4);
  const insertNamesake = (): InMemoryGlobalSymbolTable => table(def("src/map.rs", "insert", "insert", 5, 9));

  it("DROPs the static namesake edge of a closure call", async () => {
    const t = insertNamesake();
    expect((await warmedResolver({ callSites: stubIndex({}) })).resolve(insertSite, ctxWith(t))).not.toBeNull();
    const callSites = stubIndex({ "src/main.rs:33:4": CLOSURE_INSERT });
    expect(strategy.attempt(insertSite, ctxWith(t, { callSites }))).toEqual({ kind: "drop" });
    expect((await warmedResolver({ callSites })).resolve(insertSite, ctxWith(t))).toBeNull();
  });

  it("resolves a local binding of a fn item to the item's table symbol", () => {
    const t = table(def("src/ts.rs", "new", "TimeStamp.new", 3, 5));
    const callSites = stubIndex({ "src/main.rs:12:4": inProject("new", "src/ts.rs", 3) });
    expect(strategy.attempt(call("ts(42)", null, "ts", 12, 4), ctxWith(t, { callSites }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/ts.rs", targetSymbolId: "TimeStamp.new" },
    });
  });

  it("classifies a driver-proven indirect callee with a project namesake as unresolvable", async () => {
    const t = insertNamesake();
    expect(classifyResolveMiss(insertSite, ctxWith(t), await facade(), t)).toBe("missWithInProjectDef");
    const resolver = await facade({ callSites: stubIndex({ "src/main.rs:33:4": CLOSURE_INSERT }) });
    expect(resolver.targetsUndecidable?.(insertSite, ctxWith(t))).toBe(true);
    expect(classifyResolveMiss(insertSite, ctxWith(t), resolver, t)).toBe("unresolvable");
  });

  it("answers targetsUndecidable false without proof: no row, or a callable row", async () => {
    const t = insertNamesake();
    expect((await facade({ callSites: stubIndex({}) })).targetsUndecidable?.(insertSite, ctxWith(t))).toBe(false);
    const callable = await facade({ callSites: stubIndex({ "src/main.rs:33:4": STD_CALLABLE }) });
    expect(callable.targetsUndecidable?.(insertSite, ctxWith(t))).toBe(false);
  });

  it("counts the indirect callee sites once per pass", async () => {
    const resolver = await warmedResolver({ callSites: stubIndex({ "src/main.rs:33:4": CLOSURE_INSERT }) });
    resolver.resolve(insertSite, ctxWith(insertNamesake()));
    resolver.resolve(insertSite, ctxWith(insertNamesake()));
    expect(resolver.diagnostics()).toEqual({
      rustcCallSites: { outcome: "indexed", cacheHit: true, localCallee: 1 },
    });
    resolver.prepareResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
    expect(resolver.diagnostics()).toEqual({ rustcCallSites: { outcome: "indexed", cacheHit: true } });
  });
});

describe("a definition a macro GENERATED (format 4 defExpansion) never falls back to a namesake", () => {
  /** tikv `Error::from(err)` → `<errors::Error as From<grpcio::Error>>::from` @ the `#[derive(ThisError)]` line. */
  const DEPENDENCY_DERIVE_FROM: RustCallSiteDefinition = {
    ...inProject("from", "src/errors.rs", 21),
    implTrait: "From",
    defExpansion: { kind: "derive", macro: "Error", macroDefPath: "thiserror_impl::Error", macroInProject: false },
  };
  /** `BoxCmdObserver::new(…)` → a `pub fn new` inside the `macro_rules!` body at dispatcher.rs:224. */
  const PROJECT_MACRO_RULES_NEW: RustCallSiteDefinition = {
    ...inProject("new", "src/dispatcher.rs", 224),
    defExpansion: {
      kind: "bang",
      macro: "impl_box_observer",
      macroDefPath: "coprocessor::dispatcher::impl_box_observer",
      macroInProject: true,
      macroDefRelPath: "src/dispatcher.rs",
      macroDefLine: 200,
      macroDefName: "impl_box_observer",
    },
  };
  /** `flags.contains(…)` on a `bitflags!` struct: external body, workspace crate. */
  const DEPENDENCY_BITFLAGS_CONTAINS: RustCallSiteDefinition = {
    symbol: "rustc api_version ValueMeta::contains",
    package: "api_version",
    inProject: false,
    name: "contains",
    kind: "callable",
    packageInProject: true,
    defExpansion: { kind: "bang", macro: "bitflags", macroDefPath: "bitflags::bitflags", macroInProject: false },
  };
  /** `cfg.update(change)` → `<BackupStreamConfig as OnlineConfig>::update` @ `#[derive(…, OnlineConfig)]`. */
  const projectDerive = (macroDefLine: number): RustCallSiteDefinition => ({
    ...inProject("update", "src/config.rs", 3141),
    implTrait: "OnlineConfig",
    defExpansion: {
      kind: "derive",
      macro: "OnlineConfig",
      macroDefPath: "online_config_derive::OnlineConfig",
      macroInProject: true,
      macroDefRelPath: "derive/src/lib.rs",
      macroDefLine,
      macroDefName: "config",
    },
  });

  const namesakes = () =>
    table(
      def("src/other.rs", "from", "Other#from", 3, 5),
      def("src/other.rs", "new", "Other#new", 7, 9),
      def("src/other.rs", "contains", "Other#contains", 11, 13),
      def("src/other.rs", "update", "Other#update", 15, 17),
      def("src/dispatcher.rs", "impl_box_observer", "impl_box_observer", 200, 240, "macro"),
      def("derive/src/lib.rs", "config", "config", 5, 30, "function"),
    );
  const fromSite = call("Error::from(err)", "Error", "from", 5, 11);
  const newSite = call("BoxCmdObserver::new(o)", "BoxCmdObserver", "new", 6, 20);
  const containsSite = call("flags.contains(m)", "flags", "contains", 7, 10);
  const updateSite = call("cfg.update(change)", "cfg", "update", 8, 8);
  const callSites = stubIndex({
    "src/main.rs:5:11": DEPENDENCY_DERIVE_FROM,
    "src/main.rs:6:20": PROJECT_MACRO_RULES_NEW,
    "src/main.rs:7:10": DEPENDENCY_BITFLAGS_CONTAINS,
    "src/main.rs:8:8": projectDerive(5),
  });

  it("drops a dependency derive's `from` as external although the project declares a `from`", async () => {
    const resolver = await facade({ callSites });
    const t = namesakes();
    expect(strategy.attempt(fromSite, ctxWith(t, { callSites })).kind).toBe("drop");
    expect(resolver.resolve(fromSite, ctxWith(t))).toBeNull();
    expect(classifyResolveMiss(fromSite, ctxWith(t), resolver, t)).toBe("externalSkipped");
  });

  it("drops a dependency `macro_rules!` method (bitflags `contains`) although the project declares one", async () => {
    const resolver = await facade({ callSites });
    const t = namesakes();
    expect(resolver.resolve(containsSite, ctxWith(t))).toBeNull();
    expect(classifyResolveMiss(containsSite, ctxWith(t), resolver, t)).toBe("externalSkipped");
  });

  it("edges a project `macro_rules!`-generated `new` to the macro symbol", async () => {
    const resolver = await facade({ callSites });
    expect(resolver.resolve(newSite, ctxWith(namesakes()))).toEqual({
      targetRelPath: "src/dispatcher.rs",
      targetSymbolId: "impl_box_observer",
    });
  });

  it("edges a workspace proc-macro derive's method to the proc-macro function", async () => {
    const resolver = await facade({ callSites });
    expect(resolver.resolve(updateSite, ctxWith(namesakes()))).toEqual({
      targetRelPath: "derive/src/lib.rs",
      targetSymbolId: "config",
    });
  });

  it("edges a project-generated impl of a project trait to the trait's method declaration, not the macro", async () => {
    // tikv `function.create_state()` → `<AggrFnCount as AggrFunction>::create_state` @ `#[derive(AggrFunction)]`.
    const t = table(
      def("src/traits.rs", "ProjectTrait", "ProjectTrait", 1, 9, "interface"),
      def("src/traits.rs", "m", "ProjectTrait::m", 3, 3),
      def("src/other.rs", "m", "Other#m", 20, 22),
      def("derive/src/lib.rs", "config", "config", 5, 30, "function"),
    );
    const generatedImpl: RustCallSiteDefinition = {
      ...projectDerive(5),
      name: "m",
      implTrait: "ProjectTrait",
    };
    const resolver = await facade({ callSites: stubIndex({ "src/main.rs:9:6": generatedImpl }) });
    expect(resolver.resolve(call("x.m()", "x", "m", 9, 6), ctxWith(t))).toEqual({
      targetRelPath: "src/traits.rs",
      targetSymbolId: "ProjectTrait::m",
    });
  });

  it("drops a workspace proc-macro derive whose function does not map, with no namesake guess", async () => {
    const resolver = await facade({ callSites: stubIndex({ "src/main.rs:8:8": projectDerive(90) }) });
    expect(resolver.resolve(updateSite, ctxWith(namesakes()))).toBeNull();
  });

  it("still maps a hand-written in-project definition by its own name", async () => {
    const plain = stubIndex({ "src/main.rs:6:20": inProject("new", "src/other.rs", 7) });
    const resolver = await facade({ callSites: plain });
    expect(resolver.resolve(newSite, ctxWith(namesakes()))?.targetSymbolId).toBe("Other#new");
  });

  it("counts generated sites per pass, and the in-project ones whose macro symbol did not map", async () => {
    const counted = stubIndex({
      "src/main.rs:5:11": DEPENDENCY_DERIVE_FROM,
      "src/main.rs:6:20": PROJECT_MACRO_RULES_NEW,
      "src/main.rs:8:8": projectDerive(90),
    });
    const resolver = await warmedResolver({ callSites: counted });
    for (const site of [fromSite, newSite, updateSite, fromSite]) resolver.resolve(site, ctxWith(namesakes()));
    expect(resolver.diagnostics()).toEqual({
      rustcCallSites: { outcome: "indexed", cacheHit: true, generated: 3, generatedUnmapped: 1 },
    });
  });
});

describe("same-id windows (an inherent and a trait-impl method sharing one symbolId)", () => {
  // tikv `Either`: inherent `fn as_ref` (lines 3-6) and `impl AsRef<T> for Either { fn as_ref }`
  // (line 20) both compose `Either#as_ref`; the table keeps the id once, with the first window.
  const site = call("e.as_ref()", "e", "as_ref", 9, 6);
  const ownedBy = (owner: string, symbolId: string, startLine: number, endLine: number): SymbolDefinition => ({
    ...def("src/either.rs", "as_ref", symbolId, startLine, endLine),
    scope: [owner],
  });
  const traitImplAsRef: RustCallSiteDefinition = {
    ...inProject("as_ref", "src/either.rs", 20),
    symbol: "rustc core <mini::Either<L, R> as std::convert::AsRef<T>>::as_ref",
  };

  it("maps a def outside the kept window to the file's one symbolId owned by the impl's self type", () => {
    const t = table(ownedBy("Either", "Either#as_ref", 3, 6), ownedBy("Pair", "Pair#as_ref", 10, 12));
    const callSites = stubIndex({ "src/main.rs:9:6": traitImplAsRef });
    expect(strategy.attempt(site, ctxWith(t, { callSites }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/either.rs", targetSymbolId: "Either#as_ref" },
    });
  });

  it("does not guess when the compiler path names no owner the file declares the name under", () => {
    const t = table(ownedBy("Pair", "Pair#as_ref", 10, 12));
    const callSites = stubIndex({ "src/main.rs:9:6": traitImplAsRef });
    expect(strategy.attempt(site, ctxWith(t, { callSites }))).toEqual({ kind: "continue" });
  });

  it("reads the impl self type off the compiler path", () => {
    expect(rustImplSelfTypeName("rustc core <a::Either<L, R> as std::convert::AsRef<T>>::as_ref")).toBe("Either");
    expect(
      rustImplSelfTypeName(
        "rustc core tikv_util::config::<impl std::convert::From<tikv_util::config::ReadableDuration> for online_config::ConfigValue>::from",
      ),
    ).toBe("ConfigValue");
    expect(rustImplSelfTypeName("rustc mini mini::Store::<T>::get")).toBe("Store");
    expect(rustImplSelfTypeName("rustc core core::str::<impl str>::is_empty")).toBeNull();
    expect(rustImplSelfTypeName("rustc mini bump")).toBeNull();
  });
});
