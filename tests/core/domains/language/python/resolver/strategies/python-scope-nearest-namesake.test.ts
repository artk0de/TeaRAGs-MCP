/**
 * The namesake the caller's lexical scope reaches, Python's port of the
 * `kernel/lexical-scope-type.ts` gate (bd tea-rags-mcp-2m83f.32.6).
 *
 * `data_source.sync()` where the project declares `DataSource` twice used to
 * be silent: the existence gate demanded exactly one short-name match. The
 * scope chain now picks one — the enclosing frames innermost first, then the
 * caller's module, then the module's import binding for the name (one
 * re-export hop). The first scope that declares it answers; two at that level
 * stay silent, and a namesake no scope reaches stays silent.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ImportRef,
  ModuleReexport,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-import-file-mapper.js";
import { PythonNamingConventionSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-naming-convention.js";
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

const CALLER = "server/app/handlers.py";

/** Two packages each declare `DataSource` with a `sync` — the namesake pair every case starts from. */
const namesakes = (extra: Record<string, readonly Def[]> = {}): InMemoryGlobalSymbolTable =>
  tableWith({
    "server/app/__init__.py": [],
    "server/app/billing/__init__.py": [],
    "server/app/billing/sources.py": [
      { symbolId: "DataSource" },
      { symbolId: "DataSource#sync", scope: ["DataSource"] },
    ],
    "server/app/reports/__init__.py": [],
    "server/app/reports/sources.py": [
      { symbolId: "DataSource" },
      { symbolId: "DataSource#sync", scope: ["DataSource"] },
    ],
    [CALLER]: [{ symbolId: "Handler" }, { symbolId: "Handler#run", scope: ["Handler"] }],
    ...extra,
  });

interface CtxSpec {
  readonly table: InMemoryGlobalSymbolTable;
  readonly imports?: readonly ImportRef[];
  readonly callerScope?: readonly string[];
  readonly classAncestors?: Record<string, readonly string[]>;
  readonly moduleReexports?: Record<string, ModuleReexport[]>;
}

function ctxWith(spec: CtxSpec): CallContext {
  return {
    callerFile: CALLER,
    callerScope: [...(spec.callerScope ?? ["Handler", "run"])],
    imports: [...(spec.imports ?? [])],
    symbolTable: spec.table,
    classAncestors: spec.classAncestors ?? {},
    ...(spec.moduleReexports === undefined ? {} : { moduleReexports: spec.moduleReexports }),
  };
}

const importOf = (importText: string, name: string): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [name],
  importedBindings: { [name]: name },
});

function strategy(): PythonNamingConventionSymbolResolutionStrategy {
  const mapper = new PythonImportFileMapper();
  return new PythonNamingConventionSymbolResolutionStrategy(
    { mode: "strict" },
    mapper,
    new PythonAncestorLinearizerCache(mapper, "strict"),
  );
}

const syncCall: CallRef = { callText: "data_source.sync()", receiver: "data_source", member: "sync", startLine: 10 };

describe("Python naming convention — the namesake the caller's scope reaches", () => {
  it("an enclosing class frame wins over the module and the import binding", () => {
    const table = namesakes({
      [CALLER]: [
        { symbolId: "Handler" },
        { symbolId: "Handler#run", scope: ["Handler"] },
        { symbolId: "Handler.DataSource", scope: ["Handler"] },
        { symbolId: "Handler.DataSource#sync", scope: ["Handler", "DataSource"] },
        { symbolId: "DataSource" },
        { symbolId: "DataSource#sync", scope: ["DataSource"] },
      ],
    });
    const ctx = ctxWith({ table, imports: [importOf("app.billing.sources", "DataSource")] });
    expect(strategy().attempt(syncCall, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: CALLER, targetSymbolId: "Handler.DataSource#sync" },
    });
  });

  it("the caller's module wins when no enclosing frame declares the name", () => {
    const table = namesakes({
      [CALLER]: [
        { symbolId: "Handler" },
        { symbolId: "Handler#run", scope: ["Handler"] },
        { symbolId: "DataSource" },
        { symbolId: "DataSource#sync", scope: ["DataSource"] },
      ],
    });
    expect(strategy().attempt(syncCall, ctxWith({ table }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: CALLER, targetSymbolId: "DataSource#sync" },
    });
  });

  it("the module's import binding wins when neither frame nor module declares it", () => {
    const ctx = ctxWith({ table: namesakes(), imports: [importOf("app.reports.sources", "DataSource")] });
    expect(strategy().attempt(syncCall, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "server/app/reports/sources.py", targetSymbolId: "DataSource#sync" },
    });
  });

  it("an import binding through a package that re-exports the name lands on the declaring file", () => {
    const ctx = ctxWith({
      table: namesakes(),
      imports: [importOf("app.billing", "DataSource")],
      moduleReexports: {
        "server/app/billing/__init__.py": [
          { exportedName: "DataSource", sourceModule: ".sources", sourceName: "DataSource" },
        ],
      },
    });
    expect(strategy().attempt(syncCall, ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "server/app/billing/sources.py", targetSymbolId: "DataSource#sync" },
    });
  });

  it("stays silent on a same-level tie — the module declares the name twice", () => {
    const table = namesakes({
      [CALLER]: [
        { symbolId: "Handler" },
        { symbolId: "Handler#run", scope: ["Handler"] },
        { symbolId: "DataSource" },
        { symbolId: "DataSource" },
        { symbolId: "DataSource#sync", scope: ["DataSource"] },
      ],
    });
    expect(strategy().attempt(syncCall, ctxWith({ table })).kind).toBe("continue");
  });

  it("stays silent when no scope reaches a namesake — an unrelated package's import is no evidence", () => {
    const table = namesakes({ "server/app/billing/other.py": [{ symbolId: "Ledger" }] });
    const ctx = ctxWith({ table, imports: [importOf("app.billing.other", "Ledger")] });
    expect(strategy().attempt(syncCall, ctx).kind).toBe("continue");
  });

  it("the subtype gate still applies to the reached namesake", () => {
    const ctx = ctxWith({
      table: namesakes({ "server/app/reports/sql.py": [{ symbolId: "SqlSource" }] }),
      imports: [importOf("app.reports.sources", "DataSource")],
      classAncestors: { "server/app/reports/sql.py::SqlSource": ["DataSource"] },
    });
    expect(strategy().attempt(syncCall, ctx).kind).toBe("continue");
  });
});
