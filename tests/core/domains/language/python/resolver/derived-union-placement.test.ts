/**
 * A DERIVED binding whose fold yields a multi-arm union (bd
 * tea-rags-mcp-m99j1.1.68) obeys the placed-union rules a union-annotated
 * binding obeys (m99j1.1.30, m99j1.1.65).
 *
 * `xs: list[A | B]`, then `for x in xs: x.run()` — the loop target is an
 * `iterationElement` binding the resolver folds to `A | B`. Before, that fold
 * was handed on as-is: an arm nothing could place survived as a partial union,
 * and an all-library union reached the call-site classifiers as a type. Now:
 *
 *   - a fully placeable union fans exactly as before;
 *   - one unplaceable arm kills the union, and the binding reads as an untyped
 *     derived binding — the outcome a direct union with that arm has;
 *   - a union no arm of which is a project class (`list[str | bytes]`) is
 *     EVIDENCE: resolution still reads it as a fact, the classifiers do not.
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

const TABLE = new InMemoryGlobalSymbolTable();
TABLE.upsertFile("app/models.py", defsOf("app/models.py", ["A", "A#run", "B", "B#run"]));
// A project namesake of the builtin member — what makes `x.encode()` an in-project miss.
TABLE.upsertFile("app/content.py", defsOf("app/content.py", ["Payload", "Payload#encode"]));
TABLE.upsertFile("app/handlers.py", defsOf("app/handlers.py", ["handle"]));

const importOf = (importText: string, name: string): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [name],
  importedBindings: { [name]: name },
});

const instance = (name: string): TypeRef => ({ form: "instance", name });
const union = (...members: TypeRef[]): TypeRef => ({ form: "union", members });
const listOf = (element: TypeRef): TypeRef => ({ form: "container", element });

/** `x` bound by `for x in xs:` (line 5) over `xs: list[<element>]` (line 3). */
const loopOver = (element: TypeRef): Record<string, LocalBinding[]> => ({
  xs: [{ line: 3, type: "list", typeRef: listOf(element) }],
  x: [{ line: 5, endLine: 8, type: "", valueKind: "iterationElement", sourceExpression: "xs" }],
});

/** `x: <stated>` stated outright (line 5) — the direct union the derived one must match. */
const annotated = (stated: TypeRef): Record<string, LocalBinding[]> => ({
  x: [{ line: 5, type: "", typeRef: stated }],
});

function ctxWith(localBindings: Record<string, LocalBinding[]>): CallContext {
  return {
    callerFile: "app/handlers.py",
    callerScope: [],
    callerSymbolId: "handle",
    imports: [importOf("app.models", "A"), importOf("app.models", "B")],
    symbolTable: TABLE,
    classAncestors: {},
    localBindings,
  };
}

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 7,
});

/** What the runner commits for a site: the dispatch fan when it has one, else the chain's answer. */
function committedTargets(c: CallRef, ctx: CallContext): string[] {
  const resolver = new PythonCallResolver();
  const outcome = resolver.resolveDispatch(c, ctx);
  if (outcome.kind === "edges" && outcome.edges.length > 0) {
    return outcome.edges.map((e) => `${e.edgeKind}:${e.targetSymbolId}@${e.confidence}`);
  }
  const target = resolver.resolve(c, ctx);
  return target === null ? [] : [`chain:${target.targetSymbolId}`];
}

describe("PythonCallResolver — a derived union fold obeys the placed-union rules (m99j1.1.68)", () => {
  it("fans a fully placeable derived union exactly as before — `for x in xs: list[A | B]`", () => {
    const ctx = ctxWith(loopOver(union(instance("A"), instance("B"))));
    expect(committedTargets(call("x", "run"), ctx)).toEqual(["cone:A#run@0.5", "cone:B#run@0.5"]);
  });

  it("kills a derived union one arm of which nothing places — no partial fan onto the placeable arm", () => {
    const derived = ctxWith(loopOver(union(instance("A"), instance("Unknown"))));
    expect(committedTargets(call("x", "run"), derived)).toEqual([]);
  });

  it("answers a dead derived union exactly as the direct union with the same arms", () => {
    const stated = union(instance("A"), instance("Unknown"));
    const derived = ctxWith(loopOver(stated));
    const direct = ctxWith(annotated(stated));
    expect(committedTargets(call("x", "run"), derived)).toEqual(committedTargets(call("x", "run"), direct));
  });

  it("hides an all-builtin derived union from the classifiers — `for value in xs: list[str | bytes]`", () => {
    const resolver = new PythonCallResolver();
    const raw = ctxWith(loopOver(union(instance("str"), instance("bytes"))));
    const site = call("x", "encode");
    // Resolution still reads the binding as evidence …
    expect(resolver.visibleLocalBindings(raw.localBindings, raw)).toBe(raw.localBindings);
    expect(resolver.targetsCoreAmbiguousMember(site, raw)).toBe(false);
    // … the classifiers read no binding, exactly as for the direct union.
    const classified = resolver.classifierLocalBindings(raw.localBindings, raw);
    expect(classified?.x).toBeUndefined();
    expect(classified?.xs).toEqual(raw.localBindings?.xs);
    expect(resolver.targetsCoreAmbiguousMember(site, { ...raw, localBindings: classified })).toBe(true);
  });

  it("keeps a placeable derived union, and an unplaceable one, in the classifier bindings", () => {
    const resolver = new PythonCallResolver();
    const placeable = ctxWith(loopOver(union(instance("A"), instance("B"))));
    expect(resolver.classifierLocalBindings(placeable.localBindings, placeable)).toBe(placeable.localBindings);
    // An unplaceable arm is absence of evidence: the binding stays an untyped derived binding.
    const unplaceable = ctxWith(loopOver(union(instance("A"), instance("Unknown"))));
    expect(resolver.classifierLocalBindings(unplaceable.localBindings, unplaceable)).toBe(unplaceable.localBindings);
  });
});
