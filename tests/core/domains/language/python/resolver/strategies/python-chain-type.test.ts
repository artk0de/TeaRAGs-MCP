/**
 * `PythonChainTypeSymbolResolutionStrategy` (E1 seam 3, bd tea-rags-mcp-9fgdi).
 *
 * The pass reads three channels — `localBindings`, `classFieldTypes` and the
 * `structuredReturnTypes` the annotation facet emits — folds them left to right
 * through `kernel/receiver-type-propagation.ts`, and resolves the member on
 * whatever single class the fold arrives at.
 *
 * Every positive case asserts the EXACT `targetSymbolId`: "resolved" alone
 * would pass for a chain that folded to the wrong class and still found a
 * same-named member. Every negative asserts DROP vs CONTINUE explicitly,
 * because that distinction IS the precision guard — DROP cuts the call off
 * from `importMatch` / `globalShortName`, CONTINUE hands it on unchanged.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../../src/core/contracts/types/language.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonChainTypeSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-chain-type.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

interface Def {
  symbolId: string;
  scope?: string[];
}

function tableWith(files: Record<string, Def[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((def) => ({
        symbolId: def.symbolId,
        fqName: def.symbolId,
        shortName: def.symbolId.split(/[#.]/).pop() ?? def.symbolId,
        relPath,
        scope: def.scope ?? [],
      })),
    );
  }
  return table;
}

function strategy(): PythonChainTypeSymbolResolutionStrategy {
  return new PythonChainTypeSymbolResolutionStrategy({ mode: "strict" }, new PythonImportFileMapper());
}

/** The production wiring: the chain factory always hands the strategy a linearizer cache. */
function mroStrategy(): PythonChainTypeSymbolResolutionStrategy {
  const mapper = new PythonImportFileMapper();
  return new PythonChainTypeSymbolResolutionStrategy(
    { mode: "strict" },
    mapper,
    new PythonAncestorLinearizerCache(mapper, "strict"),
  );
}

const call = (receiver: string | null, member: string, startLine = 10): CallRef => ({
  callText: `${receiver ?? ""}.${member}()`,
  receiver,
  member,
  startLine,
});

interface CtxParts {
  callerFile?: string;
  callerScope?: string[];
  classAncestors?: Record<string, readonly string[]>;
  imports?: ImportRef[];
  classFieldTypes?: Record<string, Record<string, string>>;
  localBindings?: CallContext["localBindings"];
  structuredReturnTypes?: Record<string, TypeRef>;
  classExtends?: Record<string, string>;
}

function ctxWith(table: InMemoryGlobalSymbolTable, parts: CtxParts = {}): CallContext {
  return {
    callerFile: parts.callerFile ?? "app/caller.py",
    callerScope: parts.callerScope ?? [],
    classAncestors: parts.classAncestors,
    imports: parts.imports ?? [],
    symbolTable: table,
    classFieldTypes: parts.classFieldTypes,
    localBindings: parts.localBindings,
    structuredReturnTypes: parts.structuredReturnTypes,
    classExtends: parts.classExtends,
  };
}

const instance = (name: string): TypeRef => ({ form: "instance", name });

describe("PythonChainTypeSymbolResolutionStrategy — binding then return type", () => {
  it("folds `svc.build()` to the declared return type and pins the member on it", () => {
    const table = tableWith({
      "app/caller.py": [{ symbolId: "caller" }],
      "app/svc.py": [{ symbolId: "Svc" }, { symbolId: "Svc#build", scope: ["Svc"] }],
      "app/widget.py": [{ symbolId: "Widget" }, { symbolId: "Widget#run", scope: ["Widget"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 3, type: "Svc" }] },
      structuredReturnTypes: { "Svc#build": instance("Widget") },
    });
    expect(strategy().attempt(call("svc.build()", "run"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/widget.py", targetSymbolId: "Widget#run" },
    });
  });

  it("folds `self.repo.get(id)` through the field type and the return type", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "app/repo.py": [{ symbolId: "Repo" }, { symbolId: "Repo#get", scope: ["Repo"] }],
      "app/row.py": [{ symbolId: "Row" }, { symbolId: "Row#save", scope: ["Row"] }],
    });
    const ctx = ctxWith(table, {
      callerScope: ["Svc"],
      classFieldTypes: { Svc: { repo: "Repo" } },
      structuredReturnTypes: { "Repo#get": instance("Row") },
    });
    expect(strategy().attempt(call("self.repo.get(id)", "save"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/row.py", targetSymbolId: "Row#save" },
    });
  });

  it("reads a nested owner's key `.`-joined verbatim, never re-composed with `::`", () => {
    const table = tableWith({
      "app/outer.py": [{ symbolId: "Outer" }, { symbolId: "Outer.Inner", scope: ["Outer"] }],
      "app/widget.py": [{ symbolId: "Widget" }, { symbolId: "Widget#run", scope: ["Widget"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { oi: [{ line: 1, type: "Outer.Inner" }] },
      structuredReturnTypes: { "Outer.Inner#build": instance("Widget") },
    });
    expect(strategy().attempt(call("oi.build()", "run"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/widget.py", targetSymbolId: "Widget#run" },
    });
  });

  it("resolves the member against the class the fold arrives at, up its classExtends chain", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }, { symbolId: "Svc#build", scope: ["Svc"] }],
      "app/leaf.py": [{ symbolId: "Leaf" }],
      "app/base.py": [{ symbolId: "Base" }, { symbolId: "Base#shared", scope: ["Base"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 1, type: "Svc" }] },
      structuredReturnTypes: { "Svc#build": instance("Leaf") },
      classExtends: { Leaf: "Base" },
    });
    expect(strategy().attempt(call("svc.build()", "shared"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#shared" },
    });
  });
});

describe("PythonChainTypeSymbolResolutionStrategy — a module-qualified head", () => {
  const moduleTable = (): InMemoryGlobalSymbolTable =>
    tableWith({
      "app/mod.py": [
        { symbolId: "Cls" },
        { symbolId: "Cls#run", scope: ["Cls"] },
        { symbolId: "Cls.make", scope: ["Cls"] },
      ],
      "app/widget.py": [{ symbolId: "Widget" }, { symbolId: "Widget#run", scope: ["Widget"] }],
      "app/other.py": [{ symbolId: "Other" }, { symbolId: "Other#run", scope: ["Other"] }],
    });
  const imports: ImportRef[] = [{ importText: "mod", startLine: 1 }];

  it("seeds `mod.Cls()` as an INSTANCE and reads the `#` return key", () => {
    const ctx = ctxWith(moduleTable(), {
      imports,
      structuredReturnTypes: { "Cls#make": instance("Widget"), "Cls.make": instance("Other") },
    });
    expect(strategy().attempt(call("mod.Cls().make()", "run"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/widget.py", targetSymbolId: "Widget#run" },
    });
  });

  it("seeds `mod.Cls` as a CLASS and reads the `.` return key", () => {
    const ctx = ctxWith(moduleTable(), {
      imports,
      structuredReturnTypes: { "Cls#make": instance("Other"), "Cls.make": instance("Widget") },
    });
    expect(strategy().attempt(call("mod.Cls.make()", "run"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/widget.py", targetSymbolId: "Widget#run" },
    });
  });

  it("declines a capitalized first link when the head is not imported", () => {
    const ctx = ctxWith(moduleTable(), {
      imports: [{ importText: "elsewhere", startLine: 1 }],
      structuredReturnTypes: { "Cls#make": instance("Widget") },
    });
    expect(strategy().attempt(call("mod.Cls().make()", "run"), ctx)).toEqual({ kind: "continue" });
  });
});

describe("PythonChainTypeSymbolResolutionStrategy — position-aware binding", () => {
  it("folds the same receiver text through two different types by call line", () => {
    const table = tableWith({
      "app/a.py": [{ symbolId: "A" }, { symbolId: "A#build", scope: ["A"] }],
      "app/b.py": [{ symbolId: "B" }, { symbolId: "B#build", scope: ["B"] }],
      "app/wa.py": [{ symbolId: "WidgetA" }, { symbolId: "WidgetA#run", scope: ["WidgetA"] }],
      "app/wb.py": [{ symbolId: "WidgetB" }, { symbolId: "WidgetB#run", scope: ["WidgetB"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: {
        svc: [
          { line: 3, type: "A" },
          { line: 9, type: "B" },
        ],
      },
      structuredReturnTypes: { "A#build": instance("WidgetA"), "B#build": instance("WidgetB") },
    });
    expect(strategy().attempt(call("svc.build()", "run", 5), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/wa.py", targetSymbolId: "WidgetA#run" },
    });
    expect(strategy().attempt(call("svc.build()", "run", 11), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/wb.py", targetSymbolId: "WidgetB#run" },
    });
  });
});

describe("PythonChainTypeSymbolResolutionStrategy — what it refuses", () => {
  it("DROPS a folded type that is not in the project rather than falling through", () => {
    const table = tableWith({ "app/svc.py": [{ symbolId: "Svc" }] });
    const ctx = ctxWith(table, {
      callerScope: ["Svc"],
      classFieldTypes: { Svc: { session: "Session" } },
    });
    const outcome = strategy().attempt(call("self.session", "query"), ctx);
    expect(outcome).toEqual({ kind: "drop" });
    expect(outcome.kind).not.toBe("continue");
  });

  it("DROPS an in-project folded type whose chain defines the member nowhere", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }, { symbolId: "Svc#build", scope: ["Svc"] }],
      "app/widget.py": [{ symbolId: "Widget" }, { symbolId: "Widget#run", scope: ["Widget"] }],
      "app/unrelated.py": [{ symbolId: "Unrelated" }, { symbolId: "Unrelated#save", scope: ["Unrelated"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 1, type: "Svc" }] },
      structuredReturnTypes: { "Svc#build": instance("Widget") },
    });
    expect(strategy().attempt(call("svc.build()", "save"), ctx)).toEqual({ kind: "drop" });
  });

  it("CONTINUEs on a builtin head with no binding — nothing was folded", () => {
    const table = tableWith({ "app/caller.py": [{ symbolId: "caller" }] });
    expect(strategy().attempt(call("d.items()", "x"), ctxWith(table))).toEqual({ kind: "continue" });
  });

  it("CONTINUEs on a union mid-chain — no fan-out, no first-member guess", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "app/a.py": [{ symbolId: "A" }, { symbolId: "A#run", scope: ["A"] }],
      "app/b.py": [{ symbolId: "B" }, { symbolId: "B#run", scope: ["B"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 1, type: "Svc" }] },
      structuredReturnTypes: {
        "Svc#build": { form: "union", members: [instance("A"), instance("B")] },
      },
    });
    expect(strategy().attempt(call("svc.build()", "run"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUEs on a container return — `list[Foo]` types the list, not an element", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "app/foo.py": [{ symbolId: "Foo" }, { symbolId: "Foo#append", scope: ["Foo"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 1, type: "Svc" }] },
      structuredReturnTypes: { "Svc#build": { form: "container", element: instance("Foo") } },
    });
    expect(strategy().attempt(call("svc.build()", "append"), ctx)).toEqual({ kind: "continue" });
  });

  it("STOPS at an unknown hop instead of fabricating past it", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "app/widget.py": [{ symbolId: "Widget" }, { symbolId: "Widget#run", scope: ["Widget"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 1, type: "Svc" }] },
      // `Svc#build` types the first hop; nothing types `tail`, so the whole
      // receiver is untyped and the later passes see the call unchanged.
      structuredReturnTypes: { "Svc#build": instance("Widget") },
    });
    expect(strategy().attempt(call("svc.build().tail()", "run"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUEs past the default hop cap of 4", () => {
    const table = tableWith({ "app/svc.py": [{ symbolId: "Svc" }] });
    const ctx = ctxWith(table, { localBindings: { a: [{ line: 1, type: "Svc" }] } });
    expect(strategy().attempt(call("a.b.c.d.e", "run"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUEs on a free call with no receiver", () => {
    const table = tableWith({ "app/caller.py": [{ symbolId: "caller" }] });
    expect(strategy().attempt(call(null, "helper"), ctxWith(table))).toEqual({ kind: "continue" });
  });
});

/**
 * R4a — a field or a return declared on an ANCESTOR (bd tea-rags-mcp-yl85b).
 *
 * `classFieldTypes` is keyed by the SHORT name of the class that ASSIGNED the
 * field, so polar's `self.client.build_request(...)` — `client` assigned in
 * `SyncServiceBase.__init__` in another file, called from 60-odd subclasses in
 * theirs — missed on hop 1 and took 1,528 of that corpus's 1,596 `chain` rows
 * with it. The fold now consults the whole MRO seam 4 built, own class first.
 */
describe("PythonChainTypeSymbolResolutionStrategy — up the MRO", () => {
  const polarTable = (): InMemoryGlobalSymbolTable =>
    tableWith({
      "sdk/base.py": [
        { symbolId: "SyncServiceBase" },
        { symbolId: "SyncClientBase" },
        { symbolId: "BuildRequestMixin" },
        { symbolId: "BuildRequestMixin#build_request", scope: ["BuildRequestMixin"] },
      ],
      "svc/metrics.py": [{ symbolId: "MetricsSync" }],
    });

  const polarCtx = (parts: CtxParts = {}): CallContext =>
    ctxWith(polarTable(), {
      callerFile: "svc/metrics.py",
      callerScope: ["MetricsSync"],
      classAncestors: { "svc/metrics.py::MetricsSync": ["sdk.base::SyncServiceBase"] },
      classExtends: { SyncClientBase: "BuildRequestMixin" },
      classFieldTypes: { SyncServiceBase: { client: "SyncClientBase" } },
      ...parts,
    });

  it("reads a class field declared on an ANCESTOR", () => {
    expect(mroStrategy().attempt(call("self.client", "build_request"), polarCtx())).toEqual({
      kind: "resolved",
      target: { targetRelPath: "sdk/base.py", targetSymbolId: "BuildRequestMixin#build_request" },
    });
  });

  it("prefers the receiver's OWN field over an ancestor's", () => {
    const table = tableWith({
      "sdk/base.py": [{ symbolId: "SyncServiceBase" }, { symbolId: "SyncClientBase" }],
      "svc/metrics.py": [{ symbolId: "MetricsSync" }],
      "sdk/own.py": [{ symbolId: "OwnClient" }, { symbolId: "OwnClient#build_request", scope: ["OwnClient"] }],
    });
    const ctx = ctxWith(table, {
      callerFile: "svc/metrics.py",
      callerScope: ["MetricsSync"],
      classAncestors: { "svc/metrics.py::MetricsSync": ["sdk.base::SyncServiceBase"] },
      classFieldTypes: { MetricsSync: { client: "OwnClient" }, SyncServiceBase: { client: "SyncClientBase" } },
    });
    expect(mroStrategy().attempt(call("self.client", "build_request"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "sdk/own.py", targetSymbolId: "OwnClient#build_request" },
    });
  });

  it("walks the C3 order, not a depth-first dive — the diamond's B beats D", () => {
    const table = tableWith({
      "app/c.py": [{ symbolId: "C" }],
      "app/a.py": [{ symbolId: "A" }],
      "app/b.py": [{ symbolId: "B" }],
      "app/d.py": [{ symbolId: "D" }],
      "app/connb.py": [{ symbolId: "ConnB" }, { symbolId: "ConnB#ping", scope: ["ConnB"] }],
      "app/connd.py": [{ symbolId: "ConnD" }, { symbolId: "ConnD#ping", scope: ["ConnD"] }],
    });
    const ctx = ctxWith(table, {
      callerFile: "app/c.py",
      callerScope: ["C"],
      classAncestors: {
        "app/c.py::C": ["app.a::A", "app.b::B"],
        "app/a.py::A": ["app.d::D"],
        "app/b.py::B": ["app.d::D"],
      },
      classFieldTypes: { B: { conn: "ConnB" }, D: { conn: "ConnD" } },
    });
    expect(mroStrategy().attempt(call("self.conn", "ping"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/connb.py", targetSymbolId: "ConnB#ping" },
    });
  });

  it("reads a structured return declared on an ANCESTOR", () => {
    const table = tableWith({
      "repo/base.py": [{ symbolId: "RepositoryBase" }, { symbolId: "RepositoryBase#get", scope: ["RepositoryBase"] }],
      "repo/sub.py": [{ symbolId: "SubscriptionRepository" }],
    });
    const ctx = ctxWith(table, {
      imports: [{ importText: "repo", startLine: 1 }],
      classAncestors: { "repo/sub.py::SubscriptionRepository": ["repo.base::RepositoryBase"] },
      // polar's `RepositoryBase.from_session` is a `@classmethod`, so the key
      // carries the `.` spelling the class-form receiver asks for.
      structuredReturnTypes: { "RepositoryBase.from_session": instance("RepositoryBase") },
    });
    expect(mroStrategy().attempt(call("repo.SubscriptionRepository.from_session()", "get"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "repo/base.py", targetSymbolId: "RepositoryBase#get" },
    });
  });

  it("yields nothing when the hierarchy leaves the project before the field", () => {
    const ctx = polarCtx({ classAncestors: { "svc/metrics.py::MetricsSync": ["httpx::Client"] } });
    expect(mroStrategy().attempt(call("self.client", "build_request"), ctx)).toEqual({ kind: "continue" });
  });

  it("keeps the pre-seam behaviour with no linearizer", () => {
    expect(strategy().attempt(call("self.client", "build_request"), polarCtx())).toEqual({ kind: "continue" });
    // A walker-v2 index carries no `classAncestors`; the cache answers
    // `undefined` there and the read stays own-class-only.
    expect(
      mroStrategy().attempt(call("self.client", "build_request"), polarCtx({ classAncestors: undefined })),
    ).toEqual({ kind: "continue" });
  });

  it("does not walk for a container or union receiver", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "app/base.py": [{ symbolId: "Base" }],
      "app/foo.py": [{ symbolId: "Foo" }, { symbolId: "Foo#append", scope: ["Foo"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 1, type: "Svc" }] },
      classAncestors: { "app/svc.py::Svc": ["app.base::Base"] },
      classFieldTypes: { Base: { append: "Foo" } },
      structuredReturnTypes: { "Svc#build": { form: "container", element: instance("Foo") } },
    });
    expect(mroStrategy().attempt(call("svc.build()", "append"), ctx)).toEqual({ kind: "continue" });
  });
});

/**
 * A module receiver a same-named assignment shadows (R4c, bd tea-rags-mcp-jeqyg).
 *
 * `layout = layout.SimpleLayout(...)` inside a netbox view class: the walker
 * records `layout -> SimpleLayout` at that very line, and the fold then reads
 * the RECEIVER through the binding its own right-hand side produced. Python
 * evaluates the RHS before rebinding, so on that line `layout` still denotes
 * what `from netbox.ui import layout` bound — a module, which this pass cannot
 * type and must not DROP. 165 netbox rows across 11 view files.
 */
describe("PythonChainTypeSymbolResolutionStrategy — a binding does not type its own statement", () => {
  const uiTable = (): InMemoryGlobalSymbolTable =>
    tableWith({
      "netbox/account/views.py": [{ symbolId: "UserTokenView" }],
      "netbox/netbox/ui/layout.py": [
        { symbolId: "Layout" },
        { symbolId: "SimpleLayout" },
        { symbolId: "SimpleLayout#render", scope: ["SimpleLayout"] },
      ],
    });

  const uiImport: ImportRef[] = [
    { importText: "netbox.ui", startLine: 29, importedNames: ["layout"], importedBindings: { layout: "layout" } },
  ];

  it("CONTINUEs on the shadowing statement so the module arm below can answer", () => {
    const ctx = ctxWith(uiTable(), {
      callerFile: "netbox/account/views.py",
      imports: uiImport,
      localBindings: { layout: [{ line: 347, type: "SimpleLayout" }] },
    });
    expect(mroStrategy().attempt(call("layout", "SimpleLayout", 347), ctx)).toEqual({ kind: "continue" });
  });

  it("still types the receiver on every LATER line", () => {
    const ctx = ctxWith(uiTable(), {
      callerFile: "netbox/account/views.py",
      imports: uiImport,
      localBindings: { layout: [{ line: 347, type: "SimpleLayout" }] },
    });
    expect(mroStrategy().attempt(call("layout", "render", 348), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "netbox/netbox/ui/layout.py", targetSymbolId: "SimpleLayout#render" },
    });
  });

  it("falls back to the PRIOR binding when the name was bound earlier too", () => {
    const ctx = ctxWith(uiTable(), {
      callerFile: "netbox/account/views.py",
      imports: uiImport,
      localBindings: {
        layout: [
          { line: 300, type: "Layout" },
          { line: 347, type: "SimpleLayout" },
        ],
      },
    });
    // `Layout` declares no `render`, and its hierarchy is read to the end — the
    // pass DROPs rather than reaching for a same-named member elsewhere.
    expect(mroStrategy().attempt(call("layout", "render", 347), ctx)).toEqual({ kind: "drop" });
  });

  it("keeps the same-line binding when NO import bound that name", () => {
    const ctx = ctxWith(uiTable(), {
      callerFile: "netbox/account/views.py",
      localBindings: { layout: [{ line: 347, type: "SimpleLayout" }] },
    });
    // `x = Foo(); x.run()` on one line is not a module shadow; nothing about
    // the import list says otherwise, so the binding stands.
    expect(mroStrategy().attempt(call("layout", "render", 347), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "netbox/netbox/ui/layout.py", targetSymbolId: "SimpleLayout#render" },
    });
  });
});

/**
 * The LAST hop resolves its member through the C3 MRO too (bd
 * tea-rags-mcp-s2w5g). The fold walks the hierarchy for the receiver's TYPE,
 * and then handed the member to `resolvePythonMemberOnType`, whose fallback is
 * the single-base `classExtends` chain with an UNFILTERED symbol-table lookup
 * on each hop. polar declares `BuildRequestMixin` twice — once in the SDK,
 * once in the generator template it is rendered from — so that lookup is
 * ambiguous and the walk answered `null` on a member jedi pins exactly.
 */
describe("PythonChainTypeSymbolResolutionStrategy — the member through the MRO", () => {
  const twoMixinCopies = () =>
    tableWith({
      "svc/metrics.py": [{ symbolId: "MetricsSync" }],
      "sdk/client.py": [{ symbolId: "SyncClientBase" }],
      "sdk/mixin.py": [
        { symbolId: "BuildRequestMixin" },
        { symbolId: "BuildRequestMixin#build_request", scope: ["BuildRequestMixin"] },
      ],
      "template/mixin.py": [
        { symbolId: "BuildRequestMixin" },
        { symbolId: "BuildRequestMixin#build_request", scope: ["BuildRequestMixin"] },
      ],
    });

  const parts = {
    callerFile: "svc/metrics.py",
    callerScope: ["MetricsSync"],
    classFieldTypes: { MetricsSync: { client: "SyncClientBase" } },
    classExtends: { SyncClientBase: "BuildRequestMixin" },
    classAncestors: { "sdk/client.py::SyncClientBase": ["sdk.mixin::BuildRequestMixin"] },
  };

  it("pins the base that DECLARES the member when its short name is not unique", () => {
    expect(mroStrategy().attempt(call("self.client", "build_request"), ctxWith(twoMixinCopies(), parts))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "sdk/mixin.py", targetSymbolId: "BuildRequestMixin#build_request" },
    });
  });

  it("still DROPs when no class in the folded type's hierarchy declares the member", () => {
    expect(mroStrategy().attempt(call("self.client", "absent"), ctxWith(twoMixinCopies(), parts))).toEqual({
      kind: "drop",
    });
  });
});
