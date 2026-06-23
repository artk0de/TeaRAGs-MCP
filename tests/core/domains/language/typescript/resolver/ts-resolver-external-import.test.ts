import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  LocalBinding,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * tea-rags-mcp-ykj7 (ykj7-a) — `targetsExternalImport` classifies an
 * UNRESOLVED call as targeting an external library / runtime (so the run-stats
 * denominator can exclude it) rather than an in-project resolver miss.
 */
describe("TSCallResolver.targetsExternalImport", () => {
  function makeCtx(
    callerFile: string,
    imports: { importText: string; startLine: number; importedNames?: string[] }[],
    symbolTable: InMemoryGlobalSymbolTable,
  ): CallContext {
    return { callerFile, callerScope: [], imports, symbolTable };
  }

  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });

  it("flags a call whose receiver binds to a `node:` import (fs.readFile)", () => {
    const call: CallRef = { callText: "fs.readFile(p)", receiver: "fs", member: "readFile", startLine: 3 };
    const ctx = makeCtx(
      "src/main.ts",
      [{ importText: "node:fs", startLine: 1, importedNames: ["fs"] }],
      new InMemoryGlobalSymbolTable(),
    );
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("flags a call whose receiver binds to a bare npm import (vitest)", () => {
    const call: CallRef = { callText: "vi.fn()", receiver: "vi", member: "fn", startLine: 3 };
    const ctx = makeCtx(
      "src/x.test.ts",
      [{ importText: "vitest", startLine: 1, importedNames: ["vi"] }],
      new InMemoryGlobalSymbolTable(),
    );
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("flags an ECMAScript ambient global with no import (Math.max)", () => {
    const call: CallRef = { callText: "Math.max(a, b)", receiver: "Math", member: "max", startLine: 3 };
    const ctx = makeCtx("src/x.ts", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("flags JSON / console ambient globals", () => {
    const ctx = makeCtx("src/x.ts", [], new InMemoryGlobalSymbolTable());
    expect(
      resolver.targetsExternalImport(
        { callText: "JSON.parse(s)", receiver: "JSON", member: "parse", startLine: 1 },
        ctx,
      ),
    ).toBe(true);
    expect(
      resolver.targetsExternalImport(
        { callText: "console.log(x)", receiver: "console", member: "log", startLine: 2 },
        ctx,
      ),
    ).toBe(true);
  });

  it("does NOT flag a receiver bound to a relative (in-project) import", () => {
    const call: CallRef = { callText: "Store.read()", receiver: "Store", member: "read", startLine: 3 };
    const ctx = makeCtx(
      "src/main.ts",
      [{ importText: "./store.js", startLine: 1, importedNames: ["Store"] }],
      new InMemoryGlobalSymbolTable(),
    );
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  it("does NOT flag an in-project miss whose receiver is neither global nor an external import (Mystery)", () => {
    const call: CallRef = { callText: "Mystery.nope()", receiver: "Mystery", member: "nope", startLine: 3 };
    const ctx = makeCtx("src/main.ts", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });
});

/**
 * Builtin-receiver-type lever — a call whose RECEIVER is typed as an ECMAScript
 * runtime builtin (`Map`, `Set`, `Promise`, typed arrays, …) targets the JS
 * runtime, not in-repo code. Like `Math.max()` / a `node:fs` import, it must be
 * `external`-skipped rather than counted as an internal resolver miss. Mirrors
 * Ruby ykj7 (Kernel/core builtins). Precision: only a CONFIDENTLY-bound builtin
 * type external-skips — an unknown / unbound receiver stays an internal miss.
 */
describe("TSCallResolver.targetsExternalImport — builtin receiver type", () => {
  function makeTypedCtx(opts: {
    callerFile?: string;
    callerScope?: string[];
    localBindings?: Record<string, LocalBinding[]>;
    classFieldTypes?: Record<string, Record<string, string>>;
    symbolTable?: InMemoryGlobalSymbolTable;
  }): CallContext {
    return {
      callerFile: opts.callerFile ?? "src/main.ts",
      callerScope: opts.callerScope ?? [],
      imports: [],
      symbolTable: opts.symbolTable ?? new InMemoryGlobalSymbolTable(),
      localBindings: opts.localBindings,
      classFieldTypes: opts.classFieldTypes,
    };
  }

  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });

  it("flags a localVar whose bound type is a builtin (const m = new Map(); m.get(k))", () => {
    const call: CallRef = { callText: "m.get(k)", receiver: "m", member: "get", startLine: 5 };
    const ctx = makeTypedCtx({ localBindings: { m: [{ line: 1, type: "Map" }] } });
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("flags a `this.field` chain whose field type is a builtin (private pending = new Map(); this.pending.get())", () => {
    const call: CallRef = { callText: "this.pending.get(k)", receiver: "this.pending", member: "get", startLine: 5 };
    const ctx = makeTypedCtx({ callerScope: ["Service"], classFieldTypes: { Service: { pending: "Map" } } });
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("flags a builtin bound through a stripped generic (const s = new Set<string>(); s.has(x))", () => {
    const call: CallRef = { callText: "s.has(x)", receiver: "s", member: "has", startLine: 5 };
    const ctx = makeTypedCtx({ localBindings: { s: [{ line: 1, type: "Set" }] } });
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("flags a Promise-typed localVar (p.then())", () => {
    const call: CallRef = { callText: "p.then(cb)", receiver: "p", member: "then", startLine: 5 };
    const ctx = makeTypedCtx({ localBindings: { p: [{ line: 1, type: "Promise" }] } });
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("does NOT flag an in-repo type — receiver typed as a project class stays internal (r: CollectionRegistry; r.list())", () => {
    const call: CallRef = { callText: "r.list()", receiver: "r", member: "list", startLine: 5 };
    const ctx = makeTypedCtx({ localBindings: { r: [{ line: 1, type: "CollectionRegistry" }] } });
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  it("does NOT flag a `Record` utility-type receiver (tbl: Record<...>; not a runtime constructor)", () => {
    const call: CallRef = { callText: "tbl.get(k)", receiver: "tbl", member: "get", startLine: 5 };
    const ctx = makeTypedCtx({ localBindings: { tbl: [{ line: 1, type: "Record" }] } });
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  it("does NOT flag an unknown / unbound receiver — precision over recall (no binding)", () => {
    const call: CallRef = { callText: "x.foo()", receiver: "x", member: "foo", startLine: 5 };
    const ctx = makeTypedCtx({});
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  it("does NOT flag a `this.field` whose field type is an in-repo class (this.store.read())", () => {
    const call: CallRef = { callText: "this.store.read()", receiver: "this.store", member: "read", startLine: 5 };
    const ctx = makeTypedCtx({ callerScope: ["Service"], classFieldTypes: { Service: { store: "Store" } } });
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });
});
