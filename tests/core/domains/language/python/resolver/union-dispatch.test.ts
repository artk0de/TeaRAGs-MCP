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
