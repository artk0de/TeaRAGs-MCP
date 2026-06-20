import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
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
