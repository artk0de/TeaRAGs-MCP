/**
 * `PythonChainTypeSymbolResolutionStrategy` (E1 seam 3, bd tea-rags-mcp-9fgdi).
 *
 * The pass reads three channels — `localBindings`, `classFieldTypes` and the
 * `structuredReturnTypes` the annotation facet emits — folds them left to right
 * through `kernel/receiver-type-propagation.ts`, and resolves the member on
 * whatever single class the fold arrives at.
 *
 * Every positive case asserts the EXACT `targetSymbolId`: "resolved" alone
 * would pass for a chain that folded to the wrong class and still found a
 * same-named member. Every negative asserts DROP vs CONTINUE explicitly,
 * because that distinction IS the precision guard — DROP cuts the call off
 * from `importMatch` / `globalShortName`, CONTINUE hands it on unchanged.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, ImportRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../../src/core/contracts/types/language.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonChainTypeSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-chain-type.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

interface Def {
  symbolId: string;
  scope?: string[];
}

function tableWith(files: Record<string, Def[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((def) => ({
        symbolId: def.symbolId,
        fqName: def.symbolId,
        shortName: def.symbolId.split(/[#.]/).pop() ?? def.symbolId,
        relPath,
        scope: def.scope ?? [],
      })),
    );
  }
  return table;
}

function strategy(): PythonChainTypeSymbolResolutionStrategy {
  return new PythonChainTypeSymbolResolutionStrategy({ mode: "strict" }, new PythonImportFileMapper());
}

const call = (receiver: string | null, member: string, startLine = 10): CallRef => ({
  callText: `${receiver ?? ""}.${member}()`,
  receiver,
  member,
  startLine,
});

interface CtxParts {
  callerScope?: string[];
  imports?: ImportRef[];
  classFieldTypes?: Record<string, Record<string, string>>;
  localBindings?: CallContext["localBindings"];
  structuredReturnTypes?: Record<string, TypeRef>;
  classExtends?: Record<string, string>;
}

function ctxWith(table: InMemoryGlobalSymbolTable, parts: CtxParts = {}): CallContext {
  return {
    callerFile: "app/caller.py",
    callerScope: parts.callerScope ?? [],
    imports: parts.imports ?? [],
    symbolTable: table,
    classFieldTypes: parts.classFieldTypes,
    localBindings: parts.localBindings,
    structuredReturnTypes: parts.structuredReturnTypes,
    classExtends: parts.classExtends,
  };
}

const instance = (name: string): TypeRef => ({ form: "instance", name });

describe("PythonChainTypeSymbolResolutionStrategy — binding then return type", () => {
  it("folds `svc.build()` to the declared return type and pins the member on it", () => {
    const table = tableWith({
      "app/caller.py": [{ symbolId: "caller" }],
      "app/svc.py": [{ symbolId: "Svc" }, { symbolId: "Svc#build", scope: ["Svc"] }],
      "app/widget.py": [{ symbolId: "Widget" }, { symbolId: "Widget#run", scope: ["Widget"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 3, type: "Svc" }] },
      structuredReturnTypes: { "Svc#build": instance("Widget") },
    });
    expect(strategy().attempt(call("svc.build()", "run"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/widget.py", targetSymbolId: "Widget#run" },
    });
  });

  it("folds `self.repo.get(id)` through the field type and the return type", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "app/repo.py": [{ symbolId: "Repo" }, { symbolId: "Repo#get", scope: ["Repo"] }],
      "app/row.py": [{ symbolId: "Row" }, { symbolId: "Row#save", scope: ["Row"] }],
    });
    const ctx = ctxWith(table, {
      callerScope: ["Svc"],
      classFieldTypes: { Svc: { repo: "Repo" } },
      structuredReturnTypes: { "Repo#get": instance("Row") },
    });
    expect(strategy().attempt(call("self.repo.get(id)", "save"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/row.py", targetSymbolId: "Row#save" },
    });
  });

  it("reads a nested owner's key `.`-joined verbatim, never re-composed with `::`", () => {
    const table = tableWith({
      "app/outer.py": [{ symbolId: "Outer" }, { symbolId: "Outer.Inner", scope: ["Outer"] }],
      "app/widget.py": [{ symbolId: "Widget" }, { symbolId: "Widget#run", scope: ["Widget"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { oi: [{ line: 1, type: "Outer.Inner" }] },
      structuredReturnTypes: { "Outer.Inner#build": instance("Widget") },
    });
    expect(strategy().attempt(call("oi.build()", "run"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/widget.py", targetSymbolId: "Widget#run" },
    });
  });

  it("resolves the member against the class the fold arrives at, up its classExtends chain", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }, { symbolId: "Svc#build", scope: ["Svc"] }],
      "app/leaf.py": [{ symbolId: "Leaf" }],
      "app/base.py": [{ symbolId: "Base" }, { symbolId: "Base#shared", scope: ["Base"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 1, type: "Svc" }] },
      structuredReturnTypes: { "Svc#build": instance("Leaf") },
      classExtends: { Leaf: "Base" },
    });
    expect(strategy().attempt(call("svc.build()", "shared"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/base.py", targetSymbolId: "Base#shared" },
    });
  });
});

describe("PythonChainTypeSymbolResolutionStrategy — a module-qualified head", () => {
  const moduleTable = (): InMemoryGlobalSymbolTable =>
    tableWith({
      "app/mod.py": [
        { symbolId: "Cls" },
        { symbolId: "Cls#run", scope: ["Cls"] },
        { symbolId: "Cls.make", scope: ["Cls"] },
      ],
      "app/widget.py": [{ symbolId: "Widget" }, { symbolId: "Widget#run", scope: ["Widget"] }],
      "app/other.py": [{ symbolId: "Other" }, { symbolId: "Other#run", scope: ["Other"] }],
    });
  const imports: ImportRef[] = [{ importText: "mod", startLine: 1 }];

  it("seeds `mod.Cls()` as an INSTANCE and reads the `#` return key", () => {
    const ctx = ctxWith(moduleTable(), {
      imports,
      structuredReturnTypes: { "Cls#make": instance("Widget"), "Cls.make": instance("Other") },
    });
    expect(strategy().attempt(call("mod.Cls().make()", "run"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/widget.py", targetSymbolId: "Widget#run" },
    });
  });

  it("seeds `mod.Cls` as a CLASS and reads the `.` return key", () => {
    const ctx = ctxWith(moduleTable(), {
      imports,
      structuredReturnTypes: { "Cls#make": instance("Other"), "Cls.make": instance("Widget") },
    });
    expect(strategy().attempt(call("mod.Cls.make()", "run"), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/widget.py", targetSymbolId: "Widget#run" },
    });
  });

  it("declines a capitalized first link when the head is not imported", () => {
    const ctx = ctxWith(moduleTable(), {
      imports: [{ importText: "elsewhere", startLine: 1 }],
      structuredReturnTypes: { "Cls#make": instance("Widget") },
    });
    expect(strategy().attempt(call("mod.Cls().make()", "run"), ctx)).toEqual({ kind: "continue" });
  });
});

describe("PythonChainTypeSymbolResolutionStrategy — position-aware binding", () => {
  it("folds the same receiver text through two different types by call line", () => {
    const table = tableWith({
      "app/a.py": [{ symbolId: "A" }, { symbolId: "A#build", scope: ["A"] }],
      "app/b.py": [{ symbolId: "B" }, { symbolId: "B#build", scope: ["B"] }],
      "app/wa.py": [{ symbolId: "WidgetA" }, { symbolId: "WidgetA#run", scope: ["WidgetA"] }],
      "app/wb.py": [{ symbolId: "WidgetB" }, { symbolId: "WidgetB#run", scope: ["WidgetB"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: {
        svc: [
          { line: 3, type: "A" },
          { line: 9, type: "B" },
        ],
      },
      structuredReturnTypes: { "A#build": instance("WidgetA"), "B#build": instance("WidgetB") },
    });
    expect(strategy().attempt(call("svc.build()", "run", 5), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/wa.py", targetSymbolId: "WidgetA#run" },
    });
    expect(strategy().attempt(call("svc.build()", "run", 11), ctx)).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/wb.py", targetSymbolId: "WidgetB#run" },
    });
  });
});

describe("PythonChainTypeSymbolResolutionStrategy — what it refuses", () => {
  it("DROPS a folded type that is not in the project rather than falling through", () => {
    const table = tableWith({ "app/svc.py": [{ symbolId: "Svc" }] });
    const ctx = ctxWith(table, {
      callerScope: ["Svc"],
      classFieldTypes: { Svc: { session: "Session" } },
    });
    const outcome = strategy().attempt(call("self.session", "query"), ctx);
    expect(outcome).toEqual({ kind: "drop" });
    expect(outcome.kind).not.toBe("continue");
  });

  it("DROPS an in-project folded type whose chain defines the member nowhere", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }, { symbolId: "Svc#build", scope: ["Svc"] }],
      "app/widget.py": [{ symbolId: "Widget" }, { symbolId: "Widget#run", scope: ["Widget"] }],
      "app/unrelated.py": [{ symbolId: "Unrelated" }, { symbolId: "Unrelated#save", scope: ["Unrelated"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 1, type: "Svc" }] },
      structuredReturnTypes: { "Svc#build": instance("Widget") },
    });
    expect(strategy().attempt(call("svc.build()", "save"), ctx)).toEqual({ kind: "drop" });
  });

  it("CONTINUEs on a builtin head with no binding — nothing was folded", () => {
    const table = tableWith({ "app/caller.py": [{ symbolId: "caller" }] });
    expect(strategy().attempt(call("d.items()", "x"), ctxWith(table))).toEqual({ kind: "continue" });
  });

  it("CONTINUEs on a union mid-chain — no fan-out, no first-member guess", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "app/a.py": [{ symbolId: "A" }, { symbolId: "A#run", scope: ["A"] }],
      "app/b.py": [{ symbolId: "B" }, { symbolId: "B#run", scope: ["B"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 1, type: "Svc" }] },
      structuredReturnTypes: {
        "Svc#build": { form: "union", members: [instance("A"), instance("B")] },
      },
    });
    expect(strategy().attempt(call("svc.build()", "run"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUEs on a container return — `list[Foo]` types the list, not an element", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "app/foo.py": [{ symbolId: "Foo" }, { symbolId: "Foo#append", scope: ["Foo"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 1, type: "Svc" }] },
      structuredReturnTypes: { "Svc#build": { form: "container", element: instance("Foo") } },
    });
    expect(strategy().attempt(call("svc.build()", "append"), ctx)).toEqual({ kind: "continue" });
  });

  it("STOPS at an unknown hop instead of fabricating past it", () => {
    const table = tableWith({
      "app/svc.py": [{ symbolId: "Svc" }],
      "app/widget.py": [{ symbolId: "Widget" }, { symbolId: "Widget#run", scope: ["Widget"] }],
    });
    const ctx = ctxWith(table, {
      localBindings: { svc: [{ line: 1, type: "Svc" }] },
      // `Svc#build` types the first hop; nothing types `tail`, so the whole
      // receiver is untyped and the later passes see the call unchanged.
      structuredReturnTypes: { "Svc#build": instance("Widget") },
    });
    expect(strategy().attempt(call("svc.build().tail()", "run"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUEs past the default hop cap of 4", () => {
    const table = tableWith({ "app/svc.py": [{ symbolId: "Svc" }] });
    const ctx = ctxWith(table, { localBindings: { a: [{ line: 1, type: "Svc" }] } });
    expect(strategy().attempt(call("a.b.c.d.e", "run"), ctx)).toEqual({ kind: "continue" });
  });

  it("CONTINUEs on a free call with no receiver", () => {
    const table = tableWith({ "app/caller.py": [{ symbolId: "caller" }] });
    expect(strategy().attempt(call(null, "helper"), ctxWith(table))).toEqual({ kind: "continue" });
  });
});
