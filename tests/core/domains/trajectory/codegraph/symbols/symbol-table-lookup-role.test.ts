/**
 * Kind-aware lookups on `InMemoryGlobalSymbolTable` (bd tea-rags-mcp-jqvbn).
 *
 * A lookup that names a lookup ROLE sees only the definitions that can play it:
 * the callee role drops type-only declarations, enums and constants; the
 * receiver role drops only the type-only ones. A lookup with no role is a TYPE
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

describe("InMemoryGlobalSymbolTable lookup roles (bd tea-rags-mcp-jqvbn)", () => {
  it("keeps every kind when no role is asked for", () => {
    expect(tableWithEveryKind().lookupByShortName("Logger")).toHaveLength(6);
  });

  it("answers the callee role with call targets and untagged definitions only", () => {
    expect(files(tableWithEveryKind().lookupByShortName("Logger", { role: "callee" }))).toEqual([
      "src/legacy.ts",
      "src/logger.ts",
    ]);
  });

  it("answers the receiver role without the type-only declarations", () => {
    expect(files(tableWithEveryKind().lookupByShortName("Logger", { role: "receiver" }))).toEqual([
      "src/const.ts",
      "src/enum.ts",
      "src/legacy.ts",
      "src/logger.ts",
    ]);
  });

  it("applies the role to the fully-qualified lookup too", () => {
    const table = tableWithEveryKind();
    expect(table.lookup("Logger")).toHaveLength(6);
    expect(files(table.lookup("Logger", { role: "callee" }))).toEqual(["src/legacy.ts", "src/logger.ts"]);
    expect(files(table.lookup("Logger", { role: "receiver" }))).toHaveLength(4);
  });

  it("counts only call targets in shortNameDefCounts", () => {
    const table = tableWithEveryKind();
    table.upsertFile("src/props.ts", [def("src/props.ts", "Props", "interface")]);
    const counts = table.shortNameDefCounts();
    expect(counts.get("Logger")).toBe(2);
    expect(counts.has("Props")).toBe(false);
  });

  it("combines a role with the schema-column opt-in", () => {
    const table = tableWithEveryKind();
    table.setSchemaColumns([{ ...def("app/models/logger.rb", "Logger"), isSchemaColumn: true }]);
    expect(table.lookupByShortName("Logger", { role: "callee", includeSchemaColumns: true })).toHaveLength(3);
  });
});
