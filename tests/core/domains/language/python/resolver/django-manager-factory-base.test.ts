/**
 * Django's `Manager` hierarchy, end to end (bd tea-rags-mcp-m99j1.1.46).
 *
 * django/db/models/manager.py declares `class Manager(BaseManager.from_queryset(QuerySet))`.
 * `from_queryset` builds a subclass of `BaseManager` carrying copies of
 * `QuerySet`'s public methods, so a verb on a manager lands on `BaseManager`
 * when it declares it (`all`, `get_queryset`) and on `QuerySet` otherwise
 * (`using`, `filter`). The model attributes are typed as `Manager` by the
 * Django vocabulary (bd .1.37); this pins the step after: the walker records
 * the factory call's two classes as Manager's bases, so the ordinary MRO
 * reaches both.
 */
import Parser from "tree-sitter";
import PyLang from "tree-sitter-python";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  FileExtraction,
  SymbolResolutionTarget,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonLanguage } from "../../../../../../src/core/domains/language/python/index.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const MANAGER = "django/db/models/manager.py";
const QUERY = "django/db/models/query.py";
const VIEWS = "app/views.py";
const DJANGO: ReadonlySet<string> = new Set(["django"]);
const FLASK_ONLY: ReadonlySet<string> = new Set(["flask"]);

const SOURCES: Record<string, readonly string[]> = {
  [MANAGER]: [
    "from django.db.models.query import QuerySet",
    "class BaseManager:",
    "    def all(self):",
    "        return self.get_queryset()",
    "    def get_queryset(self):",
    "        return QuerySet()",
    "class Manager(BaseManager.from_queryset(QuerySet)):",
    "    pass",
  ],
  [QUERY]: [
    "class QuerySet:",
    "    def all(self):",
    "        return self",
    "    def using(self, alias):",
    "        return self",
  ],
  [VIEWS]: ["def f(obj):", "    obj._default_manager.all()", '    obj._default_manager.using("x")'],
};

function walk(relPath: string, declaredDependencies: ReadonlySet<string>): FileExtraction {
  const src = (SOURCES[relPath] ?? []).join("\n");
  const parser = new Parser();
  parser.setLanguage(PyLang);
  return new PythonLanguage().walker.walk({
    tree: parser.parse(src),
    code: src,
    relPath,
    language: "python",
    chunks: [],
    declaredDependencies,
  });
}

function table(): InMemoryGlobalSymbolTable {
  const files: Record<string, readonly string[]> = {
    [MANAGER]: ["BaseManager", "BaseManager#all", "BaseManager#get_queryset", "Manager"],
    [QUERY]: ["QuerySet", "QuerySet#all", "QuerySet#using"],
    [VIEWS]: ["f"],
  };
  const out = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries(files)) {
    out.upsertFile(
      relPath,
      ids.map((symbolId) => {
        const parts = symbolId.split(/[#.]/);
        return { symbolId, fqName: symbolId, shortName: parts[parts.length - 1], relPath, scope: parts.slice(0, -1) };
      }),
    );
  }
  return out;
}

function ctxFor(declaredDependencies: ReadonlySet<string>): CallContext {
  const classAncestors: Record<string, readonly string[]> = {};
  for (const relPath of [MANAGER, QUERY]) {
    Object.assign(classAncestors, walk(relPath, declaredDependencies).classAncestors);
  }
  const views = walk(VIEWS, declaredDependencies);
  return {
    callerFile: VIEWS,
    callerScope: ["f"],
    imports: views.imports.map((i) => ({ importText: i.importText, startLine: i.startLine })),
    symbolTable: table(),
    classAncestors,
    declaredDependencies,
  };
}

function resolve(member: string, line: number, declared: ReadonlySet<string>): SymbolResolutionTarget | null {
  const receiver = "obj._default_manager";
  const ref: CallRef = { callText: `${receiver}.${member}()`, receiver, member, startLine: line };
  return new PythonCallResolver().resolve(ref, ctxFor(declared));
}

describe("Django Manager verbs through `BaseManager.from_queryset(QuerySet)` (bd tea-rags-mcp-m99j1.1.46)", () => {
  it("a verb BaseManager declares lands on BaseManager, ahead of QuerySet's namesake", () => {
    expect(resolve("all", 2, DJANGO)).toEqual({ targetRelPath: MANAGER, targetSymbolId: "BaseManager#all" });
  });

  it("a verb only QuerySet declares lands on QuerySet — from_queryset copied it onto the manager", () => {
    expect(resolve("using", 3, DJANGO)).toEqual({ targetRelPath: QUERY, targetSymbolId: "QuerySet#using" });
  });

  it("without Django the factory call names no base, so neither verb lands on the queryset", () => {
    expect(resolve("using", 3, FLASK_ONLY)).toBeNull();
  });
});
