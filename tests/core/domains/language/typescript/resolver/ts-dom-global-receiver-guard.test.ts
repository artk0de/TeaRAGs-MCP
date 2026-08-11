import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "src/caller.ts",
  callerScope: [],
  imports: [],
  ...over,
});

/**
 * bd tea-rags-mcp-4008o (taxdome follow-up) — `ecmascript-globals.ts` covered
 * Node/ECMAScript core only, zero DOM/BOM names. A React/browser codebase
 * calls `window.*`, `document.*`, `localStorage.*`, `fetch(...)` constantly;
 * before this change every one of them fell through to a genuine resolver
 * miss (or, worse, a phantom edge to a same-named project symbol) — this is
 * the single largest measured contributor to taxdome's degraded
 * resolveSuccessRate (bareCall 0.53 vs tea-rags-mcp's own 0.98; see
 * memory `project_taxdome_ts_resolve_rate_gap.md`).
 */
describe("TSCallResolver.targetsExternalImport — DOM/BOM vocabulary (bd tea-rags-mcp-4008o)", () => {
  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });

  it("flags a receiver-text call on the BOM global `window` (window.addEventListener(t, fn))", () => {
    const call: CallRef = {
      callText: "window.addEventListener(t, fn)",
      receiver: "window",
      member: "addEventListener",
      startLine: 9,
    };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(true);
  });

  it("flags a receiver-text call on the DOM global `document` (document.querySelector(sel))", () => {
    const call: CallRef = {
      callText: "document.querySelector(sel)",
      receiver: "document",
      member: "querySelector",
      startLine: 9,
    };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(true);
  });

  it("flags a receiver-text call on `localStorage` (localStorage.getItem(k))", () => {
    const call: CallRef = {
      callText: "localStorage.getItem(k)",
      receiver: "localStorage",
      member: "getItem",
      startLine: 9,
    };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(true);
  });

  it("flags a call on a receiver typed as a DOM builtin instance (const c = new AbortController(); c.abort())", () => {
    const call: CallRef = { callText: "c.abort()", receiver: "c", member: "abort", startLine: 9 };
    const context = ctx({
      symbolTable: new InMemoryGlobalSymbolTable(),
      localBindings: { c: [{ line: 2, type: "AbortController" }] },
    });
    expect(resolver.targetsExternalImport(call, context)).toBe(true);
  });

  it("does NOT flag a receiver whose text merely CONTAINS a DOM global name (myWindow.foo())", () => {
    const call: CallRef = { callText: "myWindow.foo()", receiver: "myWindow", member: "foo", startLine: 9 };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(false);
  });

  it("still resolves a project class instance sharing no DOM/BOM name (const svc = new UserService(); svc.find(id))", () => {
    const call: CallRef = { callText: "svc.find(id)", receiver: "svc", member: "find", startLine: 9 };
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/user-service.ts", [
      {
        symbolId: "UserService#find",
        fqName: "UserService#find",
        shortName: "find",
        relPath: "src/user-service.ts",
        scope: ["UserService"],
      },
    ]);
    const context = ctx({ symbolTable, localBindings: { svc: [{ line: 2, type: "UserService" }] } });
    expect(resolver.resolve(call, context)).toEqual({
      targetRelPath: "src/user-service.ts",
      targetSymbolId: "UserService#find",
    });
  });
});
