/**
 * bd tea-rags-mcp-nbf8q item 2 — the miss classifier's denominator question,
 * asked of the Ruby and Python FACADES.
 *
 * Both resolver chains only ever answer with their own language's files, but
 * `classifyResolveMiss` falls back to the unfiltered polyglot
 * `lookupByShortName` for a facade that does not answer
 * `hasInProjectDefinition`. A Ruby or Python miss whose only namesake is a
 * TypeScript declaration was then charged as `missWithInProjectDef` — a recall
 * hole the chain could never close. Driven through `LanguageFactory` because
 * the runner reads the facade, never the `CallResolver` behind it (bd
 * tea-rags-mcp-x9qsh).
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { classifyResolveMiss } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, ids] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      ids.map((symbolId) => ({
        symbolId,
        fqName: symbolId,
        shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
        relPath,
        scope: symbolId.includes("#") ? [symbolId.split("#")[0]] : [],
      })),
    );
  }
  return table;
}

const factory = new LanguageFactory();

const CASES = [
  { language: "ruby", callerFile: "app/services/report.rb", ownFile: "app/models/widget.rb" },
  { language: "python", callerFile: "app/services/report.py", ownFile: "app/models/widget.py" },
] as const;

describe.each(CASES)("classifyResolveMiss — $language facade vs a foreign namesake", (c) => {
  const { resolver } = factory.create(c.language);
  const call: CallRef = {
    callText: "thing.render_widget()",
    receiver: "thing",
    member: "render_widget",
    startLine: 20,
  };

  function ctxOver(table: InMemoryGlobalSymbolTable): CallContext {
    return { callerFile: c.callerFile, callerScope: [], imports: [], symbolTable: table };
  }

  it("books a miss whose only namesake is a TypeScript declaration as noInProjectDef", () => {
    const table = tableWith({
      [c.callerFile]: ["Report"],
      "app/javascript/widget.ts": ["Widget", "Widget#render_widget"],
    });
    expect(classifyResolveMiss(call, ctxOver(table), resolver, table)).toBe("noInProjectDef");
  });

  it("still charges a miss its own language declares", () => {
    const table = tableWith({
      [c.callerFile]: ["Report"],
      [c.ownFile]: ["Widget", "Widget#render_widget"],
      "app/javascript/widget.ts": ["Widget", "Widget#render_widget"],
    });
    expect(classifyResolveMiss(call, ctxOver(table), resolver, table)).toBe("missWithInProjectDef");
  });
});
