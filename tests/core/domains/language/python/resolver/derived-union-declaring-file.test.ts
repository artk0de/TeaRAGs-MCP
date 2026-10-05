/**
 * A derived union folded out of ANOTHER file's container return is placed by
 * the file that wrote the return (bd tea-rags-mcp-m99j1.1.70).
 *
 * `app/factory.py` declares `def make() -> list[A | B]` over `from .models
 * import A, B`, so the recorded element arms are `.models::A | .models::B` —
 * spelled relative to `app/factory.py`. `for x in make(): x.run()` in
 * `app/views/handlers.py` folds the loop target to that union, and m99j1.1.68
 * placed its arms from the CALLER's file: `.models` read from `app/views/`
 * names `app/views/models.py`, a namesake module (wrong-file edges), or no file
 * at all (a lost placement). The arms are now placed where they were written:
 *
 *   - a cross-file container return fans onto the declaring file's classes;
 *   - a same-file container return reads exactly as before;
 *   - an arm the declaring file cannot place still kills the union, even when
 *     the caller's own scope would place it.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  ImportRef,
  LocalBinding,
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const defsOf = (relPath: string, symbolIds: string[]): SymbolDefinition[] =>
  symbolIds.map((symbolId) => ({
    symbolId,
    fqName: symbolId,
    shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
    relPath,
    scope: symbolId.includes("#") ? [symbolId.split("#")[0]] : [],
  }));

const CALLER = "app/views/handlers.py";

function tableWith(callerNamesake: boolean): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("app/models.py", defsOf("app/models.py", ["A", "A#run", "B", "B#run"]));
  table.upsertFile("app/factory.py", defsOf("app/factory.py", ["make"]));
  table.upsertFile(CALLER, defsOf(CALLER, ["handle", "local_make"]));
  if (callerNamesake) {
    // What `.models` names when read from the CALLER's package: a namesake module.
    table.upsertFile(
      "app/views/models.py",
      defsOf("app/views/models.py", ["A", "A#run", "B", "B#run", "Missing", "Missing#run"]),
    );
    // A second `Missing`, so nothing placed from `app/factory.py` can pick one.
    table.upsertFile("app/other/models.py", defsOf("app/other/models.py", ["Missing", "Missing#run"]));
  }
  return table;
}

const importOf = (importText: string, name: string): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [name],
  importedBindings: { [name]: name },
});

const instance = (name: string): TypeRef => ({ form: "instance", name });
const union = (...members: TypeRef[]): TypeRef => ({ form: "union", members });
const listOf = (element: TypeRef): TypeRef => ({ form: "container", element });

/** `x` bound by `for x in <callee>():` (line 5). */
const loopOverCall = (callee: string): Record<string, LocalBinding[]> => ({
  x: [{ line: 5, endLine: 8, type: "", valueKind: "iterationElement", sourceExpression: `${callee}()` }],
});

function crossFileCtx(element: TypeRef, callerNamesake: boolean): CallContext {
  return {
    callerFile: CALLER,
    callerScope: ["handle"],
    callerSymbolId: "handle",
    imports: [importOf("app.factory", "make")],
    symbolTable: tableWith(callerNamesake),
    classAncestors: {},
    localBindings: loopOverCall("make"),
    structuredReturnTypes: { "app/factory.py::make": listOf(element) },
  };
}

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 7,
});

/** What the runner commits for a site, each target with the file it lands in. */
function committedTargets(c: CallRef, ctx: CallContext): string[] {
  const resolver = new PythonCallResolver();
  const outcome = resolver.resolveDispatch(c, ctx);
  if (outcome.kind === "edges" && outcome.edges.length > 0) {
    return outcome.edges.map((e) => `${e.edgeKind}:${e.targetRelPath}::${e.targetSymbolId}@${e.confidence}`);
  }
  const target = resolver.resolve(c, ctx);
  return target === null ? [] : [`chain:${target.targetRelPath}::${target.targetSymbolId}`];
}

describe("PythonCallResolver — a derived union is placed by the file that wrote it (m99j1.1.70)", () => {
  const relativeArms = union(instance(".models::A"), instance(".models::B"));

  it("places a cross-file `-> list[A | B]` by the declaring file, not the caller's namesake module", () => {
    expect(committedTargets(call("x", "run"), crossFileCtx(relativeArms, true))).toEqual([
      "cone:app/models.py::A#run@0.5",
      "cone:app/models.py::B#run@0.5",
    ]);
  });

  it("places a cross-file `-> list[A | B]` whose arms the caller's scope cannot place at all", () => {
    expect(committedTargets(call("x", "run"), crossFileCtx(relativeArms, false))).toEqual([
      "cone:app/models.py::A#run@0.5",
      "cone:app/models.py::B#run@0.5",
    ]);
  });

  it("kills the union on an arm the declaring file cannot place, though the caller's scope would", () => {
    const arms = union(instance(".models::A"), instance(".models::Missing"));
    expect(committedTargets(call("x", "run"), crossFileCtx(arms, true))).toEqual([]);
  });

  it("places a union at a cross-file TUPLE position — `x, _ = make()` over `-> tuple[A | B, A]`", () => {
    const ctx: CallContext = {
      ...crossFileCtx(relativeArms, true),
      localBindings: {
        x: [{ line: 5, type: "", valueKind: "tupleElement", sourceExpression: "make()", tupleIndex: 0 }],
      },
      structuredReturnTypes: {
        "app/factory.py::make": { form: "tuple", elements: [relativeArms, instance(".models::A")] },
      },
    };
    expect(committedTargets(call("x", "run"), ctx)).toEqual([
      "cone:app/models.py::A#run@0.5",
      "cone:app/models.py::B#run@0.5",
    ]);
  });

  it("reads a same-file `-> list[A | B]` exactly as before", () => {
    const ctx: CallContext = {
      callerFile: CALLER,
      callerScope: ["handle"],
      callerSymbolId: "handle",
      imports: [importOf("app.models", "A"), importOf("app.models", "B")],
      symbolTable: tableWith(false),
      classAncestors: {},
      localBindings: loopOverCall("local_make"),
      structuredReturnTypes: {
        [`${CALLER}::local_make`]: listOf(union(instance("app.models::A"), instance("app.models::B"))),
      },
    };
    expect(committedTargets(call("x", "run"), ctx)).toEqual([
      "cone:app/models.py::A#run@0.5",
      "cone:app/models.py::B#run@0.5",
    ]);
  });
});
