/**
 * The rustc call-site driver as a Rust resolution source (bd s3i8m T6 + T7;
 * research/rustc-driver/SPEC.md §3, §8.5): the `RustCallSiteIndex` port reaches
 * the chain through the resolve environment (`rustcCallSitesOf`), the
 * `rustcCallSites` slot heads the chain, and the miss classifier's gates read
 * the driver under the R3b/R3c/R3d rules. A derived impl is no project edge and no external call:
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
  RustCallSiteDefinition,
  RustCallSiteIndex,
  RustCallSiteSource,
} from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { rustImplSelfTypeName } from "../../../../../../src/core/domains/language/rust/resolver/call-site-resolution.js";
import {
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
function stubIndex<D extends RustCallSiteDefinition>(answers: Record<string, D>) {
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
  kind: RustCallSiteDefinition["kind"] = "callable",
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
  sources: { callSites?: RustCallSiteIndex } = {},
  typeDeclarations?: Record<string, TypeDeclarationFact[]>,
): CallContext {
  const environment =
    sources.callSites === undefined ? undefined : new RustResolveEnvironment(undefined, undefined, sources.callSites);
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

async function warmedResolver(sources: { callSites?: RustCallSiteIndex } = {}): Promise<RustCallResolver> {
  const resolver = new RustCallResolver(
    undefined,
    undefined,
    undefined,
    sources.callSites === undefined ? undefined : callSiteSource(sources.callSites),
  );
  await resolver.warmResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
  return resolver;
}

async function facade(sources: { callSites?: RustCallSiteIndex } = {}): Promise<LanguageSymbolResolver> {
  const resolver = new LanguageFactory({
    ...(sources.callSites === undefined ? {} : { rustcCallSiteSource: callSiteSource(sources.callSites) }),
  }).create("rust").resolver!;
  await resolver.warmResolvePass?.({ expectedFileCount: 1, projectRoot: ROOT });
  return resolver;
}

const strategy = new RustcCallSiteSymbolResolutionStrategy({ mode: "strict" });

describe("rustcCallSitesOf — the resolve environment carries the driver index (bd s3i8m T6)", () => {
  it("reads the driver index, and nothing off the Rust entry paths", () => {
    const callSites = stubIndex({});
    const ctx = ctxWith(table(), { callSites });
    expect(rustcCallSitesOf(ctx)).toBe(callSites);
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
    const resolver = new RustCallResolver(undefined, undefined, undefined, {
      acquire: async () => ({ kind: "latched", reason: "build", detail: "crate fx failed" }),
    });
    await resolver.warmResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
    expect(resolver.diagnostics()).toEqual({
      rustcCallSites: { outcome: "latched", reason: "build", detail: "crate fx failed" },
    });
  });

  it("forwards the run's units and failed crate targets for the status line (bd s3i8m T8)", async () => {
    const resolver = new RustCallResolver(undefined, undefined, undefined, {
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
      const resolver = new RustCallResolver(undefined, undefined, undefined, {
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
    const resolver = new RustCallResolver(undefined, undefined, undefined, {
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

  it("CONTINUEs without a driver index, a member position, or a row", () => {
    const site = call("v.push(1)", "v", "push", 9, 6);
    expect(strategy.attempt(site, ctxWith(table()))).toEqual({ kind: "continue" });
    expect(strategy.attempt(site, ctxWith(table(), { callSites: stubIndex({}) }))).toEqual({ kind: "continue" });
    const noPosition: CallRef = { callText: "v.push(1)", receiver: "v", member: "push", startLine: 9, startColumn: 4 };
    expect(strategy.attempt(noPosition, ctxWith(table(), { callSites: stubIndex({}) }))).toEqual({
      kind: "continue",
    });
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
  // PIN-UPDATED (T11): rust-analyzer SCIP is gone — the chain ends at the
  // trait-provided `self.m()` pass, and the driver is its one compiler source.
  it("ends the chain at traitSelfMethod, with no compiler slot after the name passes", () => {
    expect(new RustCallResolver().strategies.map((pass) => pass.name).at(-1)).toBe("traitSelfMethod");
  });

  it("answers the driver's definition over a static namesake", async () => {
    const t = table(def("src/shape.rs", "bump", "Counter#bump", 6, 8), def("src/b.rs", "bump", "B#bump", 1, 3));
    const callSites = stubIndex({ "src/main.rs:7:12": inProject("bump", "src/shape.rs", 6) });
    const resolver = await warmedResolver({ callSites });
    expect(resolver.resolve(call("counter.bump(2)", "counter", "bump", 7, 12), ctxWith(t))?.targetSymbolId).toBe(
      "Counter#bump",
    );
    expect(callSites.asked).toEqual(["src/main.rs:7:12"]);
  });

  it("resolves nothing after the driver DROPs a derived impl", async () => {
    const t = table(def("src/shape.rs", "clone", "Shape#clone", 3, 5), def("src/b.rs", "clone", "B#clone", 1, 3));
    const resolver = await warmedResolver({ callSites: stubIndex({ "src/main.rs:12:8": DERIVED_CLONE }) });
    expect(resolver.resolve(call("t.clone()", "t", "clone", 12, 8), ctxWith(t))).toBeNull();
  });
});

describe("the miss classifier's external gate reads the driver (bd s3i8m T7)", () => {
  const namesake = () => table(def("src/stack.rs", "push", "Stack#push", 1, 3));
  const pushSite = call("v.push(1)", "v", "push", 9, 6);

  it("is true on a driver-external site whose member has a project namesake", async () => {
    const callSites = stubIndex({ "src/main.rs:9:6": STD_PUSH });
    expect((await facade({ callSites })).targetsExternalImport?.(pushSite, ctxWith(namesake()))).toBe(true);
  });

  it("is false on a driver-in-project site", async () => {
    const callSites = stubIndex({ "src/main.rs:9:6": inProject("push", "src/stack.rs", 1) });
    expect((await facade({ callSites })).targetsExternalImport?.(pushSite, ctxWith(namesake()))).toBe(false);
  });

  it("is false on a driver-external site with no namesake — the row stays noInProjectDef", async () => {
    const callSites = stubIndex({ "src/main.rs:9:6": STD_PUSH });
    const resolver = await facade({ callSites });
    expect(resolver.targetsExternalImport?.(pushSite, ctxWith(table()))).toBe(false);
    expect(classifyResolveMiss(pushSite, ctxWith(table()), resolver, table())).toBe("noInProjectDef");
  });

  it("applies R3c to a driver answer: a project impl of the trait keeps the site in the denominator", async () => {
    const callSites = stubIndex({ "src/main.rs:30:9": stdTraitMember("Display", "fmt") });
    const t = table(def("src/shape.rs", "fmt", "Shape.fmt", 3, 5));
    const impls = { "src/shape.rs": [traitImpl("Shape", "Display", 2, 6)] };
    expect(
      (await facade({ callSites })).targetsExternalImport?.(call("s.fmt(f)", "s", "fmt", 30, 9), ctxWith(t, {}, impls)),
    ).toBe(false);
  });

  it("buckets a derived impl as noInProjectDef — never external, never a miss", async () => {
    const t = table(def("src/shape.rs", "clone", "Shape#clone", 3, 5));
    const site = call("t.clone()", "t", "clone", 12, 8);
    const resolver = await facade({ callSites: stubIndex({ "src/main.rs:12:8": DERIVED_CLONE }) });
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
    // RESIDUAL R5: an untyped `v.push(1)` whose lone namesake binds by name alone is std where the driver is silent.
    expect(sites.map((site) => classifyResolveMiss(site, ctxWith(t), resolver, t))).toEqual([
      "externalSkipped",
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

  it("drops the name-only `x.unwrap()` edge where the driver has no row, as external (RESIDUAL R5)", async () => {
    const resolver = await warmedResolver({ callSites: stubIndex({}) });
    const t = resNamesake();
    expect(resolver.resolve(unwrapSite, ctxWith(t))).toBeNull();
    expect(classifyResolveMiss(unwrapSite, ctxWith(t), resolver, t)).toBe("externalSkipped");
  });

  it("keeps a typed receiver's static edge where the driver has no row", async () => {
    const resolver = await warmedResolver({ callSites: stubIndex({}) });
    const typed: CallContext = { ...ctxWith(resNamesake()), localBindings: { x: [{ line: 8, type: "Res" }] } };
    expect(resolver.resolve(unwrapSite, typed)?.targetSymbolId).toBe("Res#unwrap");
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
    // RESIDUAL R5: with no driver row the prelude's `Ok` already wins over the name-only namesake.
    expect((await warmedResolver({ callSites: stubIndex({}) })).resolve(okSite, ctxWith(t))).toBeNull();
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

// The classification rules the removed rust-analyzer SCIP slot pinned (bd s3i8m.6 R3a–R3d) now hold for the
// driver's rows alone (T11): the same helpers decide, so every case keeps its driver equivalent here.
describe("driver rows: mapping and the external proof (bd s3i8m.6 R3a)", () => {
  it("maps by the definition's name, not the call's member, under a use-as alias", () => {
    const t = table(def("src/shape.rs", "bump_free", "bump_free", 20, 22, "function"));
    const callSites = stubIndex({ "src/main.rs:25:4": inProject("bump_free", "src/shape.rs", 20) });
    expect(strategy.attempt(call("bf(2)", null, "bf", 25, 4), ctxWith(t, { callSites }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/shape.rs", targetSymbolId: "bump_free" },
    });
  });

  it("maps a macro invocation through the macro namespace only", () => {
    const t = table(
      def("src/main.rs", "twice", "twice", 13, 17, "macro"),
      def("src/main.rs", "twice", "twice_fn", 13, 30, "function"),
    );
    const callSites = stubIndex({ "src/main.rs:26:4": inProject("twice", "src/main.rs", 13, "macro") });
    expect(strategy.attempt(call("twice!()", null, "twice", 26, 4), ctxWith(t, { callSites }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/main.rs", targetSymbolId: "twice" },
    });
  });

  it("CONTINUEs on a direct local or an in-project type", () => {
    const t = table(
      def("src/shape.rs", "Boxed", "Wrap::Boxed", 17, 17, "class"),
      def("src/shape.rs", "bump", "Counter#bump", 6, 8),
    );
    const callSites = stubIndex({
      "src/main.rs:24:4": { ...inProject("", "src/main.rs", 23, "local"), symbol: "rustc local 3" },
      "src/main.rs:22:26": inProject("Boxed", "src/shape.rs", 17, "type"),
    });
    const ctx = ctxWith(t, { callSites });
    expect(strategy.attempt(call("f(1)", null, "f", 24, 4), ctx)).toEqual({ kind: "continue" });
    expect(strategy.attempt(call("shape::Wrap::Boxed(3)", "shape::Wrap", "Boxed", 22, 26), ctx)).toEqual({
      kind: "continue",
    });
  });

  // Moved pin (W1): a non-derivable workspace definition with no project source position used to CONTINUE;
  // it has no table symbol either (servo's build-script `codegen::` items), so it DROPs like any external.
  it("DROPs a workspace definition with no project source position, derivable trait or not", () => {
    const unmarked = { ...DERIVED_CLONE, implIsDerived: undefined };
    const callSites = stubIndex({
      "src/main.rs:21:20": unmarked,
      "src/main.rs:27:6": { ...unmarked, name: "greet", implTrait: "Greeter" },
      "src/main.rs:28:6": { ...unmarked, name: "greet", implTrait: undefined },
    });
    const ctx = ctxWith(table(), { callSites });
    expect(strategy.attempt(call("tally.clone()", "tally", "clone", 21, 20), ctx)).toEqual({ kind: "drop" });
    expect(strategy.attempt(call("g.greet()", "g", "greet", 27, 6), ctx)).toEqual({ kind: "drop" });
    expect(strategy.attempt(call("g.greet()", "g", "greet", 28, 6), ctx)).toEqual({ kind: "drop" });
  });

  describe("a workspace definition generated outside the indexed tree (servo `script_bindings::codegen::`)", () => {
    const generated = (name: string, kind: RustCallSiteDefinition["kind"], declaringTrait?: string) => ({
      symbol: `rustc script_bindings script_bindings::codegen::Generated::${name}`,
      package: "script_bindings",
      inProject: false,
      name,
      kind,
      packageInProject: true,
      ...(declaringTrait === undefined ? {} : { declaringTrait }),
    });

    it("counts an enum-variant constructor with a project namesake as externalSkipped", async () => {
      const t = table(def("src/dom.rs", "String", "DOMString#String", 3, 5));
      const site = call("Union::String(s)", "Union", "String", 40, 11);
      const resolver = await facade({ callSites: stubIndex({ "src/main.rs:40:11": generated("String", "type") }) });
      expect(classifyResolveMiss(site, ctxWith(t), resolver, t)).toBe("externalSkipped");
    });

    it("counts a generated callable with a project namesake as externalSkipped", async () => {
      const t = table(def("src/dom.rs", "empty", "Options.empty", 3, 5));
      const site = call("AudioNodeOptions::empty()", "AudioNodeOptions", "empty", 41, 22);
      const resolver = await facade({ callSites: stubIndex({ "src/main.rs:41:22": generated("empty", "callable") }) });
      expect(classifyResolveMiss(site, ctxWith(t), resolver, t)).toBe("externalSkipped");
    });

    it("keeps R3c for a generated trait's declaration member: a project impl keeps the site a miss", async () => {
      const t = table(def("src/window.rs", "Document", "Window.Document", 3, 5));
      const site = call("window.Document()", "window", "Document", 42, 11);
      const callSites = stubIndex({ "src/main.rs:42:11": generated("Document", "callable", "WindowMethods") });
      const resolver = await facade({ callSites });
      const impls = { "src/window.rs": [traitImpl("Window", "WindowMethods", 2, 6)] };
      expect(resolver.targetsExternalImport?.(site, ctxWith(t, {}, impls))).toBe(false);
      expect(resolver.targetsExternalImport?.(site, ctxWith(t))).toBe(true);
    });
  });
});

describe("driver trait-declaration members prove external only without a project impl (bd s3i8m.6 R3c)", () => {
  const FROM_SITE = "src/main.rs:31:14";
  const MAP_SITE = "src/main.rs:32:9";
  const callSites = () =>
    stubIndex({ [FROM_SITE]: stdTraitMember("From", "from"), [MAP_SITE]: stdTraitMember("Iterator", "map") });
  const fromSite = call("DOMString::from(x)", "DOMString", "from", 31, 14);
  const mapSite = call("iter.map(f)", "iter", "map", 32, 9);
  const domString = () => table(def("src/domstring.rs", "from", "DOMString.from", 11, 13));
  const domStringImpl = { "src/domstring.rs": [traitImpl("DOMString", "From", 10, 14)] };

  it("CONTINUEs when a project impl of the trait declares the member", () => {
    expect(strategy.attempt(fromSite, ctxWith(domString(), { callSites: callSites() }, domStringImpl))).toEqual({
      kind: "continue",
    });
  });

  it("DROPs when no project impl of the trait declares the member", () => {
    expect(strategy.attempt(fromSite, ctxWith(table(), { callSites: callSites() }, {}))).toEqual({ kind: "drop" });
    // The namesake sits outside every `impl From for _` span — an inherent `from` proves nothing.
    const outside = { "src/domstring.rs": [traitImpl("DOMString", "From", 20, 24)] };
    expect(strategy.attempt(fromSite, ctxWith(domString(), { callSites: callSites() }, outside))).toEqual({
      kind: "drop",
    });
    // An impl of ANOTHER trait declaring `from` is no impl of `From`.
    const otherTrait = { "src/domstring.rs": [traitImpl("DOMString", "Into", 10, 14)] };
    expect(strategy.attempt(fromSite, ctxWith(domString(), { callSites: callSites() }, otherTrait))).toEqual({
      kind: "drop",
    });
  });

  it("DROPs a provided trait method no project impl declares", () => {
    const counter = table(def("src/counter.rs", "next", "Counter.next", 3, 5));
    const iteratorImpl = { "src/counter.rs": [traitImpl("Counter", "Iterator", 2, 6)] };
    expect(strategy.attempt(mapSite, ctxWith(counter, { callSites: callSites() }, iteratorImpl))).toEqual({
      kind: "drop",
    });
  });

  it("keeps the site in the denominator: targetsExternalImport is false on a project impl", async () => {
    const resolver = await facade({ callSites: callSites() });
    expect(resolver.targetsExternalImport?.(fromSite, ctxWith(domString(), {}, domStringImpl))).toBe(false);
    expect(resolver.targetsExternalImport?.(fromSite, ctxWith(domString(), {}, {}))).toBe(true);
  });
});

describe("driver trait-declaration members on a proven external receiver (bd s3i8m.6 R3d)", () => {
  const TURBOFISH_SITE = "src/main.rs:43:20";
  const CLONE_SITE = "src/main.rs:44:12";
  const callSites = () =>
    stubIndex({ [TURBOFISH_SITE]: stdTraitMember("From", "from"), [CLONE_SITE]: stdTraitMember("Clone", "clone") });
  const vecFrom = call("Vec::<u8>::from(x)", "Vec::<u8>", "from", 43, 20);
  const txClone = call("tx.clone()", "tx", "clone", 44, 12);
  const domString = () => table(def("src/domstring.rs", "from", "DOMString.from", 11, 13));
  const domStringImpl = { "src/domstring.rs": [traitImpl("DOMString", "From", 10, 14)] };
  const shape = () => table(def("src/shape.rs", "clone", "Shape.clone", 3, 5));
  const cloneImpl = { "src/shape.rs": [traitImpl("Shape", "Clone", 2, 6)] };

  it("DROPs a turbofish std path receiver no project impl of the trait targets", () => {
    expect(strategy.attempt(vecFrom, ctxWith(domString(), { callSites: callSites() }, domStringImpl))).toEqual({
      kind: "drop",
    });
  });

  it("DROPs a receiver typed to a std type no project impl of the trait targets", () => {
    const ctx: CallContext = {
      ...ctxWith(shape(), { callSites: callSites() }, cloneImpl),
      localBindings: { tx: [{ line: 40, type: "std::sync::mpsc::Sender" }] },
    };
    expect(strategy.attempt(txClone, ctx)).toEqual({ kind: "drop" });
  });

  it("keeps R3c's rule when the path spells the trait, not the receiver type", () => {
    const ufcs = call("std::io::Write::write(&mut w, buf)", "std::io::Write", "write", 45, 25);
    const writer = table(def("src/sink.rs", "write", "Sink.write", 3, 5));
    const writeImpl = { "src/sink.rs": [traitImpl("Sink", "Write", 2, 6)] };
    const ufcsIndex = stubIndex({ "src/main.rs:45:25": stdTraitMember("Write", "write") });
    expect(strategy.attempt(ufcs, ctxWith(writer, { callSites: ufcsIndex }, writeImpl))).toEqual({
      kind: "continue",
    });
  });

  it("keeps R3c's rule on an untyped receiver", () => {
    expect(strategy.attempt(txClone, ctxWith(shape(), { callSites: callSites() }, cloneImpl))).toEqual({
      kind: "continue",
    });
  });
});

describe("RustCallResolver#hasInProjectDefinition with the driver (bd s3i8m.6 R3b)", () => {
  it("is false when the driver proves the target a direct local", async () => {
    const t = table(def("src/util.rs", "f", "f", 1, 3, "function"));
    const resolver = await warmedResolver({
      callSites: stubIndex({
        "src/main.rs:24:4": { ...inProject("", "src/main.rs", 23, "local"), symbol: "rustc local 3" },
      }),
    });
    expect(resolver.hasInProjectDefinition(call("f(1)", null, "f", 24, 4), ctxWith(t))).toBe(false);
  });

  it("keeps the table's answer for a callable, an external, no row and no index", async () => {
    const t = table(def("src/stack.rs", "push", "Stack#push", 1, 3), def("src/util.rs", "f", "f", 1, 3, "function"));
    const resolver = await warmedResolver({
      callSites: stubIndex({ "src/main.rs:9:6": STD_PUSH, "src/main.rs:24:4": inProject("f", "src/util.rs", 1) }),
    });
    expect(resolver.hasInProjectDefinition(call("f(1)", null, "f", 24, 4), ctxWith(t))).toBe(true);
    expect(resolver.hasInProjectDefinition(call("v.push(1)", "v", "push", 9, 6), ctxWith(t))).toBe(true);
    expect(resolver.hasInProjectDefinition(call("v.push(1)", "v", "push", 40, 6), ctxWith(t))).toBe(true);
    expect(new RustCallResolver().hasInProjectDefinition(call("f(1)", null, "f", 24, 4), ctxWith(t))).toBe(true);
  });
});
