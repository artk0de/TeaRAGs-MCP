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
 * bd tea-rags-mcp-4008o — a bare call to a JS/Node/browser ambient global
 * (`parseInt`, `fetch`, `setTimeout`) has no receiver, so it never reaches
 * `ECMASCRIPT_GLOBALS`' receiver-text check (case 1) or `ECMASCRIPT_BUILTIN_TYPES`'
 * receiver-type check (case 3). `calleeIsExternalLocalBinding` (case 6) only
 * classifies identifiers whose TS declaration is a local Parameter /
 * BindingElement / function-body-local VariableDeclaration — an ambient
 * global's declaration lives in `lib.es5.d.ts` / `lib.dom.d.ts` at global
 * scope, so case 6 never fires either. Before this case, these calls were
 * excluded from `resolveSuccessRate`'s denominator only when no project
 * symbol happened to share the name (lexical accident) — the day one does,
 * they silently become permanent misses. This test pins the fix: excluded by
 * CLASSIFICATION, unconditionally.
 */
describe("TSCallResolver.targetsExternalImport — bare ambient-global callable (bd tea-rags-mcp-4008o)", () => {
  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });

  it("flags a bare call to a Node/ES ambient global (parseInt(x))", () => {
    const call: CallRef = { callText: "parseInt(x)", receiver: null, member: "parseInt", startLine: 9 };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(true);
  });

  it("flags a bare call to a browser ambient global (fetch(url))", () => {
    const call: CallRef = { callText: "fetch(url)", receiver: null, member: "fetch", startLine: 9 };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(true);
  });

  it("flags a bare call to a timer ambient global (setTimeout(fn, ms))", () => {
    const call: CallRef = { callText: "setTimeout(fn, ms)", receiver: null, member: "setTimeout", startLine: 9 };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(true);
  });

  it("flags a bare converter-style call (String(x))", () => {
    const call: CallRef = { callText: "String(x)", receiver: null, member: "String", startLine: 9 };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(true);
  });

  it("does NOT flag a bare call whose member is not in the ambient vocabulary (handle(req))", () => {
    const call: CallRef = { callText: "handle(req)", receiver: null, member: "handle", startLine: 9 };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(false);
  });

  it("does NOT flag a RECEIVER-bearing call sharing an ambient-vocabulary member name (obj.fetch())", () => {
    const call: CallRef = { callText: "obj.fetch()", receiver: "obj", member: "fetch", startLine: 9 };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(false);
  });

  it("still resolves a bare call to a real project function sharing no ambient name (loadConfig())", () => {
    const call: CallRef = { callText: "loadConfig()", receiver: null, member: "loadConfig", startLine: 9 };
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/config.ts", [
      { symbolId: "loadConfig", fqName: "loadConfig", shortName: "loadConfig", relPath: "src/config.ts", scope: [] },
    ]);
    expect(resolver.resolve(call, ctx({ symbolTable }))).toEqual({
      targetRelPath: "src/config.ts",
      targetSymbolId: "loadConfig",
    });
  });
});
