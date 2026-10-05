/**
 * A SINGLE nominal element folded out of ANOTHER file's container or tuple
 * return is placed by the file that wrote the return (bd
 * tea-rags-mcp-m99j1.1.75), the nominal sibling of m99j1.1.70's nested unions.
 *
 * `app/factory.py` declares `def make() -> list[A]` over `from .models import
 * A`, so the recorded element is `.models::A` — spelled relative to
 * `app/factory.py`. `for x in make(): x.run()` in `app/views/handlers.py` folds
 * the loop target to that element, and the fold placed it from the CALLER's
 * file: `.models` read from `app/views/` names `app/views/models.py`, a
 * namesake module (a wrong-file edge), or no file at all (a lost placement).
 * The element is now placed where it was written:
 *
 *   - a cross-file container / tuple element lands on the declaring file's class;
 *   - a same-file container return reads exactly as before;
 *   - an element the declaring file cannot place reads exactly as before — the
 *     placement is additive, it never kills a nominal fact.
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
  table.upsertFile("app/models.py", defsOf("app/models.py", ["A", "A#run"]));
  table.upsertFile("app/factory.py", defsOf("app/factory.py", ["make", "Built", "Built#run"]));
  table.upsertFile("app/other/models.py", defsOf("app/other/models.py", ["Missing", "Missing#run"]));
  table.upsertFile(CALLER, defsOf(CALLER, ["handle", "local_make"]));
  if (callerNamesake) {
    // What `.models` names when read from the CALLER's package: a namesake module.
    table.upsertFile("app/views/models.py", defsOf("app/views/models.py", ["A", "A#run"]));
    // A namesake of the declaring file's own `Built`, in the caller's own file.
    table.upsertFile(CALLER, defsOf(CALLER, ["handle", "local_make", "Built", "Built#run"]));
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
const listOf = (element: TypeRef): TypeRef => ({ form: "container", element });

/** `x` bound by `for x in <callee>():` (line 5). */
const loopOverCall = (callee: string): Record<string, LocalBinding[]> => ({
  x: [{ line: 5, endLine: 8, type: "", valueKind: "iterationElement", sourceExpression: `${callee}()` }],
});

function crossFileCtx(returned: TypeRef, callerNamesake: boolean, imports: ImportRef[] = []): CallContext {
  return {
    callerFile: CALLER,
    callerScope: ["handle"],
    callerSymbolId: "handle",
    imports: [importOf("app.factory", "make"), ...imports],
    symbolTable: tableWith(callerNamesake),
    classAncestors: {},
    localBindings: loopOverCall("make"),
    structuredReturnTypes: { "app/factory.py::make": returned },
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

describe("PythonCallResolver — a derived nominal element is placed by the file that wrote it (m99j1.1.75)", () => {
  it("places a cross-file `-> list[A]` by the declaring file, not the caller's namesake module", () => {
    expect(committedTargets(call("x", "run"), crossFileCtx(listOf(instance(".models::A")), true))).toEqual([
      "chain:app/models.py::A#run",
    ]);
  });

  it("places a cross-file `-> list[A]` whose element the caller's scope cannot place at all", () => {
    expect(committedTargets(call("x", "run"), crossFileCtx(listOf(instance(".models::A")), false))).toEqual([
      "chain:app/models.py::A#run",
    ]);
  });

  it("places a cross-file TUPLE position — `x, _ = make()` over `-> tuple[A, Built]`", () => {
    const ctx: CallContext = {
      ...crossFileCtx({ form: "tuple", elements: [instance(".models::A"), instance("Built")] }, true),
      localBindings: {
        x: [{ line: 5, type: "", valueKind: "tupleElement", sourceExpression: "make()", tupleIndex: 0 }],
      },
    };
    expect(committedTargets(call("x", "run"), ctx)).toEqual(["chain:app/models.py::A#run"]);
  });

  it("places a BARE element the declaring file declares over the caller's own namesake", () => {
    expect(committedTargets(call("x", "run"), crossFileCtx(listOf(instance("Built")), true))).toEqual([
      "chain:app/factory.py::Built#run",
    ]);
  });

  it("reads an element the declaring file cannot place exactly as before (the caller's own import)", () => {
    const ctx = crossFileCtx(listOf(instance("Missing")), true, [importOf("app.other.models", "Missing")]);
    expect(committedTargets(call("x", "run"), ctx)).toEqual(["chain:app/other/models.py::Missing#run"]);
  });

  it("reads a same-file `-> list[A]` exactly as before", () => {
    const ctx: CallContext = {
      callerFile: CALLER,
      callerScope: ["handle"],
      callerSymbolId: "handle",
      imports: [importOf("app.models", "A")],
      symbolTable: tableWith(true),
      classAncestors: {},
      localBindings: loopOverCall("local_make"),
      structuredReturnTypes: { [`${CALLER}::local_make`]: listOf(instance("app.models::A")) },
    };
    expect(committedTargets(call("x", "run"), ctx)).toEqual(["chain:app/models.py::A#run"]);
  });
});
