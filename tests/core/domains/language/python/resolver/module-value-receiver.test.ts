/**
 * A module-level VALUE as a call receiver (P4, bd tea-rags-mcp-m99j1.1.15).
 *
 * `from django.apps import apps; apps.populate(x)` — `apps` is neither a symbol
 * nor a submodule; it is `apps = Apps(installed_apps=None)` in
 * `django/apps/registry.py`, re-exported by the package `__init__.py`. The
 * walker's `moduleValueTypes` says what the value holds, the import names the
 * file it came from, and the member is looked up on that class.
 *
 * The same-file shape — `connections = ConnectionHandler()` at module scope and
 * `connections.all()` inside a function of the same module — reads the same
 * channel under the caller's own file.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

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

const instance = (name: string): TypeRef => ({ form: "instance", name });

const call = (receiver: string, member: string, startLine = 10): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine,
});

const fromImport = (importText: string, name: string): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [name],
  importedBindings: { [name]: name },
});

const DJANGO = tableWith({
  "django/__init__.py": [],
  "django/apps/__init__.py": [],
  "django/apps/registry.py": [{ symbolId: "Apps" }, { symbolId: "Apps#populate", scope: ["Apps"] }],
  "django/db/__init__.py": [{ symbolId: "close_old_connections" }],
  "django/db/utils.py": [
    { symbolId: "ConnectionHandler" },
    { symbolId: "ConnectionHandler#all", scope: ["ConnectionHandler"] },
  ],
  "django/core/management/base.py": [{ symbolId: "BaseCommand" }, { symbolId: "BaseCommand#execute" }],
  // An unrelated `populate` the short-name fallback could reach for.
  "django/contrib/sites/models.py": [{ symbolId: "populate" }],
});

const MODULE_VALUES: Record<string, TypeRef> = {
  "django/apps/registry.py::apps": instance("Apps"),
  "django/db/__init__.py::connections": instance("ConnectionHandler"),
};

const REEXPORTS: CallContext["moduleReexports"] = {
  "django/apps/__init__.py": [{ exportedName: "apps", sourceModule: ".registry", sourceName: "apps" }],
};

function ctx(parts: Partial<CallContext> & Pick<CallContext, "callerFile">): CallContext {
  return {
    callerScope: [],
    imports: [],
    symbolTable: DJANGO,
    moduleValueTypes: MODULE_VALUES,
    moduleReexports: REEXPORTS,
    ...parts,
  };
}

describe("module-level value receivers", () => {
  it("resolves an imported singleton through the package re-export to its class member", () => {
    const resolver = new PythonCallResolver();
    const target = resolver.resolve(
      call("apps", "populate"),
      ctx({ callerFile: "django/core/management/base.py", imports: [fromImport("django.apps", "apps")] }),
    );
    expect(target).toEqual({ targetRelPath: "django/apps/registry.py", targetSymbolId: "Apps#populate" });
  });

  it("resolves a same-file module variable read inside a function of that module", () => {
    const resolver = new PythonCallResolver();
    const target = resolver.resolve(
      call("connections", "all"),
      ctx({
        callerFile: "django/db/__init__.py",
        callerScope: ["close_old_connections"],
        imports: [fromImport("django.db.utils", "ConnectionHandler")],
      }),
    );
    expect(target).toEqual({ targetRelPath: "django/db/utils.py", targetSymbolId: "ConnectionHandler#all" });
  });

  it("reads the class from the VALUE's file when the caller spells the class name differently", () => {
    // The caller's own `Apps` is another class: the caller-context reading of
    // the type disagrees with the anchored one, so the fold declines and the
    // import arm answers from the declaring file.
    const table = tableWith({
      "django/__init__.py": [],
      "django/apps/__init__.py": [],
      "django/apps/registry.py": [{ symbolId: "Apps" }, { symbolId: "Apps#populate", scope: ["Apps"] }],
      "other/apps.py": [{ symbolId: "Apps" }, { symbolId: "Apps#populate", scope: ["Apps"] }],
      "other/__init__.py": [],
      "tools/run.py": [{ symbolId: "main" }],
    });
    const resolver = new PythonCallResolver();
    const target = resolver.resolve(
      call("apps", "populate"),
      ctx({
        callerFile: "tools/run.py",
        symbolTable: table,
        imports: [fromImport("django.apps", "apps"), fromImport("other.apps", "Apps")],
      }),
    );
    expect(target).toEqual({ targetRelPath: "django/apps/registry.py", targetSymbolId: "Apps#populate" });
  });

  it("lets a local binding in force shadow the module value", () => {
    const resolver = new PythonCallResolver();
    const target = resolver.resolve(
      call("connections", "all"),
      ctx({
        callerFile: "django/db/__init__.py",
        localBindings: { connections: [{ line: 5, type: "BaseCommand" }] },
      }),
    );
    expect(target?.targetSymbolId).not.toBe("ConnectionHandler#all");
  });

  it("says nothing without the channel — the pre-P4 index", () => {
    const resolver = new PythonCallResolver();
    const target = resolver.resolve(
      call("apps", "populate"),
      ctx({
        callerFile: "django/core/management/base.py",
        imports: [fromImport("django.apps", "apps")],
        moduleValueTypes: undefined,
      }),
    );
    expect(target?.targetSymbolId).not.toBe("Apps#populate");
  });
});
