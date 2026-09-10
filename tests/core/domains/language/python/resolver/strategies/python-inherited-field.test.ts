/**
 * Inherited-FIELD resolution for `self.<field>.<member>()` (R4a, bd
 * tea-rags-mcp-yl85b).
 *
 * `PythonSelfFieldSymbolResolutionStrategy` read `classFieldTypes[<enclosing
 * class>][field]` and DROPped when nothing was there. That channel is keyed by
 * the SHORT name of the class that ASSIGNED the field, so polar's generated SDK
 * — `self.client` assigned once in `SyncServiceBase.__init__`
 * (`sdk/python/polar/base.py:179`) and called from 60-odd subclasses in other
 * files — missed every time. The field read now walks the same C3 MRO seam 4
 * built for members, own class first.
 *
 * What does NOT change: the verdicts below the read. A field the walk cannot
 * type still DROPs (the `rjuc` guard — a `self.<field>` receiver is never a
 * module name, so falling through would hand the call to any class that
 * happens to define the member), and a KNOWN external field type still DROPs
 * so the external gate can take the call out of the denominator.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonSelfFieldSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-self-field.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

interface Def {
  readonly symbolId: string;
  readonly scope?: readonly string[];
}

function tableWith(files: Record<string, readonly Def[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((def) => ({
        symbolId: def.symbolId,
        fqName: def.symbolId,
        shortName: def.symbolId.split(/[#.]/).pop() ?? def.symbolId,
        relPath,
        scope: [...(def.scope ?? [])],
      })),
    );
  }
  return table;
}

/** The production wiring: the chain factory always hands the strategy a cache. */
function mroSelfField(): PythonSelfFieldSymbolResolutionStrategy {
  const mapper = new PythonImportFileMapper();
  return new PythonSelfFieldSymbolResolutionStrategy(
    { mode: "strict" },
    mapper,
    new PythonAncestorLinearizerCache(mapper, "strict"),
  );
}

/** A run whose index predates `classAncestors` — the pre-seam read. */
function plainSelfField(): PythonSelfFieldSymbolResolutionStrategy {
  return new PythonSelfFieldSymbolResolutionStrategy({ mode: "strict" }, new PythonImportFileMapper());
}

const sendRequest: CallRef = {
  callText: "self.client.send_request(req)",
  receiver: "self.client",
  member: "send_request",
  startLine: 42,
};

interface CtxSpec {
  readonly table: InMemoryGlobalSymbolTable;
  readonly imports?: readonly ImportRef[];
  readonly classAncestors?: Record<string, readonly string[]>;
  readonly classFieldTypes?: Record<string, Record<string, string>>;
  readonly classFieldTypesByClassKey?: Record<string, Record<string, string>>;
}

function ctxWith(spec: CtxSpec): CallContext {
  return {
    callerFile: "svc/metrics.py",
    callerScope: ["MetricsSync"],
    imports: [...(spec.imports ?? [])],
    symbolTable: spec.table,
    ...(spec.classAncestors === undefined ? {} : { classAncestors: spec.classAncestors }),
    ...(spec.classFieldTypes === undefined ? {} : { classFieldTypes: spec.classFieldTypes }),
    ...(spec.classFieldTypesByClassKey === undefined
      ? {}
      : { classFieldTypesByClassKey: spec.classFieldTypesByClassKey }),
  };
}

const polarTable = (): InMemoryGlobalSymbolTable =>
  tableWith({
    "sdk/base.py": [
      { symbolId: "SyncServiceBase" },
      { symbolId: "SyncClientBase" },
      { symbolId: "SyncClientBase#send_request", scope: ["SyncClientBase"] },
    ],
    "svc/metrics.py": [{ symbolId: "MetricsSync" }],
  });

const polarAncestors = { "svc/metrics.py::MetricsSync": ["sdk.base::SyncServiceBase"] } as const;

describe("PythonSelfFieldSymbolResolutionStrategy — a field assigned by an ancestor", () => {
  it("resolves through a field assigned in a BASE class in another file", () => {
    const ctx = ctxWith({
      table: polarTable(),
      classAncestors: { ...polarAncestors },
      classFieldTypes: { SyncServiceBase: { client: "SyncClientBase" } },
    });
    expect(mroSelfField().attempt(sendRequest, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "sdk/base.py", targetSymbolId: "SyncClientBase#send_request" },
    });
  });

  it("prefers the enclosing class's OWN field over the ancestor's", () => {
    const table = tableWith({
      "sdk/base.py": [
        { symbolId: "SyncServiceBase" },
        { symbolId: "SyncClientBase" },
        { symbolId: "SyncClientBase#send_request", scope: ["SyncClientBase"] },
      ],
      "svc/metrics.py": [{ symbolId: "MetricsSync" }],
      "sdk/own.py": [{ symbolId: "OwnClient" }, { symbolId: "OwnClient#send_request", scope: ["OwnClient"] }],
    });
    const ctx = ctxWith({
      table,
      classAncestors: { ...polarAncestors },
      classFieldTypes: { MetricsSync: { client: "OwnClient" }, SyncServiceBase: { client: "SyncClientBase" } },
    });
    expect(mroSelfField().attempt(sendRequest, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "sdk/own.py", targetSymbolId: "OwnClient#send_request" },
    });
  });

  it("DROPs when the hierarchy leaves the project before the field — the rjuc guard is unchanged", () => {
    const ctx = ctxWith({
      table: polarTable(),
      classAncestors: { "svc/metrics.py::MetricsSync": ["httpx::Client"] },
      classFieldTypes: { SyncServiceBase: { client: "SyncClientBase" } },
    });
    expect(mroSelfField().attempt(sendRequest, ctx)).toEqual({ kind: "drop" });
  });

  it("keeps the pre-seam behaviour with no linearizer", () => {
    const ctx = ctxWith({
      table: polarTable(),
      classAncestors: { ...polarAncestors },
      classFieldTypes: { SyncServiceBase: { client: "SyncClientBase" } },
    });
    expect(plainSelfField().attempt(sendRequest, ctx)).toEqual({ kind: "drop" });
    const noChannel = ctxWith({
      table: polarTable(),
      classFieldTypes: { SyncServiceBase: { client: "SyncClientBase" } },
    });
    expect(mroSelfField().attempt(sendRequest, noChannel)).toEqual({ kind: "drop" });
  });
});

/**
 * The channel the MRO fold actually has in production (bd tea-rags-mcp-f0xaa).
 * `classFieldTypes` above is the CALLER's per-file map — in a real run it never
 * carries a base class declared in another file, so every case above resolved
 * only because the test handed the resolver a map production cannot build.
 * `classFieldTypesByClassKey` is run-global and addressed exactly as the
 * linearized ancestor keys are, so the ancestor's fields are readable from the
 * subclass's file.
 */
describe("PythonSelfFieldSymbolResolutionStrategy — the run-global field channel", () => {
  it("resolves through a base class's field with NOTHING in the per-file map", () => {
    const ctx = ctxWith({
      table: polarTable(),
      classAncestors: { ...polarAncestors },
      classFieldTypesByClassKey: { "sdk/base.py::SyncServiceBase": { client: "SyncClientBase" } },
    });
    expect(mroSelfField().attempt(sendRequest, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "sdk/base.py", targetSymbolId: "SyncClientBase#send_request" },
    });
  });

  it("reads the caller's OWN class off the run-global channel too", () => {
    const table = tableWith({
      "sdk/base.py": [
        { symbolId: "SyncClientBase" },
        { symbolId: "SyncClientBase#send_request", scope: ["SyncClientBase"] },
      ],
      "svc/metrics.py": [{ symbolId: "MetricsSync" }],
    });
    const ctx = ctxWith({
      table,
      classAncestors: { ...polarAncestors },
      classFieldTypesByClassKey: { "svc/metrics.py::MetricsSync": { client: "SyncClientBase" } },
    });
    expect(mroSelfField().attempt(sendRequest, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "sdk/base.py", targetSymbolId: "SyncClientBase#send_request" },
    });
  });

  it("keeps the per-file map ahead of the run-global one for the caller's own class", () => {
    const table = tableWith({
      "sdk/base.py": [
        { symbolId: "SyncClientBase" },
        { symbolId: "SyncClientBase#send_request", scope: ["SyncClientBase"] },
      ],
      "sdk/own.py": [{ symbolId: "OwnClient" }, { symbolId: "OwnClient#send_request", scope: ["OwnClient"] }],
      "svc/metrics.py": [{ symbolId: "MetricsSync" }],
    });
    const ctx = ctxWith({
      table,
      classAncestors: { ...polarAncestors },
      classFieldTypes: { MetricsSync: { client: "OwnClient" } },
      classFieldTypesByClassKey: { "svc/metrics.py::MetricsSync": { client: "SyncClientBase" } },
    });
    expect(mroSelfField().attempt(sendRequest, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "sdk/own.py", targetSymbolId: "OwnClient#send_request" },
    });
  });

  it("still DROPs when the run-global channel has no entry for any class in the walk", () => {
    const ctx = ctxWith({
      table: polarTable(),
      classAncestors: { ...polarAncestors },
      classFieldTypesByClassKey: { "sdk/base.py::OtherBase": { client: "SyncClientBase" } },
    });
    expect(mroSelfField().attempt(sendRequest, ctx)).toEqual({ kind: "drop" });
  });
});

/**
 * The MEMBER half of the same walk (bd tea-rags-mcp-s2w5g). Typing the field
 * was only half the dispatch: the pass then looked `<Type>#<member>` up in the
 * symbol table VERBATIM, so a member the field's type INHERITS was invisible.
 *
 * polar's generated SDK is the measured shape. `self.client` types to
 * `SyncClientBase`, `send_request` is declared on it and resolved, and
 * `build_request` is declared on `BuildRequestMixin` — a base of
 * `SyncClientBase` in the same file — and missed 752 times, every one of them a
 * row jedi answers `BuildRequestMixin#build_request`.
 *
 * So the member is resolved the way `selfMember` and `localBinding` resolve
 * theirs: the field's type becomes a class KEY, and the C3 MRO under it decides
 * — own class first, the defining class's own spelling on a hit, an external
 * boundary before any definition a DROP, a hierarchy read to the end without
 * one a CONTINUE.
 */
describe("PythonSelfFieldSymbolResolutionStrategy — the member on the field's type", () => {
  const buildRequest: CallRef = {
    callText: "self.client.build_request(method, url)",
    receiver: "self.client",
    member: "build_request",
    startLine: 59,
  };

  /** The field's type and the class that declares the member are DIFFERENT files. */
  const sdkTable = (): InMemoryGlobalSymbolTable =>
    tableWith({
      "sdk/base.py": [{ symbolId: "SyncServiceBase" }],
      "sdk/client.py": [
        { symbolId: "SyncClientBase" },
        { symbolId: "SyncClientBase#send_request", scope: ["SyncClientBase"] },
      ],
      "sdk/mixin.py": [
        { symbolId: "BuildRequestMixin" },
        { symbolId: "BuildRequestMixin#build_request", scope: ["BuildRequestMixin"] },
      ],
      "svc/metrics.py": [{ symbolId: "MetricsSync" }],
    });

  const sdkCtx = (
    over: Partial<CtxSpec> & { readonly classAncestors: Record<string, readonly string[]> },
  ): CallContext =>
    ctxWith({
      table: sdkTable(),
      classFieldTypesByClassKey: { "sdk/base.py::SyncServiceBase": { client: "SyncClientBase" } },
      ...over,
    });

  it("resolves a member declared on a BASE of the field's type, in another file", () => {
    const ctx = sdkCtx({
      classAncestors: {
        "svc/metrics.py::MetricsSync": ["sdk.base::SyncServiceBase"],
        "sdk/client.py::SyncClientBase": ["sdk.mixin::BuildRequestMixin"],
      },
    });
    expect(mroSelfField().attempt(buildRequest, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "sdk/mixin.py", targetSymbolId: "BuildRequestMixin#build_request" },
    });
  });

  it("keeps the field type's OWN declaration ahead of the base's", () => {
    const ctx = sdkCtx({
      classAncestors: {
        "svc/metrics.py::MetricsSync": ["sdk.base::SyncServiceBase"],
        "sdk/client.py::SyncClientBase": ["sdk.mixin::BuildRequestMixin"],
      },
    });
    expect(mroSelfField().attempt(sendRequest, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "sdk/client.py", targetSymbolId: "SyncClientBase#send_request" },
    });
  });

  it("DROPs when the field type's hierarchy leaves the project before the member", () => {
    const ctx = sdkCtx({
      classAncestors: {
        "svc/metrics.py::MetricsSync": ["sdk.base::SyncServiceBase"],
        "sdk/client.py::SyncClientBase": ["httpx::Client"],
      },
    });
    expect(mroSelfField().attempt(buildRequest, ctx)).toEqual({ kind: "drop" });
  });

  it("CONTINUEs when the hierarchy is read to the end and declares the member nowhere", () => {
    const ctx = sdkCtx({
      classAncestors: { "svc/metrics.py::MetricsSync": ["sdk.base::SyncServiceBase"] },
    });
    expect(mroSelfField().attempt(buildRequest, ctx)).toEqual({ kind: "continue" });
  });

  it("keeps the pre-seam verbatim read for a run with no linearizer", () => {
    const ctx = ctxWith({
      table: sdkTable(),
      classFieldTypes: { MetricsSync: { client: "SyncClientBase" } },
    });
    expect(plainSelfField().attempt(sendRequest, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "sdk/client.py", targetSymbolId: "SyncClientBase#send_request" },
    });
    expect(plainSelfField().attempt(buildRequest, ctx)).toEqual({ kind: "continue" });
  });
});
