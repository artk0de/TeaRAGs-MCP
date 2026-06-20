import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { JavascriptCallResolver } from "../../../../../../src/core/domains/language/javascript/resolver/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * tea-rags-mcp-ykj7 (ykj7-a) — JS classifies an UNRESOLVED call as external
 * when the receiver matches a bare npm specifier (no in-project file) or an
 * ECMAScript ambient global. The JS walker does NOT populate `importedNames`,
 * so receiver↔import matching follows the resolver's existing last-path-segment
 * heuristic (`importMatchesReceiver`).
 */
describe("JavascriptCallResolver.targetsExternalImport", () => {
  function makeCtx(
    callerFile: string,
    imports: { importText: string; startLine: number }[],
    symbolTable: InMemoryGlobalSymbolTable,
  ): CallContext {
    return { callerFile, callerScope: [], imports, symbolTable };
  }

  const resolver = new JavascriptCallResolver();

  it("flags a receiver matching a bare npm import (tree-sitter-ruby)", () => {
    const call: CallRef = {
      callText: "tree-sitter-ruby.parse(s)",
      receiver: "tree-sitter-ruby",
      member: "parse",
      startLine: 3,
    };
    const ctx = makeCtx(
      "src/x.js",
      [{ importText: "tree-sitter-ruby", startLine: 1 }],
      new InMemoryGlobalSymbolTable(),
    );
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("flags a receiver matching a bare npm import (lodash)", () => {
    const call: CallRef = { callText: "lodash.map(xs)", receiver: "lodash", member: "map", startLine: 3 };
    const ctx = makeCtx("src/x.js", [{ importText: "lodash", startLine: 1 }], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("flags an ECMAScript ambient global with no import (console.log)", () => {
    const call: CallRef = { callText: "console.log(x)", receiver: "console", member: "log", startLine: 3 };
    const ctx = makeCtx("src/x.js", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(true);
  });

  it("does NOT flag a receiver matching a relative (in-project) import", () => {
    const call: CallRef = { callText: "foo.bar()", receiver: "foo", member: "bar", startLine: 3 };
    const ctx = makeCtx("src/main.js", [{ importText: "./foo", startLine: 1 }], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });

  it("does NOT flag an in-project miss with no matching import (Mystery)", () => {
    const call: CallRef = { callText: "Mystery.nope()", receiver: "Mystery", member: "nope", startLine: 3 };
    const ctx = makeCtx("src/main.js", [], new InMemoryGlobalSymbolTable());
    expect(resolver.targetsExternalImport(call, ctx)).toBe(false);
  });
});
