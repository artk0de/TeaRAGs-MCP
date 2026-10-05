/**
 * Assigned-value bindings, resolver half (bd tea-rags-mcp-m99j1.1.91). A local
 * the walker recorded as `assignedValue` holds whatever its expression
 * evaluates to, so `app = ctx.app; app.render()` resolves exactly as
 * `ctx.app.render()` would. An expression nothing types leaves the local
 * untyped — no guess, and the assigned-local gate still keeps the fan off it.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  LocalBinding,
  SymbolResolutionTarget,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      ids.map((symbolId) => {
        const parts = symbolId.split(/[#.]/);
        return { symbolId, fqName: symbolId, shortName: parts[parts.length - 1], relPath, scope: parts.slice(0, -1) };
      }),
    );
  }
  return table;
}

const assigned = (line: number, sourceExpression: string, scopeEndLine?: number): LocalBinding => ({
  line,
  type: "",
  valueKind: "assignedValue",
  sourceExpression,
  endLine: line,
  ...(scopeEndLine === undefined ? {} : { scopeEndLine }),
});

const call = (receiver: string, member: string, startLine: number): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine,
});

const FILE = "app/render.py";
const TABLE = {
  [FILE]: ["Renderer", "Renderer#run", "Context", "App", "App#render", "Widget", "Widget#render"],
};

const ctxWith = (localBindings: Record<string, LocalBinding[]>): CallContext => ({
  callerFile: FILE,
  callerScope: ["Renderer", "run"],
  imports: [],
  symbolTable: tableWith(TABLE),
  localBindings,
  classFieldTypes: { Context: { app: "App" } },
  assignedLocals: ["app", "other"],
});

const resolve = (ref: CallRef, ctx: CallContext): SymbolResolutionTarget | null =>
  new PythonCallResolver().resolve(ref, ctx);

describe("Python assigned-value bindings (m99j1.1.91) — the local holds its expression's value", () => {
  it("`app = ctx.app` off a typed parameter resolves `app.render()` through the field type", () => {
    const ctx = ctxWith({
      ctx: [{ line: 2, type: "Context" }],
      app: [assigned(3, "ctx.app")],
    });
    expect(resolve(call("app", "render", 4), ctx)?.targetSymbolId).toBe("App#render");
  });

  it("`other = app` aliases another local's type", () => {
    const ctx = ctxWith({
      app: [{ line: 2, type: "Widget" }],
      other: [assigned(3, "app")],
    });
    expect(resolve(call("other", "render", 4), ctx)?.targetSymbolId).toBe("Widget#render");
  });

  it("an expression nothing types leaves the local untyped — no edge", () => {
    const ctx = ctxWith({ app: [assigned(3, "self.unknown.thing")] });
    expect(resolve(call("app", "render", 4), ctx)).toBeNull();
  });

  it("an assigned value that folds to nothing is TRANSPARENT — the binding above it still speaks", () => {
    const ctx = ctxWith({
      app: [{ line: 2, type: "Widget" }, assigned(3, "self.unknown.thing")],
    });
    expect(resolve(call("app", "render", 4), ctx)?.targetSymbolId).toBe("Widget#render");
  });

  it("an assigned value whose type places NOWHERE is transparent too — a spelling, not a type", () => {
    const ctx: CallContext = {
      ...ctxWith({
        ctx: [{ line: 1, type: "Context" }],
        app: [{ line: 2, type: "Widget" }, assigned(3, "ctx.ghost")],
      }),
      classFieldTypes: { Context: { app: "App", ghost: "GhostAlias" } },
    };
    expect(resolve(call("app", "render", 4), ctx)?.targetSymbolId).toBe("Widget#render");
  });

  it("past its scope end (the def rebinds the name) the binding no longer speaks", () => {
    const ctx = ctxWith({
      ctx: [{ line: 2, type: "Context" }],
      app: [assigned(3, "ctx.app", 5)],
    });
    expect(resolve(call("app", "render", 6), ctx)).toBeNull();
  });

  it("an untypeable assigned value does not re-open the dynamic fan", () => {
    const resolver = new PythonCallResolver();
    const ctx = ctxWith({ app: [assigned(3, "self.unknown.thing")] });
    expect(resolver.resolveDispatch(call("app", "render", 4), ctx)).toEqual({ kind: "edges", edges: [] });
  });
});
