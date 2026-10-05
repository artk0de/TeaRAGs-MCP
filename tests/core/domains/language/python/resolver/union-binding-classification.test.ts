/**
 * A union binding that types NO project class classifies its call site exactly
 * as before m99j1.1.30 published it (bd tea-rags-mcp-m99j1.1.65).
 *
 * httpx's `_normalize_header_value(value: str | bytes, …)` then
 * `value.encode(…)`: every arm is a builtin, so the union dies and the binding
 * stays only as EVIDENCE (it keeps the dynamic fan off a project `encode`). For
 * the call-site classifiers — the receiver kind and the miss bucket — it is no
 * type, and before .1.30 the site was a `dynamic` receiver in the
 * `coreAmbiguous` bucket. Charging it as a `localVar` in-project miss moved the
 * denominator with no edge behind it.
 *
 * The runner hands the classifiers the bindings
 * `PythonCallResolver#classifierLocalBindings` keeps; these tests read the same way.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
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
// A project namesake of the builtin member — what makes the miss "in project".
TABLE.upsertFile("httpx/_content.py", defsOf("httpx/_content.py", ["Payload", "Payload#encode"]));
TABLE.upsertFile("httpx/_config.py", defsOf("httpx/_config.py", ["Timeout", "Timeout#as_dict"]));
TABLE.upsertFile("httpx/_models.py", defsOf("httpx/_models.py", ["_normalize_header_value"]));

const instance = (name: string): TypeRef => ({ form: "instance", name });
const union = (...members: TypeRef[]): TypeRef => ({ form: "union", members });

function ctxBinding(name: string, typeRef: TypeRef): CallContext {
  const binding: LocalBinding = { line: 5, type: "", typeRef };
  return {
    callerFile: "httpx/_models.py",
    callerScope: [],
    callerSymbolId: "_normalize_header_value",
    imports: [
      { importText: "._config", startLine: 1, importedNames: ["Timeout"], importedBindings: { Timeout: "Timeout" } },
    ],
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

/** The context the runner's miss classifier reads: the bindings the resolver keeps for classification. */
function asClassifierReads(resolver: PythonCallResolver, ctx: CallContext): CallContext {
  return { ...ctx, localBindings: resolver.classifierLocalBindings(ctx.localBindings, ctx) };
}

describe("PythonCallResolver#classifierLocalBindings — an all-external union is no type (m99j1.1.65)", () => {
  it("hides `value: str | bytes` from the classifiers, so `value.encode()` is a coreAmbiguous homonym again", () => {
    const resolver = new PythonCallResolver();
    const raw = ctxBinding("value", union(instance("str"), instance("bytes")));
    const site = call("value", "encode");
    // Resolution still reads the binding as evidence …
    expect(resolver.visibleLocalBindings(raw.localBindings, raw)).toBe(raw.localBindings);
    expect(resolver.targetsCoreAmbiguousMember(site, raw)).toBe(false);
    // … the classifiers read the pre-.1.30 shape.
    const classified = asClassifierReads(resolver, raw);
    expect(classified.localBindings?.value).toBeUndefined();
    expect(resolver.targetsCoreAmbiguousMember(site, classified)).toBe(true);
  });

  it("hides a library-plus-builtin union too — `template: jinja2::Template | str`", () => {
    const resolver = new PythonCallResolver();
    const raw = ctxBinding("template", union(instance("jinja2::Template"), instance("str")));
    expect(resolver.classifierLocalBindings(raw.localBindings, raw)?.template).toBeUndefined();
  });

  it("keeps a union whose every arm is a project class — it is a type, a localVar", () => {
    const resolver = new PythonCallResolver();
    const raw = ctxBinding("t", union(instance("._config::Timeout"), instance("._config::Timeout")));
    expect(resolver.classifierLocalBindings(raw.localBindings, raw)).toBe(raw.localBindings);
  });

  it("drops only the dead union — every other binding stays", () => {
    const resolver = new PythonCallResolver();
    const raw = ctxBinding("value", union(instance("str"), instance("bytes")));
    const other: LocalBinding = { line: 3, type: "Timeout" };
    const classified = resolver.classifierLocalBindings({ ...raw.localBindings, other: [other] }, raw);
    expect(classified).toEqual({ other: [other] });
  });

  it("returns the map by identity when it holds no union", () => {
    const resolver = new PythonCallResolver();
    const bindings = { t: [{ line: 3, type: "Timeout" } as LocalBinding] };
    const raw = { ...ctxBinding("x", instance("Timeout")), localBindings: bindings };
    expect(resolver.classifierLocalBindings(bindings, raw)).toBe(bindings);
  });
});
