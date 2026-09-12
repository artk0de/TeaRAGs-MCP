/**
 * `PythonAncestorLinearizerCache` must hand each RUN its own linearizer (bd
 * tea-rags-mcp-z99hp).
 *
 * Same two production lifetimes bead tea-rags-mcp-11qqk pinned for the import
 * mapper, one layer up. `LanguageFactory.create` caches the provider, so
 * `PythonCallResolver`'s single cache — and the chain-factory default beside it
 * — lives as long as the factory; `GraphDbClientPool` keeps ONE
 * `GlobalSymbolTable` per collection for the pool's lifetime. The cache was
 * keyed by that table's IDENTITY and captured the whole `CallContext` it was
 * first handed, while the kernel linearizer memoises every top-level
 * linearization against the ctx it was built with. So run N+1 against a pooled
 * table got run N's linearizer: every MRO was merged from run N's
 * `classAncestors`, and a class whose base list had changed kept its old order
 * for member lookup, `super()`, the cls-member arm and the cone fold.
 *
 * `ctx.classAncestors` is what a run IS on this axis. It is `state.ancestors`
 * (`CallEdgeResolutionRunner#buildResolverInputs`), `CodegraphRunState`
 * reassigns the object at every reset and seal site — including the narrow
 * `drainMetrics` branch that deliberately leaves `moduleReexports` standing —
 * and the one object reaches every call of the run. Keying on its identity is
 * the shape `PythonNamingConventionSymbolResolutionStrategy#descendantsOf`
 * already uses for the same channel.
 *
 * The table and its `size()` still stamp the entry, because resolving a base
 * SPELLING goes through symbol-table membership (`lookupPythonSymbolsByShortName`,
 * `pythonClassKeyIsDeclared`, the import mapper per hop): a cold pass-1 refusal
 * is memoised inside the linearizer and must not outlive the growth that turns
 * it into a hit.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, RelPath } from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const A: RelPath = "app/a.py";
const B: RelPath = "app/b.py";
const CHILD: RelPath = "app/child.py";
/** The class under test, addressed the way the run keys classes. */
const CHILD_KEY = `${CHILD}::Child`;

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, symbolIds] of Object.entries(files)) {
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
  return table;
}

/**
 * Two candidate bases in two files, both declaring `ping`. Which one the MRO
 * ends on is therefore decided by `classAncestors` alone — the axis under test.
 */
const twoBaseTable = (): InMemoryGlobalSymbolTable =>
  tableWith({ [A]: ["A", "A#ping"], [B]: ["B", "B#ping"], [CHILD]: ["Child"] });

/** `class Child(<base>)`, the base spelled the way the walker qualifies it. */
const inheritingFrom = (moduleText: string, className: string): Record<string, readonly string[]> => ({
  [CHILD_KEY]: [`${moduleText}::${className}`],
});

function ctxWith(table: InMemoryGlobalSymbolTable, classAncestors?: Record<string, readonly string[]>): CallContext {
  return {
    callerFile: CHILD,
    callerScope: ["Child"],
    imports: [],
    symbolTable: table,
    ...(classAncestors === undefined ? {} : { classAncestors }),
  };
}

function cache(): PythonAncestorLinearizerCache {
  return new PythonAncestorLinearizerCache(new PythonImportFileMapper(), "strict");
}

/** The order `classKey` linearizes to under `ctx`, through the cache. */
function order(linearizers: PythonAncestorLinearizerCache, ctx: CallContext, classKey = CHILD_KEY): readonly string[] {
  const linearizer = linearizers.for(ctx);
  if (linearizer === undefined) throw new Error("fixture carries no classAncestors");
  return linearizer.linearize(classKey).order;
}

describe("PythonAncestorLinearizerCache — one linearizer per RUN, not per symbol table", () => {
  it("re-linearizes when the next run re-parents the class, one table throughout", () => {
    const linearizers = cache();
    // ONE table object, one size: only the run-global channel's identity moves.
    const table = twoBaseTable();

    expect(order(linearizers, ctxWith(table, inheritingFrom("app.a", "A")))).toEqual([CHILD_KEY, `${A}::A`]);
    expect(order(linearizers, ctxWith(table, inheritingFrom("app.b", "B")))).toEqual([CHILD_KEY, `${B}::B`]);
  });

  it("answers a class the next run stopped recording a hierarchy for as a singleton", () => {
    const linearizers = cache();
    const table = twoBaseTable();

    expect(order(linearizers, ctxWith(table, inheritingFrom("app.a", "A")))).toEqual([CHILD_KEY, `${A}::A`]);
    // The run records no bases for `Child` at all — a real leaf, not last run's
    // parent still standing.
    expect(order(linearizers, ctxWith(table, {}))).toEqual([CHILD_KEY]);
  });

  it("keeps two interleaved runs apart rather than overwriting one slot", () => {
    const linearizers = cache();
    const table = twoBaseTable();
    const runA = inheritingFrom("app.a", "A");
    const runB = inheritingFrom("app.b", "B");

    expect(order(linearizers, ctxWith(table, runA))).toEqual([CHILD_KEY, `${A}::A`]);
    expect(order(linearizers, ctxWith(table, runB))).toEqual([CHILD_KEY, `${B}::B`]);
    // Back to the first channel: its own answer, not the one just handed out.
    expect(order(linearizers, ctxWith(table, runA))).toEqual([CHILD_KEY, `${A}::A`]);
  });

  it("hands the SAME linearizer to every call of one run", () => {
    const linearizers = cache();
    const table = twoBaseTable();
    const ancestors = inheritingFrom("app.a", "A");
    const ctx = ctxWith(table, ancestors);

    const first = linearizers.for(ctx);
    expect(first).toBeDefined();
    // The same context object, and then a DIFFERENT context object carrying the
    // same channel — every call site of a run gets its own `CallContext`
    // literal around the one `state.ancestors`. Both are the same run, and the
    // memo decision 7 rests on is the object being identical.
    expect(linearizers.for(ctx)).toBe(first);
    expect(linearizers.for(ctxWith(table, ancestors))).toBe(first);
  });

  it("re-linearizes when the TABLE grows mid-run, channel identity unchanged", () => {
    const linearizers = cache();
    // Pass 1 is cold: the file the base names holds no definition yet, so the
    // spelling cannot be pinned and the MRO stops at the class itself.
    const table = tableWith({ [CHILD]: ["Child"] });
    const ancestors = inheritingFrom("app.a", "A");
    const ctx = ctxWith(table, ancestors);

    expect(order(linearizers, ctx)).toEqual([CHILD_KEY]);

    table.upsertFile(A, [{ symbolId: "A", fqName: "A", shortName: "A", relPath: A, scope: [] }]);
    expect(order(linearizers, ctx)).toEqual([CHILD_KEY, `${A}::A`]);
  });

  it("keeps two tables apart under one channel object", () => {
    const linearizers = cache();
    const ancestors = inheritingFrom("app.a", "A");

    expect(order(linearizers, ctxWith(twoBaseTable(), ancestors))).toEqual([CHILD_KEY, `${A}::A`]);
    // Same channel, a table that declares no `A` — and a different size, so the
    // answer cannot come from the first table's generation.
    expect(order(linearizers, ctxWith(tableWith({ [CHILD]: ["Child"] }), ancestors))).toEqual([CHILD_KEY]);
  });

  it("still answers `undefined` for a run carrying no `classAncestors` at all", () => {
    const linearizers = cache();
    expect(linearizers.for(ctxWith(twoBaseTable()))).toBeUndefined();
    expect(linearizers.linearizationFallbacks).toBe(0);
  });

  it("reports the fallback count of the run last handed out, not the first one", () => {
    const linearizers = cache();
    // Z(X, Y), X(A, B), Y(B, A) — the inconsistent hierarchy Python itself
    // refuses. A lookup still has to answer, so the DFS fallback does, and the
    // policy counts it. Same-file bases are spelled BARE.
    const table = tableWith({ "x.py": ["Z", "X", "Y", "A", "B"] });
    const inconsistent = {
      "x.py::Z": ["X", "Y"],
      "x.py::X": ["A", "B"],
      "x.py::Y": ["B", "A"],
    };
    const ctxInconsistent: CallContext = {
      callerFile: "x.py",
      callerScope: ["Z"],
      imports: [],
      symbolTable: table,
      classAncestors: inconsistent,
    };
    expect(order(linearizers, ctxInconsistent, "x.py::Z")).toEqual([
      "x.py::Z",
      "x.py::X",
      "x.py::A",
      "x.py::B",
      "x.py::Y",
    ]);
    expect(linearizers.linearizationFallbacks).toBe(1);

    // The next run over the same pooled table is consistent, so its own counter
    // is zero. Reporting the previous run's 1 here is what made the gate's
    // headline a number about a run that had already ended.
    const consistent = { "x.py::Z": ["X"], "x.py::X": ["A"] };
    const ctxConsistent: CallContext = { ...ctxInconsistent, classAncestors: consistent };
    expect(order(linearizers, ctxConsistent, "x.py::Z")).toEqual(["x.py::Z", "x.py::X", "x.py::A"]);
    expect(linearizers.linearizationFallbacks).toBe(0);
  });
});
