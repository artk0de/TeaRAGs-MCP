/**
 * A field assigned from a CALL, folded ONE level at resolve time (bd
 * tea-rags-mcp-w205u, E4.6c).
 *
 * The walker records the callee SPELLING because it cannot know what the callee
 * returns; `structuredReturnTypes` is run-global and only the resolver holds
 * it. Three spellings, three reads, and no fourth: a bare function
 * (`get_geo_provider`), a class-form call on a project class
 * (`PaymentRepository.from_session`, whose `-> Self` names the RECEIVER class),
 * and `self.<method>` (`self._init_transport`), whose receiving class is the
 * one being walked.
 *
 * One level, per decision 3 of the plan. A callee whose own return type is
 * itself only knowable from another call is silence, not a worklist.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../../src/core/contracts/types/language.js";
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

function selfField(): PythonSelfFieldSymbolResolutionStrategy {
  const mapper = new PythonImportFileMapper();
  return new PythonSelfFieldSymbolResolutionStrategy(
    { mode: "strict" },
    mapper,
    new PythonAncestorLinearizerCache(mapper, "strict"),
  );
}

const instance = (name: string): TypeRef => ({ form: "instance", name });

interface CtxSpec {
  readonly table: InMemoryGlobalSymbolTable;
  readonly imports?: readonly ImportRef[];
  readonly classAncestors?: Record<string, readonly string[]>;
  readonly structuredReturnTypes?: Record<string, TypeRef>;
  readonly classFieldCallResults?: Record<string, Record<string, string>>;
  readonly classFieldTypes?: Record<string, Record<string, string>>;
}

function ctxWith(spec: CtxSpec): CallContext {
  return {
    callerFile: "app/svc.py",
    callerScope: ["Svc"],
    imports: [...(spec.imports ?? [])],
    symbolTable: spec.table,
    ...(spec.classAncestors === undefined ? {} : { classAncestors: spec.classAncestors }),
    ...(spec.structuredReturnTypes === undefined ? {} : { structuredReturnTypes: spec.structuredReturnTypes }),
    ...(spec.classFieldCallResults === undefined ? {} : { classFieldCallResults: spec.classFieldCallResults }),
    ...(spec.classFieldTypes === undefined ? {} : { classFieldTypes: spec.classFieldTypes }),
  };
}

const importOf = (importText: string, name: string): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [name],
  importedBindings: { [name]: name },
});

describe("`self.f = Cls.factory(…)` — a class-form callee returning `Self`", () => {
  const callUpdate: CallRef = {
    callText: "self.repo.update(x)",
    receiver: "self.repo",
    member: "update",
    startLine: 30,
  };

  const polar = (): CtxSpec => ({
    table: tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "repo/payment.py": [
        { symbolId: "PaymentRepository" },
        { symbolId: "PaymentRepository#update", scope: ["PaymentRepository"] },
      ],
      "repo/base.py": [
        { symbolId: "RepositoryBase" },
        { symbolId: "RepositoryBase.from_session", scope: ["RepositoryBase"] },
      ],
    }),
    imports: [importOf("repo.payment", "PaymentRepository")],
    classAncestors: { "repo/payment.py::PaymentRepository": ["repo.base::RepositoryBase"] },
    structuredReturnTypes: { "RepositoryBase.from_session": instance("Self") },
    classFieldCallResults: { "app/svc.py::Svc": { repo: "PaymentRepository.from_session" } },
  });

  it("types the field as the RECEIVER class the `-> Self` names, not the declaring one", () => {
    expect(selfField().attempt(callUpdate, ctxWith(polar()))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "repo/payment.py", targetSymbolId: "PaymentRepository#update" },
    });
  });

  it("declines when the callee carries no return fact at all", () => {
    const spec = { ...polar(), structuredReturnTypes: {} };
    expect(selfField().attempt(callUpdate, ctxWith(spec)).kind).not.toBe("resolved");
  });

  it("declines when the class head resolves outside the project", () => {
    const spec: CtxSpec = {
      ...polar(),
      imports: [importOf("sqlalchemy.orm", "Session")],
      classFieldCallResults: { "app/svc.py::Svc": { repo: "Session.from_session" } },
    };
    expect(selfField().attempt(callUpdate, ctxWith(spec)).kind).not.toBe("resolved");
  });

  it("is byte-identical on a run whose index carries no such channel", () => {
    const spec = { ...polar(), classFieldCallResults: undefined };
    expect(selfField().attempt(callUpdate, ctxWith(spec))).toEqual({ kind: "drop" });
  });

  it("never outranks a field the class TYPES — the type is the better answer", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "repo/payment.py": [
        { symbolId: "PaymentRepository" },
        { symbolId: "PaymentRepository#update", scope: ["PaymentRepository"] },
      ],
      "repo/base.py": [
        { symbolId: "RepositoryBase" },
        { symbolId: "RepositoryBase#update", scope: ["RepositoryBase"] },
        { symbolId: "RepositoryBase.from_session", scope: ["RepositoryBase"] },
      ],
    });
    const spec: CtxSpec = { ...polar(), table, classFieldTypes: { Svc: { repo: "RepositoryBase" } } };
    expect(selfField().attempt(callUpdate, ctxWith(spec))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "repo/base.py", targetSymbolId: "RepositoryBase#update" },
    });
  });
});

describe("`self.f = factory()` — a bare project function with a recorded return", () => {
  const callSend: CallRef = {
    callText: "self.provider.locate(ip)",
    receiver: "self.provider",
    member: "locate",
    startLine: 12,
  };

  const ugnest = (): CtxSpec => ({
    table: tableWith({
      "app/svc.py": [{ symbolId: "Svc" }, { symbolId: "get_geo_provider" }],
      "geo/provider.py": [{ symbolId: "GeoProvider" }, { symbolId: "GeoProvider#locate", scope: ["GeoProvider"] }],
    }),
    // Keyed by the declaring FILE since E5.1c (bd tea-rags-mcp-1v12o.1.7).
    structuredReturnTypes: { "app/svc.py::get_geo_provider": instance("GeoProvider") },
    classFieldCallResults: { "app/svc.py::Svc": { provider: "get_geo_provider" } },
  });

  it("reads the callee's own recorded return type", () => {
    expect(selfField().attempt(callSend, ctxWith(ugnest()))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "geo/provider.py", targetSymbolId: "GeoProvider#locate" },
    });
  });

  it("still answers with a SECOND def elsewhere — the caller's own file declares this one", () => {
    // SUPERSEDED by E5.1c (bd tea-rags-mcp-1v12o.1.7). The bare key made any
    // second def of the name ambiguous and the arm declined; the key names the
    // file now, and a bare call resolves against the caller's own module scope.
    const spec = ugnest();
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }, { symbolId: "get_geo_provider" }],
      "other/thing.py": [{ symbolId: "get_geo_provider" }],
      "geo/provider.py": [{ symbolId: "GeoProvider" }, { symbolId: "GeoProvider#locate", scope: ["GeoProvider"] }],
    });
    expect(selfField().attempt(callSend, ctxWith({ ...spec, table }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "geo/provider.py", targetSymbolId: "GeoProvider#locate" },
    });
  });

  it("declines when the fact belongs to a file neither the caller nor an import names", () => {
    const spec = ugnest();
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "other/thing.py": [{ symbolId: "get_geo_provider" }],
      "geo/provider.py": [{ symbolId: "GeoProvider" }, { symbolId: "GeoProvider#locate", scope: ["GeoProvider"] }],
    });
    expect(selfField().attempt(callSend, ctxWith({ ...spec, table })).kind).not.toBe("resolved");
  });
});

describe("`self.f = self.method()` — the receiving class is the one being walked", () => {
  const callHandle: CallRef = {
    callText: "self._transport.handle(req)",
    receiver: "self._transport",
    member: "handle",
    startLine: 88,
  };

  it("reads the enclosing class's own method return", () => {
    const ctx = ctxWith({
      table: tableWith({
        "app/svc.py": [{ symbolId: "Svc" }, { symbolId: "Svc#_init_transport", scope: ["Svc"] }],
        "net/transport.py": [
          { symbolId: "BaseTransport" },
          { symbolId: "BaseTransport#handle", scope: ["BaseTransport"] },
        ],
      }),
      structuredReturnTypes: { "Svc#_init_transport": instance("BaseTransport") },
      classFieldCallResults: { "app/svc.py::Svc": { _transport: "self._init_transport" } },
    });
    expect(selfField().attempt(callHandle, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "net/transport.py", targetSymbolId: "BaseTransport#handle" },
    });
  });
});
