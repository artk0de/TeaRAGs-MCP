/**
 * `PythonImportFileMapper`'s memo must not outlive the RUN that filled it (bd
 * tea-rags-mcp-11qqk).
 *
 * Two production lifetimes are longer than a run. `LanguageFactory.create`
 * caches the provider, so the resolver — and the mapper it owns — lives as long
 * as the factory; `GraphDbClientPool` keeps ONE `GlobalSymbolTable` per
 * collection for the pool's lifetime. The memo was keyed by that table and
 * invalidated only when `size()` moved, while `declarers` and `moduleAliases`
 * are computed from `ctx.moduleReexports` — a RUN-global channel
 * `CodegraphRunState` reassigns at every reset. So an `__init__.py` whose
 * re-export TARGET changed without adding or removing a symbol kept resolving
 * through the previous run's declarer, forever.
 *
 * The offline stand hit the same thing from the other side: one table served
 * both passes of `scripts/spikes/incremental-runglobal-delta.ts`, so
 * `--ablate reexp` compared the incremental run's re-export map against a cache
 * of the full run's answers and could only ever report zero.
 *
 * These tests pin the split. The run-scoped half is keyed by the IDENTITY of
 * `ctx.moduleReexports`, which is what a run is: `buildResolverInputs` hands the
 * same object to every call of one run and the next run's state holds a
 * different one. The table-scoped half — source roots and the import→file
 * answers derived from them alone — keeps its `size()` generation, because
 * nothing in it reads the context.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, ModuleReexport, RelPath } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

type ReexportChannel = Record<string, readonly ModuleReexport[]>;

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, shortNames] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      shortNames.map((shortName) => ({ symbolId: shortName, fqName: shortName, shortName, relPath, scope: [] })),
    );
  }
  return table;
}

/**
 * A package whose `__init__.py` declares nothing, over two candidate sources
 * that both declare the name. Which one the mapper answers is therefore decided
 * by the re-export channel alone — the axis under test.
 */
const PKG: RelPath = "pkg/__init__.py";

const twoSourceTable = (): InMemoryGlobalSymbolTable =>
  tableWith({
    "pkg/__init__.py": [],
    "pkg/a.py": ["Name"],
    "pkg/b.py": ["Name"],
    "app/views.py": ["view"],
  });

/** The same package over two sibling MODULES, for the alias arm. */
const twoModuleTable = (): InMemoryGlobalSymbolTable =>
  tableWith({
    "pkg/__init__.py": [],
    "pkg/_a.py": ["Widget"],
    "pkg/_b.py": ["Widget"],
    "app/views.py": ["view"],
  });

function ctxWith(table: InMemoryGlobalSymbolTable, moduleReexports?: ReexportChannel): CallContext {
  return {
    callerFile: "app/views.py",
    callerScope: [],
    imports: [],
    symbolTable: table,
    moduleReexports,
  };
}

/** `{ "pkg/__init__.py": [ <one explicit re-export of `Name` from `module`> ] }` */
const declaringVia = (module: string): ReexportChannel => ({
  [PKG]: [{ exportedName: "Name", sourceModule: module, sourceName: "Name" }],
});

/** `from . import <module> as impl` — the module-alias shape. */
const aliasingTo = (sourceName: string): ReexportChannel => ({
  [PKG]: [{ exportedName: "impl", sourceModule: ".", sourceName }],
});

/**
 * The channel wrapped in a read counter. The proxy IS the object identity the
 * run memo keys on, so counting property reads says whether the walk ran
 * without touching what it answers.
 */
function counting(record: ReexportChannel): { channel: ReexportChannel; reads: () => number } {
  let reads = 0;
  const channel = new Proxy(record, {
    get(target, prop, receiver) {
      reads += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  return { channel, reads: () => reads };
}

describe("PythonImportFileMapper — the re-export memo is scoped to one run", () => {
  it("re-answers `resolveExportedName` when the next run re-targets the re-export", () => {
    const mapper = new PythonImportFileMapper();
    // ONE table, one size, two runs: only the channel identity moves.
    const table = twoSourceTable();

    expect(mapper.resolveExportedName(PKG, "Name", ctxWith(table, declaringVia(".a")))).toBe("pkg/a.py");
    expect(mapper.resolveExportedName(PKG, "Name", ctxWith(table, declaringVia(".b")))).toBe("pkg/b.py");
  });

  it("re-answers `resolveExportedModule` when the next run re-targets the alias", () => {
    const mapper = new PythonImportFileMapper();
    const table = twoModuleTable();

    expect(mapper.resolveExportedModule(PKG, "impl", ctxWith(table, aliasingTo("_a")))).toBe("pkg/_a.py");
    expect(mapper.resolveExportedModule(PKG, "impl", ctxWith(table, aliasingTo("_b")))).toBe("pkg/_b.py");
  });

  it("re-answers a name the next run stopped re-exporting at all", () => {
    const mapper = new PythonImportFileMapper();
    const table = twoSourceTable();

    expect(mapper.resolveExportedName(PKG, "Name", ctxWith(table, declaringVia(".a")))).toBe("pkg/a.py");
    // The package now re-exports nothing: the honest answer is the refusal the
    // caller gets before the channel exists, not last run's file.
    expect(mapper.resolveExportedName(PKG, "Name", ctxWith(table, {}))).toBeNull();
  });

  it("serves a second ask of the SAME run from the memo without re-walking", () => {
    const mapper = new PythonImportFileMapper();
    const table = twoSourceTable();
    const { channel, reads } = counting(declaringVia(".a"));
    const ctx = ctxWith(table, channel);

    expect(mapper.resolveExportedName(PKG, "Name", ctx)).toBe("pkg/a.py");
    const afterFirst = reads();
    expect(afterFirst).toBeGreaterThan(0);

    // A different `CallContext` object carrying the SAME channel is the same run
    // — every call site of a run gets its own literal around one channel.
    expect(mapper.resolveExportedName(PKG, "Name", ctxWith(table, channel))).toBe("pkg/a.py");
    expect(reads()).toBe(afterFirst);
  });

  it("serves a repeat module-alias ask of the same run from the memo", () => {
    const mapper = new PythonImportFileMapper();
    const table = twoModuleTable();
    const { channel, reads } = counting(aliasingTo("_a"));

    expect(mapper.resolveExportedModule(PKG, "impl", ctxWith(table, channel))).toBe("pkg/_a.py");
    const afterFirst = reads();
    expect(afterFirst).toBeGreaterThan(0);

    expect(mapper.resolveExportedModule(PKG, "impl", ctxWith(table, channel))).toBe("pkg/_a.py");
    expect(reads()).toBe(afterFirst);
  });

  it("still re-answers when the TABLE grows mid-run, channel identity unchanged", () => {
    const mapper = new PythonImportFileMapper();
    // Pass 1 is cold: the source file the re-export names is not in the table
    // yet, so the hop misses and the mapper refuses.
    const table = tableWith({ "pkg/__init__.py": [], "app/views.py": ["view"] });
    const channel = declaringVia(".a");
    const ctx = ctxWith(table, channel);

    expect(mapper.resolveExportedName(PKG, "Name", ctx)).toBeNull();

    table.upsertFile("pkg/a.py", [
      { symbolId: "Name", fqName: "Name", shortName: "Name", relPath: "pkg/a.py", scope: [] },
    ]);
    expect(mapper.resolveExportedName(PKG, "Name", ctx)).toBe("pkg/a.py");
  });

  it("keeps two tables apart under one channel object", () => {
    const mapper = new PythonImportFileMapper();
    const channel = declaringVia(".a");

    expect(mapper.resolveExportedName(PKG, "Name", ctxWith(twoSourceTable(), channel))).toBe("pkg/a.py");
    // Same channel, a table that holds no `pkg/a.py` — and a different size, so
    // the answer cannot come from the first table's generation.
    const bare = tableWith({ "pkg/__init__.py": [], "app/views.py": ["view"] });
    expect(mapper.resolveExportedName(PKG, "Name", ctxWith(bare, channel))).toBeNull();
  });

  it("memoises a context with NO re-export channel rather than skipping the memo", () => {
    const mapper = new PythonImportFileMapper();
    const table = twoSourceTable();
    // Nothing run-dependent can leak with no channel to read, and the answers
    // must still be the pre-channel ones.
    expect(mapper.resolveExportedName(PKG, "Name", ctxWith(table))).toBeNull();
    expect(mapper.resolveExportedName("pkg/a.py", "Name", ctxWith(table))).toBe("pkg/a.py");
    expect(mapper.resolveExportedModule(PKG, "impl", ctxWith(table))).toBeNull();
  });
});
