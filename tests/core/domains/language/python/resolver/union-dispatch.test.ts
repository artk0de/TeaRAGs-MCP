/**
 * K2 — Python's consumer of the kernel union-receiver cone fan-out (bd
 * tea-rags-mcp-m99j1.1.22).
 *
 * The only Python fact that carries a union with TWO reachable arms is a
 * recorded RETURN annotation (`-> A | B`, `Union[A, B]`): a `param` / `local`
 * fact is emitted only when the annotation names one nominal receiver
 * (`pythonNominalReceiverName`), and `classFieldTypes` is a bare string map. So
 * the union reaches a receiver through exactly the two folds that read return
 * facts — a call-result binding (`x = make(); x.run()`) and the chain fold
 * (`make().run()`, `self.pick().run()`) — and these tests drive both through
 * `PythonCallResolver.resolveDispatch`, the surface production reads.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ImportRef,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { pythonModuleReturnKey } from "../../../../../../src/core/domains/language/python/walker/passes/python-type-channels.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const defsOf = (relPath: string, symbolIds: string[]): SymbolDefinition[] =>
  symbolIds.map((symbolId) => ({
    symbolId,
    fqName: symbolId,
    shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
    relPath,
    scope: symbolId.includes("#") ? [symbolId.split("#")[0]] : [],
  }));

const tableWith = (files: Record<string, string[]>): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, symbolIds] of Object.entries(files)) table.upsertFile(relPath, defsOf(relPath, symbolIds));
  return table;
};

const instance = (name: string): TypeRef => ({ form: "instance", name });
const union = (...members: TypeRef[]): TypeRef => ({ form: "union", members });
const NIL: TypeRef = { form: "nil" };

const importOf = (importText: string, name: string): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [name],
  importedBindings: { [name]: name },
});

/** `A` and `B` both define `run`; `C` does not. `make` lives in its own module. */
const TABLE = tableWith({
  "app/models.py": ["A", "A#run", "B", "B#run", "C", "C#stop"],
  "app/factory.py": ["make"],
  "app/handlers.py": ["Handler", "Handler#pick", "Handler#handle"],
});

const MODEL_IMPORTS: ImportRef[] = [
  importOf("app.factory", "make"),
  importOf("app.models", "A"),
  importOf("app.models", "B"),
  importOf("app.models", "C"),
];

function ctxReturning(makeReturns: TypeRef, extra: Partial<CallContext> = {}): CallContext {
  return {
    callerFile: "app/handlers.py",
    callerScope: ["Handler", "handle"],
    imports: MODEL_IMPORTS,
    symbolTable: TABLE,
    classAncestors: {},
    structuredReturnTypes: { [pythonModuleReturnKey("app/factory.py", "make")]: makeReturns },
    ...extra,
  };
}

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 10,
});

function dispatchTargets(
  c: CallRef,
  ctx: CallContext,
): { target: string | null; kind: string | undefined; confidence: number | undefined }[] {
  const outcome = new PythonCallResolver().resolveDispatch(c, ctx);
  if (outcome.kind !== "edges") return [];
  return outcome.edges.map((e) => ({ target: e.targetSymbolId, kind: e.edgeKind, confidence: e.confidence }));
}

describe("PythonCallResolver.resolveDispatch — union receiver (K2, m99j1.1.22)", () => {
  it("fans `x = make(); x.run()` with `make -> A | B` to both arms as 1/2 cone edges", () => {
    const ctx = ctxReturning(union(instance("A"), instance("B")), {
      callResultBindings: { x: [{ callee: "make", line: 5 }] },
    });
    expect(dispatchTargets(call("x", "run"), ctx)).toEqual([
      { target: "A#run", kind: "cone", confidence: 0.5 },
      { target: "B#run", kind: "cone", confidence: 0.5 },
    ]);
  });

  it("fans a chain-folded `make().run()` receiver the same way", () => {
    const ctx = ctxReturning(union(instance("A"), instance("B")));
    expect(dispatchTargets(call("make()", "run"), ctx).map((e) => e.target)).toEqual(["A#run", "B#run"]);
  });

  it("fans `self.pick().run()` when the method's recorded return is `A | B`", () => {
    const ctx = ctxReturning(instance("A"), {
      structuredReturnTypes: { "Handler#pick": union(instance("A"), instance("B")) },
    });
    expect(dispatchTargets(call("self.pick()", "run"), ctx).map((e) => e.target)).toEqual(["A#run", "B#run"]);
  });

  it("keeps only the arms that define the member — `A | C` → one A#run edge", () => {
    const ctx = ctxReturning(union(instance("A"), instance("C")), {
      callResultBindings: { x: [{ callee: "make", line: 5 }] },
    });
    expect(dispatchTargets(call("x", "run"), ctx)).toEqual([{ target: "A#run", kind: "cone", confidence: 1 }]);
  });

  it("does not claim `Optional[A]` — the nil arm collapses it to a plain receiver", () => {
    const ctx = ctxReturning(union(instance("A"), NIL), {
      callResultBindings: { x: [{ callee: "make", line: 5 }] },
    });
    expect(dispatchTargets(call("x", "run"), ctx).every((e) => e.kind !== "cone" || e.target !== "B#run")).toBe(true);
    expect(dispatchTargets(call("x", "run"), ctx).some((e) => e.kind === "cone" && (e.confidence ?? 1) < 1)).toBe(
      false,
    );
  });

  it("does not claim a non-union receiver or an untyped one", () => {
    const typed = ctxReturning(instance("A"), { callResultBindings: { x: [{ callee: "make", line: 5 }] } });
    expect(dispatchTargets(call("x", "run"), typed).some((e) => (e.confidence ?? 1) < 1)).toBe(false);
    expect(dispatchTargets(call("y", "run"), ctxReturning(union(instance("A"), instance("B"))))).toEqual([]);
  });
});

/**
 * An INFERRED union return (bd tea-rags-mcp-m99j1.1.53): the walker unions the
 * arms of `_prepare_cursor` instead of joining them to a common ancestor, and a
 * subtype arm stays — the fan narrows by member ownership, so an override is
 * its own edge and an inherited member collapses onto the base's one.
 */
describe("PythonCallResolver.resolveDispatch — inferred subtype-arm union (m99j1.1.53)", () => {
  const UTILS = "db/backends/utils.py";
  const BASE = "db/backends/base/base.py";
  const table = tableWith({
    [UTILS]: [
      "CursorWrapper",
      "CursorWrapper#execute",
      "CursorWrapper#close",
      "CursorDebugWrapper",
      "CursorDebugWrapper#execute",
    ],
    [BASE]: ["BaseDatabaseWrapper", "BaseDatabaseWrapper#cursor", "BaseDatabaseWrapper#ensure"],
  });
  const ctx: CallContext = {
    callerFile: BASE,
    callerScope: ["BaseDatabaseWrapper", "ensure"],
    imports: [importOf("db.backends.utils", "CursorWrapper"), importOf("db.backends.utils", "CursorDebugWrapper")],
    symbolTable: table,
    classAncestors: { [`${UTILS}::CursorDebugWrapper`]: ["CursorWrapper"], [`${UTILS}::CursorWrapper`]: [] },
    structuredReturnTypes: {
      "BaseDatabaseWrapper#cursor": union(instance("CursorDebugWrapper"), instance("CursorWrapper")),
    },
  };

  it("fans `self.cursor().execute()` to the override AND the base", () => {
    expect(dispatchTargets(call("self.cursor()", "execute"), ctx)).toEqual([
      { target: "CursorDebugWrapper#execute", kind: "cone", confidence: 0.5 },
      { target: "CursorWrapper#execute", kind: "cone", confidence: 0.5 },
    ]);
  });

  it("collapses an inherited member onto the base's one edge", () => {
    expect(dispatchTargets(call("self.cursor()", "close"), ctx)).toEqual([
      { target: "CursorWrapper#close", kind: "cone", confidence: 1 },
    ]);
  });
});

/**
 * A return fact's arms are placed where the RETURN was written, not where the
 * call is (bd tea-rags-mcp-m99j1.1.55). `BaseDatabaseWrapper#cursor` lives in
 * `base/base.py`, which reaches `CursorWrapper` through `from db.backends
 * import utils`; `mysql/base.py` declares a namesake `CursorWrapper`, and a
 * sibling backend imports neither. Placing an arm by its bare name in the
 * CALLER's file fanned mysql's own class and dropped the arm elsewhere — a
 * partial union that dispatched as one confident edge.
 */
describe("PythonCallResolver — return arms placed by the declaring file (m99j1.1.55, m99j1.1.56)", () => {
  const UTILS = "db/backends/utils.py";
  const BASE = "db/backends/base/base.py";
  const MYSQL = "db/backends/mysql/base.py";
  const SQLITE = "db/backends/sqlite3/base.py";
  const table = tableWith({
    [UTILS]: [
      "CursorWrapper",
      "CursorWrapper#execute",
      "CursorWrapper#__enter__",
      "CursorDebugWrapper",
      "CursorDebugWrapper#execute",
    ],
    [BASE]: ["BaseDatabaseWrapper", "BaseDatabaseWrapper#cursor", "BaseDatabaseWrapper#make_cursor"],
    [MYSQL]: ["CursorWrapper", "CursorWrapper#execute", "DatabaseWrapper", "DatabaseWrapper#init"],
    [SQLITE]: ["DatabaseWrapper", "DatabaseWrapper#init"],
    // Packages, so the mapper can place `db.backends.*` module text.
    "db/__init__.py": ["_db"],
    "db/backends/__init__.py": ["_backends"],
    "db/backends/base/__init__.py": ["_base"],
    "db/backends/mysql/__init__.py": ["_mysql"],
    "db/backends/sqlite3/__init__.py": ["_sqlite3"],
  });
  const facts = (cursorReturns: TypeRef, extra: Partial<CallContext> = {}): Partial<CallContext> => ({
    symbolTable: table,
    imports: [importOf("db.backends.base.base", "BaseDatabaseWrapper")],
    classAncestors: {
      [`${UTILS}::CursorDebugWrapper`]: ["CursorWrapper"],
      [`${UTILS}::CursorWrapper`]: [],
      [`${MYSQL}::CursorWrapper`]: [],
      [`${MYSQL}::DatabaseWrapper`]: ["db.backends.base.base::BaseDatabaseWrapper"],
      [`${SQLITE}::DatabaseWrapper`]: ["db.backends.base.base::BaseDatabaseWrapper"],
      [`${BASE}::BaseDatabaseWrapper`]: [],
    },
    structuredReturnTypes: {
      "BaseDatabaseWrapper#cursor": cursorReturns,
      "BaseDatabaseWrapper#make_cursor": instance("db.backends.utils::CursorWrapper"),
      "CursorWrapper#__enter__": instance("Self"),
    },
    ...extra,
  });
  const ctxIn = (callerFile: string, cursorReturns: TypeRef, extra: Partial<CallContext> = {}): CallContext => ({
    callerFile,
    callerScope: ["DatabaseWrapper", "init"],
    imports: [],
    symbolTable: table,
    ...facts(cursorReturns, extra),
  });
  // As `base/base.py` publishes them: `from db.backends import utils` + `utils.CursorWrapper(…)`.
  const CURSOR_UNION = union(
    instance("db.backends.utils::CursorDebugWrapper"),
    instance("db.backends.utils::CursorWrapper"),
  );
  const fanTargets = (c: CallRef, ctx: CallContext): string[] => {
    const outcome = new PythonCallResolver().resolveDispatch(c, ctx);
    return outcome.kind === "edges" ? outcome.edges.map((e) => `${e.targetRelPath}#${e.targetSymbolId}`) : [];
  };

  it("fans to the declaring file's classes from a caller that declares a namesake", () => {
    expect(fanTargets(call("self.cursor()", "execute"), ctxIn(MYSQL, CURSOR_UNION))).toEqual([
      `${UTILS}#CursorDebugWrapper#execute`,
      `${UTILS}#CursorWrapper#execute`,
    ]);
  });

  it("fans both arms from a caller where the bare name is ambiguous", () => {
    expect(fanTargets(call("self.cursor()", "execute"), ctxIn(SQLITE, CURSOR_UNION))).toEqual([
      `${UTILS}#CursorDebugWrapper#execute`,
      `${UTILS}#CursorWrapper#execute`,
    ]);
  });

  it("kills the whole union when one arm cannot be placed from the declaring file", () => {
    const placed = instance("db.backends.utils::CursorDebugWrapper");
    // A module the run does not hold, and a module that does not declare the class.
    for (const unplaceable of [instance("db.backends.gone::Cursor"), instance("db.backends.utils::Gone")]) {
      const ctx = ctxIn(SQLITE, union(placed, unplaceable));
      expect(fanTargets(call("self.cursor()", "execute"), ctx)).toEqual([]);
      expect(new PythonCallResolver().resolve(call("self.cursor()", "execute"), ctx)).toBeNull();
    }
  });

  it("places a single-nominal member return by the declaring file too", () => {
    const target = new PythonCallResolver().resolve(call("self.make_cursor()", "execute"), ctxIn(MYSQL, CURSOR_UNION));
    expect(target).toMatchObject({ targetRelPath: UTILS, targetSymbolId: "CursorWrapper#execute" });
  });

  it("places a bare same-file arm by the declaring file when the caller declares a namesake (`return self`)", () => {
    const ctx = ctxIn(MYSQL, CURSOR_UNION, {
      localBindings: {
        c: [{ line: 9, endLine: 12, type: "", valueKind: "contextEnter", sourceExpression: "self.make_cursor()" }],
      },
    });
    ctx.structuredReturnTypes = { ...ctx.structuredReturnTypes, "CursorWrapper#__enter__": instance("CursorWrapper") };
    expect(new PythonCallResolver().resolve(call("c", "execute"), ctx)).toMatchObject({
      targetRelPath: UTILS,
      targetSymbolId: "CursorWrapper#execute",
    });
  });

  it("maps `__enter__` over every arm of a union context (`with self.cursor() as c`)", () => {
    const ctx = ctxIn(MYSQL, CURSOR_UNION, {
      localBindings: {
        c: [{ line: 9, endLine: 12, type: "", valueKind: "contextEnter", sourceExpression: "self.cursor()" }],
      },
    });
    expect(fanTargets(call("c", "execute"), ctx)).toEqual([
      `${UTILS}#CursorDebugWrapper#execute`,
      `${UTILS}#CursorWrapper#execute`,
    ]);
  });
});

describe("PythonCallResolver — a member return fact is read for the RECEIVER's class (m99j1.1.35)", () => {
  // django declares `DatabaseWrapper` in every backend; only oracle's
  // `create_cursor` carries a return fact. The run keeps the FIRST writer of the
  // bare `DatabaseWrapper#create_cursor`, so before the per-file key a
  // postgresql receiver read oracle's cursor class.
  const ORACLE = "db/backends/oracle/base.py";
  const POSTGRES = "db/backends/postgresql/base.py";
  const table = tableWith({
    [ORACLE]: [
      "DatabaseWrapper",
      "DatabaseWrapper#create_cursor",
      "DatabaseWrapper#init",
      "OracleCursor",
      "OracleCursor#execute",
    ],
    [POSTGRES]: [
      "DatabaseWrapper",
      "DatabaseWrapper#create_cursor",
      "DatabaseWrapper#init",
      "PgCursor",
      "PgCursor#execute",
    ],
  });
  const ctxIn = (callerFile: string, structuredReturnTypes: Record<string, TypeRef>): CallContext => ({
    callerFile,
    callerScope: ["DatabaseWrapper", "init"],
    imports: [],
    symbolTable: table,
    classAncestors: { [`${ORACLE}::DatabaseWrapper`]: [], [`${POSTGRES}::DatabaseWrapper`]: [] },
    structuredReturnTypes,
  });
  const resolve = (ctx: CallContext) => new PythonCallResolver().resolve(call("self.create_cursor()", "execute"), ctx);

  it("declines a namesake receiver whose own class writes no fact, instead of reading the first writer's", () => {
    const facts = {
      "DatabaseWrapper#create_cursor": instance("OracleCursor"),
      [`${ORACLE}::DatabaseWrapper#create_cursor`]: instance("OracleCursor"),
    };
    expect(resolve(ctxIn(POSTGRES, facts))).toBeNull();
    expect(resolve(ctxIn(ORACLE, facts))).toMatchObject({
      targetRelPath: ORACLE,
      targetSymbolId: "OracleCursor#execute",
    });
  });

  it("gives each namesake receiver its own class's fact when the bare key holds the other's", () => {
    const facts = {
      "DatabaseWrapper#create_cursor": instance("PgCursor"),
      [`${POSTGRES}::DatabaseWrapper#create_cursor`]: instance("PgCursor"),
      [`${ORACLE}::DatabaseWrapper#create_cursor`]: instance("OracleCursor"),
    };
    expect(resolve(ctxIn(ORACLE, facts))).toMatchObject({
      targetRelPath: ORACLE,
      targetSymbolId: "OracleCursor#execute",
    });
    expect(resolve(ctxIn(POSTGRES, facts))).toMatchObject({
      targetRelPath: POSTGRES,
      targetSymbolId: "PgCursor#execute",
    });
  });

  it("never reads a bare namesake key — it cannot say which file wrote it", () => {
    const facts = { "DatabaseWrapper#create_cursor": instance("OracleCursor") };
    expect(resolve(ctxIn(POSTGRES, facts))).toBeNull();
    expect(resolve(ctxIn(ORACLE, facts))).toBeNull();
  });
});
