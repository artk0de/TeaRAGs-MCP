/**
 * The miss classifier's fallback denominator asks the CALLING language's
 * callee kinds (bd tea-rags-mcp-jqvbn).
 *
 * A resolver facade that does not answer `hasInProjectDefinition` leaves the
 * question to `classifyResolveMiss`, which falls back to a short-name lookup.
 * A same-named declaration the calling language cannot call is no edge this
 * call can have, so it must not turn a `noInProjectDef` into a charged
 * `missWithInProjectDef` — while a kind the language does call still counts.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  SymbolDefinitionKind,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { capability as goCapability } from "../../../../../../src/core/domains/language/go/capability.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { classifyResolveMiss } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const call: CallRef = { callText: "Ghost(x)", receiver: null, member: "Ghost", startLine: 3 };

function tableWith(kind: SymbolDefinitionKind): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("pkg/types.go", [
    { symbolId: "Ghost", fqName: "Ghost", shortName: "Ghost", relPath: "pkg/types.go", scope: [], symbolKind: kind },
  ]);
  return table;
}

const ctx = (symbolTable: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile: "pkg/main.go",
  callerScope: [],
  imports: [],
  symbolTable,
});

describe("classifyResolveMiss — fallback denominator under the caller's callee kinds (bd tea-rags-mcp-jqvbn)", () => {
  const resolver = () => {
    const r = new GoLanguage().resolver;
    if (r === undefined || r.hasInProjectDefinition !== undefined) throw new Error("expects the fallback path");
    return r;
  };
  const goCallee = goCapability.codegraph.symbolKindRoles.callee;

  it.each(["enum", "constant", "module"] as const)("a Go %s namesake is no in-project definition", (kind) => {
    const table = tableWith(kind);
    expect(classifyResolveMiss(call, ctx(table), resolver(), table, goCallee)).toBe("noInProjectDef");
  });

  it("a Go interface is one — Go calls it (`Ghost(x)` is a conversion)", () => {
    const table = tableWith("interface");
    expect(classifyResolveMiss(call, ctx(table), resolver(), table, goCallee)).toBe("missWithInProjectDef");
  });

  it("without the caller's kinds every declaration counts", () => {
    const table = tableWith("enum");
    expect(classifyResolveMiss(call, ctx(table), resolver(), table)).toBe("missWithInProjectDef");
  });
});
