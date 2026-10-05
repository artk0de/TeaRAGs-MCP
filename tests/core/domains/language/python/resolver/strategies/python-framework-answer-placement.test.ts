/**
 * Placing a FRAMEWORK answer (bd tea-rags-mcp-m99j1.1.45, m99j1.1.40).
 *
 * The Django vocabulary answers `_meta` with Django's `Options` and
 * `_default_manager` with Django's `Manager`. Those answers say WHERE the class
 * lives — `django.db.models.options.Options` — and are placed the way an
 * absolute import of that module is: a project file only when the corpus IS
 * Django, external everywhere else. Never by the short name through the
 * caller's imports, which both drops the edge when the framework declares two
 * namesakes (django-11039 has two `class Options`) and lets a project namesake
 * capture the hop on a corpus that merely uses Django.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { resolveTypeFile } from "../../../../../../../src/core/domains/language/python/resolver/python-type-addressing.js";
import { PythonChainTypeSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-chain-type.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, symbolIds] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      symbolIds.map((symbolId) => {
        const [owner, member] = symbolId.split("#");
        return {
          symbolId,
          fqName: symbolId,
          shortName: member ?? owner,
          relPath,
          scope: member === undefined ? [] : [owner],
        };
      }),
    );
  }
  return table;
}

function strategy(): PythonChainTypeSymbolResolutionStrategy {
  const mapper = new PythonImportFileMapper();
  return new PythonChainTypeSymbolResolutionStrategy(
    { mode: "strict" },
    mapper,
    new PythonAncestorLinearizerCache(mapper, "strict"),
  );
}

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 10,
});

function ctxWith(
  table: InMemoryGlobalSymbolTable,
  callerFile: string,
  imports: ImportRef[],
  classAncestors: Record<string, readonly string[]> = {},
): CallContext {
  return {
    callerFile,
    callerScope: ["CurrentSiteManager", "get_queryset"],
    imports,
    symbolTable: table,
    classAncestors,
  };
}

/** django-11039's shape: Django is the corpus, and it declares `Options` twice. */
const DJANGO_SELF = {
  "django/__init__.py": [],
  "django/db/__init__.py": [],
  "django/db/models/__init__.py": [],
  "django/db/models/options.py": ["Options", "Options#get_field"],
  "django/db/models/manager.py": ["Manager", "BaseManager", "BaseManager#get_queryset"],
  "django/core/cache/backends/db.py": ["Options"],
  "django/contrib/sites/managers.py": ["CurrentSiteManager", "CurrentSiteManager#get_queryset"],
};

const IMPORTS_MODELS_ONLY: ImportRef[] = [
  { importText: "django.db.models", startLine: 1, importedNames: ["models"], importedBindings: { models: "models" } },
];

describe("a framework answer is placed by its module, never by its short name", () => {
  it("places Django's Options on django-as-corpus for a caller that never imports Options (two namesakes)", () => {
    const table = tableWith(DJANGO_SELF);
    const ctx = ctxWith(table, "django/contrib/sites/managers.py", IMPORTS_MODELS_ONLY);
    expect(strategy().attempt(call("self.model._meta", "get_field"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "django/db/models/options.py", targetSymbolId: "Options#get_field" },
    });
  });

  it("the qualified spelling maps through the module, the short one still through the caller's imports", () => {
    const table = tableWith(DJANGO_SELF);
    const ctx = ctxWith(table, "django/contrib/sites/managers.py", IMPORTS_MODELS_ONLY);
    const mapper = new PythonImportFileMapper();
    expect(resolveTypeFile("django.db.models.options.Options", ctx, mapper)).toBe("django/db/models/options.py");
    expect(resolveTypeFile("Options", ctx, mapper)).toBeNull();
  });

  it("reaches an inherited member on Django's Manager through its MRO on django-as-corpus", () => {
    const table = tableWith(DJANGO_SELF);
    const ctx = ctxWith(table, "django/contrib/sites/managers.py", IMPORTS_MODELS_ONLY, {
      "django/db/models/manager.py::Manager": ["BaseManager"],
    });
    expect(strategy().attempt(call("obj._default_manager", "get_queryset"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "django/db/models/manager.py", targetSymbolId: "BaseManager#get_queryset" },
    });
  });
});

describe("a project namesake never captures a framework answer (bd tea-rags-mcp-m99j1.1.40)", () => {
  const USER_PROJECT = {
    "shop/__init__.py": [],
    "shop/managers.py": ["Manager", "Manager#get_queryset"],
    "shop/opts.py": ["Options", "Options#get_field"],
    "shop/views.py": ["CurrentSiteManager", "CurrentSiteManager#get_queryset"],
  };
  const IMPORTS_NAMESAKES: ImportRef[] = [
    ...IMPORTS_MODELS_ONLY,
    { importText: "shop.managers", startLine: 2, importedNames: ["Manager"], importedBindings: { Manager: "Manager" } },
    { importText: "shop.opts", startLine: 3, importedNames: ["Options"], importedBindings: { Options: "Options" } },
  ];

  it("Django's Manager is external, not the project's own `class Manager`", () => {
    const ctx = ctxWith(tableWith(USER_PROJECT), "shop/views.py", IMPORTS_NAMESAKES);
    expect(strategy().attempt(call("obj._default_manager", "get_queryset"), ctx)).toEqual({ kind: "drop" });
  });

  it("Django's Options is external, not the project's own `class Options` the caller imports", () => {
    const ctx = ctxWith(tableWith(USER_PROJECT), "shop/views.py", IMPORTS_NAMESAKES);
    expect(strategy().attempt(call("self.model._meta", "get_field"), ctx)).toEqual({ kind: "drop" });
  });
});
