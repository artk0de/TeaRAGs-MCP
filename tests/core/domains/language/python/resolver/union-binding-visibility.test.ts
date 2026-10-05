/**
 * A union-annotated parameter or local the resolver cannot read is ABSENCE of
 * evidence (bd tea-rags-mcp-m99j1.1.30 regression).
 *
 * httpx's `_build_request(…, timeout: TimeoutTypes | UseClientDefault)` names a
 * project TYPE ALIAS no reader can place. Published as a union binding it was
 * killed by the resolver — and still counted as a fact everywhere a binding's
 * PRESENCE is read, so the naming-convention guess that used to land
 * `timeout.as_dict()` on `Timeout#as_dict` declined. An arm that places to a
 * LIBRARY / builtin class is different: it is evidence the receiver is not a
 * project class, and polar's `template: Template | str` (jinja) must stay
 * unfanned.
 *
 * Production hands every reader the chunk's bindings through
 * `PythonCallResolver#visibleLocalBindings`; these tests read the same way.
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
TABLE.upsertFile("httpx/_config.py", defsOf("httpx/_config.py", ["Timeout", "Timeout#as_dict"]));
TABLE.upsertFile("httpx/_types.py", defsOf("httpx/_types.py", ["primitive_value_to_str"]));
TABLE.upsertFile(
  "httpx/_client.py",
  defsOf("httpx/_client.py", ["UseClientDefault", "BaseClient", "BaseClient#_build_request"]),
);
TABLE.upsertFile(
  "polar/modals.py",
  defsOf("polar/modals.py", ["Modal", "Modal#render", "Template", "Template#render"]),
);

const instance = (name: string): TypeRef => ({ form: "instance", name });
const union = (...members: TypeRef[]): TypeRef => ({ form: "union", members });

const importOf = (importText: string, name: string): ImportRef => ({
  importText,
  startLine: 1,
  importedNames: [name],
  importedBindings: { [name]: name },
});

const UNKNOWN_ALIAS = instance("._types::TimeoutTypes");
const PROJECT_CLASS = instance("UseClientDefault");
const LIBRARY_CLASS = instance("jinja2::Template");
const BUILTIN = instance("str");

function ctxBinding(name: string, typeRef: TypeRef): CallContext {
  const binding: LocalBinding = { line: 5, type: "", typeRef };
  return {
    callerFile: "httpx/_client.py",
    callerScope: ["BaseClient", "_build_request"],
    imports: [importOf("._config", "Timeout"), importOf("._types", "TimeoutTypes"), importOf("jinja2", "Template")],
    symbolTable: TABLE,
    classAncestors: {},
    localBindings: { [name]: [binding] },
  };
}

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 10,
});

/** The context every production reader sees: the chunk's bindings as the resolver exposes them. */
function asProductionReads(resolver: PythonCallResolver, ctx: CallContext): CallContext {
  return { ...ctx, localBindings: resolver.visibleLocalBindings(ctx.localBindings, ctx) };
}

function dispatchTargets(resolver: PythonCallResolver, c: CallRef, ctx: CallContext): (string | null)[] {
  const outcome = resolver.resolveDispatch(c, ctx);
  return outcome.kind === "edges" ? outcome.edges.map((e) => e.targetSymbolId) : [];
}

describe("PythonCallResolver#visibleLocalBindings — an unreadable union binding is no fact (m99j1.1.30)", () => {
  it("lets namingConvention land `timeout.as_dict()` on `Timeout#as_dict` past `timeout: TimeoutTypes | UseClientDefault`", () => {
    const resolver = new PythonCallResolver();
    const ctx = asProductionReads(resolver, ctxBinding("timeout", union(UNKNOWN_ALIAS, PROJECT_CLASS)));
    expect(ctx.localBindings?.timeout).toBeUndefined();
    expect(resolver.resolve(call("timeout", "as_dict"), ctx)).toMatchObject({
      targetRelPath: "httpx/_config.py",
      targetSymbolId: "Timeout#as_dict",
    });
  });

  it("drops only the unreadable name — the map keeps every other binding", () => {
    const resolver = new PythonCallResolver();
    const ctx = ctxBinding("timeout", union(UNKNOWN_ALIAS, PROJECT_CLASS));
    const other: LocalBinding = { line: 3, type: "Timeout" };
    const visible = resolver.visibleLocalBindings({ ...ctx.localBindings, other: [other] }, ctx);
    expect(visible).toEqual({ other: [other] });
  });

  it("keeps a union whose library arm is evidence — `template: Template | str` (jinja) never fans", () => {
    const resolver = new PythonCallResolver();
    const raw = ctxBinding("template", union(LIBRARY_CLASS, BUILTIN));
    const ctx = asProductionReads(resolver, raw);
    expect(ctx.localBindings).toBe(raw.localBindings);
    expect(dispatchTargets(resolver, call("template", "render"), ctx)).toEqual([]);
    expect(resolver.resolve(call("template", "render"), ctx)).toBeNull();
  });

  it("lets the library arm win over an unknown one — `Template | TimeoutTypes` stays a killing fact", () => {
    const resolver = new PythonCallResolver();
    const raw = ctxBinding("template", union(LIBRARY_CLASS, UNKNOWN_ALIAS));
    const ctx = asProductionReads(resolver, raw);
    expect(ctx.localBindings).toBe(raw.localBindings);
    expect(dispatchTargets(resolver, call("template", "render"), ctx)).toEqual([]);
    expect(resolver.resolve(call("template", "render"), ctx)).toBeNull();
  });

  it("returns the map unchanged when every union arm places to a project class", () => {
    const resolver = new PythonCallResolver();
    const raw = ctxBinding("x", union(instance("._config::Timeout"), PROJECT_CLASS));
    expect(resolver.visibleLocalBindings(raw.localBindings, raw)).toBe(raw.localBindings);
  });
});
