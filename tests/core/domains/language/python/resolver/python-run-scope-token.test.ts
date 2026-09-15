/**
 * Python resolver memos honour the explicit `CallContext.runScope` (bd
 * tea-rags-mcp-39xca.6).
 *
 * bd 11qqk and bd z99hp moved these memos off the symbol table and onto the
 * IDENTITY of a run-global channel (`moduleReexports`, `classAncestors`). That
 * identity is not the run: `CodegraphRunState#absorb` and `#seal` mutate those
 * objects IN PLACE, and a table whose content moved without its `size()` moving
 * passes the generation stamp. A token minted per run is. These cases hold the
 * channel object AND the table size fixed and move only the token — the answer
 * for the new run must be the one a cold resolver gives.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  ModuleReexport,
  RelPath,
  ResolveRunScope,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const scope = (runSeq: number): ResolveRunScope => ({ runSeq });

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, symbolIds] of Object.entries(files)) upsert(table, relPath, symbolIds);
  return table;
}

function upsert(table: InMemoryGlobalSymbolTable, relPath: RelPath, symbolIds: readonly string[]): void {
  table.upsertFile(
    relPath,
    symbolIds.map((symbolId) => ({
      symbolId,
      fqName: symbolId,
      shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
      relPath,
      scope: [],
    })),
  );
}

function ctx(
  table: InMemoryGlobalSymbolTable,
  runScope: ResolveRunScope,
  extra: Partial<CallContext> = {},
): CallContext {
  return { callerFile: "app/views.py", callerScope: [], imports: [], symbolTable: table, runScope, ...extra };
}

describe("PythonImportFileMapper — memos are scoped by runScope", () => {
  it("re-maps an import for the next run when the pooled table moved without changing size", () => {
    const mapper = new PythonImportFileMapper();
    const table = tableWith({ "pkg/a.py": ["Thing"], "app/views.py": ["view"] });
    const first = mapper.mapImportToFile("pkg.a", "app/views.py", ctx(table, scope(1)));

    // Same table object, same size: `pkg/a.py` is gone, `pkg/c.py` arrived.
    table.removeFile("pkg/a.py");
    upsert(table, "pkg/c.py", ["Thing"]);
    const cold = new PythonImportFileMapper().mapImportToFile("pkg.a", "app/views.py", ctx(table, scope(99)));
    expect(cold).not.toEqual(first);

    expect(mapper.mapImportToFile("pkg.a", "app/views.py", ctx(table, scope(2)))).toEqual(cold);
  });

  it("re-answers resolveExportedName when the SAME channel object was re-targeted in place", () => {
    const mapper = new PythonImportFileMapper();
    const table = tableWith({
      "pkg/__init__.py": [],
      "pkg/a.py": ["Name"],
      "pkg/b.py": ["Name"],
      "app/views.py": ["view"],
    });
    const pkg: RelPath = "pkg/__init__.py";
    const channel: Record<string, readonly ModuleReexport[]> = {
      [pkg]: [{ exportedName: "Name", sourceModule: ".a", sourceName: "Name" }],
    };

    expect(mapper.resolveExportedName(pkg, "Name", ctx(table, scope(1), { moduleReexports: channel }))).toBe(
      "pkg/a.py",
    );
    // An absorb re-walk replaces the entry on the one run-global object.
    channel[pkg] = [{ exportedName: "Name", sourceModule: ".b", sourceName: "Name" }];

    expect(mapper.resolveExportedName(pkg, "Name", ctx(table, scope(2), { moduleReexports: channel }))).toBe(
      "pkg/b.py",
    );
  });
});

describe("PythonAncestorLinearizerCache — one linearizer per runScope", () => {
  const A: RelPath = "app/a.py";
  const B: RelPath = "app/b.py";
  const CHILD: RelPath = "app/child.py";
  const CHILD_KEY = `${CHILD}::Child`;

  const linearize = (cache: PythonAncestorLinearizerCache, context: CallContext): readonly string[] => {
    const linearizer = cache.for(context);
    if (linearizer === undefined) throw new Error("fixture carries no classAncestors");
    return linearizer.linearize(CHILD_KEY).order;
  };

  it("re-linearizes for the next run when the SAME ancestors object was re-parented in place", () => {
    const cache = new PythonAncestorLinearizerCache(new PythonImportFileMapper(), "strict");
    const table = tableWith({ [A]: ["A", "A#ping"], [B]: ["B", "B#ping"], [CHILD]: ["Child"] });
    const ancestors: Record<string, readonly string[]> = { [CHILD_KEY]: ["app.a::A"] };

    expect(linearize(cache, ctx(table, scope(1), { callerFile: CHILD, classAncestors: ancestors }))).toEqual([
      CHILD_KEY,
      `${A}::A`,
    ]);
    ancestors[CHILD_KEY] = ["app.b::B"];

    expect(linearize(cache, ctx(table, scope(2), { callerFile: CHILD, classAncestors: ancestors }))).toEqual([
      CHILD_KEY,
      `${B}::B`,
    ]);
  });

  it("hands every call of one runScope the same linearizer", () => {
    const cache = new PythonAncestorLinearizerCache(new PythonImportFileMapper(), "strict");
    const table = tableWith({ [A]: ["A"], [CHILD]: ["Child"] });
    const ancestors = { [CHILD_KEY]: ["app.a::A"] };
    const run = scope(1);

    const first = cache.for(ctx(table, run, { classAncestors: ancestors }));
    expect(first).toBeDefined();
    expect(cache.for(ctx(table, run, { classAncestors: ancestors }))).toBe(first);
  });
});
