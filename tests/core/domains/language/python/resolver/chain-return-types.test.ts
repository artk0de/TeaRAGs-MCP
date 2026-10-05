/**
 * K6 Python — a member's return type carries a call CHAIN (bd
 * tea-rags-mcp-m99j1.1.16).
 *
 * The kernel `MemberReturnTypeResolver` answers what calling a member yields on
 * a nominal receiver; these cases pin that the answer reaches the call sites
 * that need it: a `self.<method>(…)` head, a local bound from a method call,
 * and a bare callee two files declare, which the caller's own import binding
 * narrows before its return fact is read.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ImportRef,
  SymbolResolutionTarget,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { pythonModuleReturnKey } from "../../../../../../src/core/domains/language/python/walker/passes/python-type-channels.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/** `symbolId` with its owner as scope, as the walk records a member. */
function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      ids.map((symbolId) => {
        const parts = symbolId.split(/[#.]/);
        return {
          symbolId,
          fqName: symbolId,
          shortName: parts[parts.length - 1],
          relPath,
          scope: parts.slice(0, -1),
        };
      }),
    );
  }
  return table;
}

const instance = (name: string): TypeRef => ({ form: "instance", name });

const call = (receiver: string, member: string, startLine = 20): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine,
});

const importOf = (importText: string, name: string): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [name],
  importedBindings: { [name]: name },
});

const resolve = (ref: CallRef, ctx: CallContext): SymbolResolutionTarget | null =>
  new PythonCallResolver().resolve(ref, ctx);

const SQL_FILES = {
  "db/models/sql/query.py": ["Query", "Query#get_compiler", "Query#run"],
  "db/models/sql/compiler.py": ["SQLCompiler", "SQLCompiler#execute_sql"],
};

describe("K6 Python — a method's return type types the next hop of a chain", () => {
  it("`query.get_compiler(using).execute_sql(x)` reaches SQLCompiler#execute_sql", () => {
    const ctx: CallContext = {
      callerFile: "db/models/sql/query.py",
      callerScope: ["Query", "run"],
      imports: [],
      symbolTable: tableWith(SQL_FILES),
      localBindings: { query: [{ line: 10, type: "Query" }] },
      structuredReturnTypes: { "Query#get_compiler": instance("SQLCompiler") },
    };
    const ref = {
      ...call("query.get_compiler(using)", "execute_sql"),
      callText: "query.get_compiler(using).execute_sql(x)",
    };
    expect(resolve(ref, ctx)?.targetSymbolId).toBe("SQLCompiler#execute_sql");
  });

  it("`self.get_compiler(using).execute_sql(x)` is a CALL on self, not a field read", () => {
    const ctx: CallContext = {
      callerFile: "db/models/sql/query.py",
      callerScope: ["Query", "run"],
      imports: [],
      symbolTable: tableWith(SQL_FILES),
      structuredReturnTypes: { "Query#get_compiler": instance("SQLCompiler") },
    };
    const ref = {
      ...call("self.get_compiler(using)", "execute_sql"),
      callText: "self.get_compiler(using).execute_sql(x)",
    };
    expect(resolve(ref, ctx)?.targetSymbolId).toBe("SQLCompiler#execute_sql");
  });
});

describe("K6 Python — a local bound from a method call", () => {
  it("`qs = self.get_dated_queryset(); qs.none()` with `-> QuerySet` reaches QuerySet#none", () => {
    const ctx: CallContext = {
      callerFile: "views/generic/dates.py",
      callerScope: ["BaseDateListView", "get_dated_items"],
      imports: [],
      symbolTable: tableWith({
        "views/generic/dates.py": [
          "BaseDateListView",
          "BaseDateListView#get_dated_queryset",
          "BaseDateListView#get_dated_items",
        ],
        "db/models/query.py": ["QuerySet", "QuerySet#none"],
      }),
      callResultBindings: { qs: [{ line: 15, callee: "self.get_dated_queryset" }] },
      structuredReturnTypes: { "BaseDateListView#get_dated_queryset": instance("QuerySet") },
    };
    expect(resolve(call("qs", "none"), ctx)?.targetSymbolId).toBe("QuerySet#none");
  });
});

describe("K6 Python — a namesake callee is narrowed by the caller's import binding", () => {
  const RUNNER_FILES = {
    "test/utils.py": ["get_runner", "DiscoverRunner", "DiscoverRunner#run_tests"],
    "contrib/gis/runner.py": ["get_runner", "GeoRunner", "GeoRunner#run_tests"],
    "core/management/commands/test.py": ["Command", "Command#handle"],
  };
  const RUNNER_RETURNS: Record<string, TypeRef> = {
    [pythonModuleReturnKey("test/utils.py", "get_runner")]: instance("DiscoverRunner"),
    [pythonModuleReturnKey("contrib/gis/runner.py", "get_runner")]: instance("GeoRunner"),
  };
  const ctxWith = (imports: ImportRef[]): CallContext => ({
    callerFile: "core/management/commands/test.py",
    callerScope: ["Command", "handle"],
    imports,
    symbolTable: tableWith(RUNNER_FILES),
    callResultBindings: { runner: [{ line: 15, callee: "get_runner" }] },
    structuredReturnTypes: RUNNER_RETURNS,
  });

  it("reads the return of the `get_runner` the caller imports", () => {
    const ctx = ctxWith([importOf("test.utils", "get_runner"), importOf("test.utils", "DiscoverRunner")]);
    expect(resolve(call("runner", "run_tests"), ctx)?.targetSymbolId).toBe("DiscoverRunner#run_tests");
  });

  it("refuses rather than guesses when no binding names either bare callee", () => {
    const resolved = resolve(call("runner", "run_tests"), ctxWith([]));
    expect(resolved?.targetSymbolId).not.toBe("GeoRunner#run_tests");
    expect(resolved?.targetSymbolId).not.toBe("DiscoverRunner#run_tests");
  });
});
