/**
 * `PythonNamingConventionSymbolResolutionStrategy` (E2 seam 5, bd
 * tea-rags-mcp-9fgdi / 0g8g5) — R2, the one GUESS in the plan.
 *
 * `data_source.sync()` with nothing typing `data_source` is a `DataSource` by
 * the same naming discipline Ruby was measured on, and the neutral half of the
 * gate now lives in `kernel/naming-convention.ts`. What is tested here is
 * Python's end: which receiver texts the pass acts on, its three port answers,
 * and the TERMINAL — the guessed class must own the member on its own body or
 * its MRO, or nothing is emitted.
 *
 * `classAncestors: {}` is what a run with a hierarchy channel and no recorded
 * bases looks like; without the key at all there is no linearizer and the pass
 * keeps its pre-seam silence, which is its own case below.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ImportRef,
  LocalBinding,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonNamingConventionSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-naming-convention.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

type Def = string | { readonly symbolId: string; readonly scope: readonly string[] };

function tableWith(files: Record<string, readonly Def[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((def) => {
        const { symbolId, scope } = typeof def === "string" ? { symbolId: def, scope: [] as string[] } : def;
        return { symbolId, fqName: symbolId, shortName: symbolId.split(/[#.]/).pop() ?? symbolId, relPath, scope };
      }),
    );
  }
  return table;
}

interface CtxSpec {
  readonly callerFile?: string;
  readonly imports?: readonly ImportRef[];
  readonly classAncestors?: Record<string, readonly string[]>;
  readonly localBindings?: Record<string, LocalBinding[]>;
  readonly table: InMemoryGlobalSymbolTable;
}

function ctxWith(spec: CtxSpec): CallContext {
  return {
    callerFile: spec.callerFile ?? "app/handlers.py",
    callerScope: ["Handler"],
    imports: [...(spec.imports ?? [])],
    symbolTable: spec.table,
    ...(spec.classAncestors === undefined ? {} : { classAncestors: spec.classAncestors }),
    ...(spec.localBindings === undefined ? {} : { localBindings: spec.localBindings }),
  };
}

function strategy(): PythonNamingConventionSymbolResolutionStrategy {
  const mapper = new PythonImportFileMapper();
  return new PythonNamingConventionSymbolResolutionStrategy(
    { mode: "strict" },
    mapper,
    new PythonAncestorLinearizerCache(mapper, "strict"),
  );
}

const call = (receiver: string | null, member: string): CallRef => ({
  callText: `${receiver ?? ""}.${member}()`,
  receiver,
  member,
  startLine: 10,
});

/** The measured shape: a class the project declares once, named by a local nothing typed. */
const dataSourceTable = (): InMemoryGlobalSymbolTable =>
  tableWith({
    "app/models/data_source.py": ["DataSource", "DataSource#sync"],
    "app/handlers.py": ["Handler", "Handler#run"],
  });

describe("PythonNamingConventionSymbolResolutionStrategy — the guess and its gates", () => {
  it("types a bare receiver as its camelized class and pins the member", () => {
    const ctx = ctxWith({ table: dataSourceTable(), classAncestors: {} });
    expect(strategy().attempt(call("data_source", "sync"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/data_source.py", targetSymbolId: "DataSource#sync" },
    });
  });

  it("types the HEAD of an index access — polar's 46 `index` rows", () => {
    const ctx = ctxWith({ table: dataSourceTable(), classAncestors: {} });
    expect(strategy().attempt(call("data_source[0]", "sync"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/data_source.py", targetSymbolId: "DataSource#sync" },
    });
  });

  it("finds an INHERITED member on the guessed class", () => {
    const table = tableWith({
      "app/models/base.py": ["SyncBase", "SyncBase#sync"],
      "app/models/data_source.py": ["DataSource"],
      "app/handlers.py": ["Handler"],
    });
    const ctx = ctxWith({
      table,
      classAncestors: { "app/models/data_source.py::DataSource": ["app.models.base::SyncBase"] },
    });
    expect(strategy().attempt(call("data_source", "sync"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/base.py", targetSymbolId: "SyncBase#sync" },
    });
  });
});

describe("PythonNamingConventionSymbolResolutionStrategy — it declines, and it never DROPs", () => {
  const continues = (outcome: { kind: string }): void => {
    expect(outcome.kind).toBe("continue");
  };

  it("CONTINUEs when the class has subtypes — a polymorphic base carries a concrete one", () => {
    const table = tableWith({
      "app/models/data_source.py": ["DataSource", "DataSource#sync"],
      "app/models/sql.py": ["SqlSource"],
      "app/handlers.py": ["Handler"],
    });
    const ctx = ctxWith({ table, classAncestors: { "app/models/sql.py::SqlSource": ["DataSource"] } });
    continues(strategy().attempt(call("data_source", "sync"), ctx));
  });

  it("CONTINUEs when the class does not exist", () => {
    const ctx = ctxWith({ table: dataSourceTable(), classAncestors: {} });
    continues(strategy().attempt(call("mailer", "deliver"), ctx));
  });

  it("CONTINUEs when the short name is declared TWICE — Python has no Zeitwerk guarantee", () => {
    const table = tableWith({
      "app/a/data_source.py": ["DataSource", "DataSource#sync"],
      "app/b/data_source.py": ["DataSource", "DataSource#sync"],
      "app/handlers.py": ["Handler"],
    });
    continues(strategy().attempt(call("data_source", "sync"), ctxWith({ table, classAncestors: {} })));
  });

  it("CONTINUEs when the guessed class declares no such member — never a file-only edge", () => {
    const ctx = ctxWith({ table: dataSourceTable(), classAncestors: {} });
    continues(strategy().attempt(call("data_source", "refresh"), ctx));
  });

  it("CONTINUEs for a receiver in the builtin vocabulary", () => {
    const table = tableWith({ "app/kit/dict.py": ["Dict", "Dict#items"], "app/handlers.py": ["Handler"] });
    continues(strategy().attempt(call("dict", "items"), ctxWith({ table, classAncestors: {} })));
  });

  it("CONTINUEs for a receiver an EXTERNAL import bound", () => {
    const table = tableWith({ "app/http/request.py": ["Request", "Request#get_json"], "app/handlers.py": ["Handler"] });
    const ctx = ctxWith({
      table,
      classAncestors: {},
      imports: [
        { importText: "flask", startLine: 1, importedNames: ["request"], importedBindings: { request: "request" } },
      ],
    });
    continues(strategy().attempt(call("request", "get_json"), ctx));
  });

  it("CONTINUEs when a real type fact already answers — this pass speaks only for the untyped", () => {
    const ctx = ctxWith({
      table: dataSourceTable(),
      classAncestors: {},
      localBindings: { data_source: [{ line: 1, type: "Handler" }] },
    });
    continues(strategy().attempt(call("data_source", "sync"), ctx));
  });

  it("CONTINUEs on a run with no hierarchy channel — walker v2 keeps its pre-seam silence", () => {
    continues(strategy().attempt(call("data_source", "sync"), ctxWith({ table: dataSourceTable() })));
  });

  it.each([null, "self", "cls", "__cache", "DataSource", "obj.data_source", "make_source()"])(
    "CONTINUEs on receiver %o — another pass owns it",
    (receiver) => {
      continues(strategy().attempt(call(receiver, "sync"), ctxWith({ table: dataSourceTable(), classAncestors: {} })));
    },
  );

  it("never DROPs, on any of the shapes above", () => {
    const ctx = ctxWith({ table: dataSourceTable(), classAncestors: {} });
    const outcomes = [
      strategy().attempt(call("data_source", "refresh"), ctx),
      strategy().attempt(call("mailer", "deliver"), ctx),
      strategy().attempt(call("dict", "items"), ctx),
      strategy().attempt(call(null, "sync"), ctx),
    ];
    expect(outcomes.map((outcome) => outcome.kind)).not.toContain("drop");
  });
});
