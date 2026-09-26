/**
 * Kind-aware lookups on `InMemoryGlobalSymbolTable` (bd tea-rags-mcp-jqvbn).
 *
 * A lookup made for a ROLE carries the kinds that can play it — one of the
 * CALLING language's `symbolKindRoles` sets — and sees only those definitions.
 * The table knows no language; the sets below are the TypeScript row, where the
 * callee role drops type-only declarations, enums and constants and the
 * receiver role drops only the type-only ones. A lookup with no kinds is a TYPE
 * lookup (a CHA locator, an annotation) and keeps every kind. Untagged
 * definitions answer every role, so a pre-035 index resolves as it always did.
 */
import { describe, expect, it } from "vitest";

import type { SymbolDefinition, SymbolDefinitionKind } from "../../../../../../src/core/contracts/types/codegraph.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function def(relPath: string, name: string, symbolKind?: SymbolDefinitionKind): SymbolDefinition {
  return { symbolId: name, fqName: name, shortName: name, relPath, scope: [], ...(symbolKind ? { symbolKind } : {}) };
}

function tableWithEveryKind(): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/logger.ts", [def("src/logger.ts", "Logger", "class")]);
  table.upsertFile("src/types.ts", [def("src/types.ts", "Logger", "interface")]);
  table.upsertFile("src/alias.ts", [def("src/alias.ts", "Logger", "type_alias")]);
  table.upsertFile("src/enum.ts", [def("src/enum.ts", "Logger", "enum")]);
  table.upsertFile("src/const.ts", [def("src/const.ts", "Logger", "constant")]);
  table.upsertFile("src/legacy.ts", [def("src/legacy.ts", "Logger")]);
  return table;
}

const files = (defs: SymbolDefinition[]): string[] => defs.map((d) => d.relPath).sort();

const CALLEE: ReadonlySet<SymbolDefinitionKind> = new Set(["class", "function", "method"]);
const RECEIVER: ReadonlySet<SymbolDefinitionKind> = new Set([
  "class",
  "module",
  "enum",
  "constant",
  "function",
  "method",
]);

describe("InMemoryGlobalSymbolTable lookup roles (bd tea-rags-mcp-jqvbn)", () => {
  it("keeps every kind when no role is asked for", () => {
    expect(tableWithEveryKind().lookupByShortName("Logger")).toHaveLength(6);
  });

  it("answers the callee role with call targets and untagged definitions only", () => {
    expect(files(tableWithEveryKind().lookupByShortName("Logger", { kinds: CALLEE }))).toEqual([
      "src/legacy.ts",
      "src/logger.ts",
    ]);
  });

  it("answers the receiver role without the type-only declarations", () => {
    expect(files(tableWithEveryKind().lookupByShortName("Logger", { kinds: RECEIVER }))).toEqual([
      "src/const.ts",
      "src/enum.ts",
      "src/legacy.ts",
      "src/logger.ts",
    ]);
  });

  it("applies the role to the fully-qualified lookup too", () => {
    const table = tableWithEveryKind();
    expect(table.lookup("Logger")).toHaveLength(6);
    expect(files(table.lookup("Logger", { kinds: CALLEE }))).toEqual(["src/legacy.ts", "src/logger.ts"]);
    expect(files(table.lookup("Logger", { kinds: RECEIVER }))).toHaveLength(4);
  });

  it("counts only call targets in shortNameDefCounts", () => {
    const table = tableWithEveryKind();
    table.upsertFile("src/props.ts", [def("src/props.ts", "Props", "interface")]);
    const counts = table.shortNameDefCounts(CALLEE);
    expect(counts.get("Logger")).toBe(2);
    expect(counts.has("Props")).toBe(false);
  });

  it("counts under the caller's kinds, so a language that calls interfaces counts one", () => {
    const table = tableWithEveryKind();
    const goCallee: ReadonlySet<SymbolDefinitionKind> = new Set(["class", "interface", "type_alias", "function"]);
    expect(table.shortNameDefCounts(goCallee).get("Logger")).toBe(4);
    expect(files(table.lookupByShortName("Logger", { kinds: goCallee }))).toEqual([
      "src/alias.ts",
      "src/legacy.ts",
      "src/logger.ts",
      "src/types.ts",
    ]);
  });

  it("counts every kind when no kinds are given", () => {
    expect(tableWithEveryKind().shortNameDefCounts().get("Logger")).toBe(6);
  });

  it("combines a role with the schema-column opt-in", () => {
    const table = tableWithEveryKind();
    table.setSchemaColumns([{ ...def("app/models/logger.rb", "Logger"), isSchemaColumn: true }]);
    expect(table.lookupByShortName("Logger", { kinds: CALLEE, includeSchemaColumns: true })).toHaveLength(3);
  });
});
