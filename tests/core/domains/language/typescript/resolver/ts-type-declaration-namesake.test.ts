/**
 * A TYPE declaration sharing a name with a value must not move resolution
 * (bd tea-rags-mcp-jqvbn).
 *
 * Once `interface` / `enum` / `type` declarations are codegraph symbols, the
 * project's `interface Logger` sits in the table next to its `class Logger`. A
 * lookup that ignores the kind reads that as a second candidate: the bare-call
 * fallback's N=1 turns into N=2 and drops, and the barrel hop sees the name
 * declared in two files and can no longer tell which one the barrel re-exports.
 * Neither declaration is a runtime value, so neither may count — the callee and
 * receiver lookups carry a role and the table answers it by `symbolKind`.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

type Def = SymbolDefinition;

const def = (relPath: string, symbolId: string, scope: string[], symbolKind?: Def["symbolKind"]): Def => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope,
  ...(symbolKind ? { symbolKind } : {}),
});

const TYPE_ONLY_KINDS = ["interface", "type_alias"] as const;
const NON_CALLABLE_KINDS = [...TYPE_ONLY_KINDS, "enum"] as const;

function ctx(symbolTable: InMemoryGlobalSymbolTable, imports: CallContext["imports"] = []): CallContext {
  return { callerFile: "src/main.ts", callerScope: [], imports, symbolTable };
}

describe("type-declaration namesakes do not move TS resolution (bd tea-rags-mcp-jqvbn)", () => {
  it.each(NON_CALLABLE_KINDS)("a bare call still resolves to the function when a %s shares its name", (kind) => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/handler.ts", [def("src/handler.ts", "handler", [], "function")]);
    table.upsertFile("src/types.ts", [def("src/types.ts", "handler", [], kind)]);
    const result = new TSCallResolver({ baseUrl: ".", paths: {} }).resolve(
      { callText: "handler(event)", receiver: null, member: "handler", startLine: 4 },
      ctx(table),
    );
    expect(result).toEqual({ targetRelPath: "src/handler.ts", targetSymbolId: "handler" });
  });

  it.each(TYPE_ONLY_KINDS)("`new Logger()` through a barrel still pins the class when a %s shares its name", (kind) => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/logger.ts", [
      def("src/logger.ts", "Logger", [], "class"),
      def("src/logger.ts", "Logger#constructor", ["Logger"], "method"),
    ]);
    table.upsertFile("src/types.ts", [def("src/types.ts", "Logger", [], kind)]);
    table.upsertFile("src/index.ts", []);
    table.upsertFile("src/other.ts", [def("src/other.ts", "Other#constructor", ["Other"], "method")]);
    const result = new TSCallResolver({ baseUrl: ".", paths: {} }).resolve(
      { callText: "new Logger()", receiver: "Logger", member: "constructor", startLine: 4 },
      ctx(table, [{ importText: "./index.js", startLine: 1, importedNames: ["Logger"] }]),
    );
    expect(result).toEqual({ targetRelPath: "src/logger.ts", targetSymbolId: "Logger#constructor" });
  });

  it.each(TYPE_ONLY_KINDS)(
    "a member call through a barrel still pins the namespace when a %s shares its name",
    (kind) => {
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("src/registry.ts", [
        def("src/registry.ts", "Registry", [], "module"),
        def("src/registry.ts", "Registry.lookup", ["Registry"], "method"),
      ]);
      table.upsertFile("src/types.ts", [def("src/types.ts", "Registry", [], kind)]);
      table.upsertFile("src/index.ts", []);
      table.upsertFile("src/other.ts", [def("src/other.ts", "Other.lookup", ["Other"], "method")]);
      const result = new TSCallResolver({ baseUrl: ".", paths: {} }).resolve(
        { callText: "Registry.lookup(key)", receiver: "Registry", member: "lookup", startLine: 4 },
        ctx(table, [{ importText: "./index.js", startLine: 1, importedNames: ["Registry"] }]),
      );
      expect(result).toEqual({ targetRelPath: "src/registry.ts", targetSymbolId: "Registry.lookup" });
    },
  );

  it("a member call on a class still pins the static method when an enum shares the class name", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/color.ts", [
      def("src/color.ts", "Color", [], "class"),
      def("src/color.ts", "Color.parse", ["Color"], "method"),
    ]);
    table.upsertFile("src/enums.ts", [def("src/enums.ts", "Color", [], "enum")]);
    table.upsertFile("src/other.ts", [def("src/other.ts", "Other.parse", ["Other"], "method")]);
    const result = new TSCallResolver({ baseUrl: ".", paths: {} }).resolve(
      { callText: "Color.parse(hex)", receiver: "Color", member: "parse", startLine: 4 },
      ctx(table, [{ importText: "./color.js", startLine: 1, importedNames: ["Color"] }]),
    );
    expect(result).toEqual({ targetRelPath: "src/color.ts", targetSymbolId: "Color.parse" });
  });

  it("an untagged namesake still counts as a candidate, as every pre-035 row did", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/handler.ts", [def("src/handler.ts", "handler", [], "function")]);
    table.upsertFile("src/legacy.ts", [def("src/legacy.ts", "handler", [])]);
    const result = new TSCallResolver({ baseUrl: ".", paths: {} }).resolve(
      { callText: "handler(event)", receiver: null, member: "handler", startLine: 4 },
      ctx(table),
    );
    expect(result).toBeNull();
  });
});
