/**
 * Rust callee lookups ask for the callee role (bd tea-rags-mcp-jqvbn): a trait,
 * enum or type alias sharing a function's name is no second candidate for a
 * call to that name, so the sole-candidate pick still commits.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type SymbolDefinition,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  RustGlobalShortNameSymbolResolutionStrategy,
  RustImportMatchSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/rust/resolver/strategies/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const def = (relPath: string, name: string, symbolKind?: SymbolDefinition["symbolKind"]): SymbolDefinition => ({
  symbolId: name,
  fqName: name,
  shortName: name,
  relPath,
  scope: [],
  ...(symbolKind ? { symbolKind } : {}),
});

const ctx = (symbolTable: InMemoryGlobalSymbolTable, over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "src/main.rs",
  callerScope: [],
  imports: [],
  symbolTable,
  ...over,
});

describe("Rust callee lookups ignore non-callable namesakes (bd tea-rags-mcp-jqvbn)", () => {
  it.each(["interface", "enum", "type_alias", "constant"] as const)(
    "globalShortName still resolves the function when a %s shares its name",
    (kind) => {
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("src/util.rs", [def("src/util.rs", "walk", "function")]);
      table.upsertFile("src/types.rs", [def("src/types.rs", "walk", kind)]);
      const outcome = new RustGlobalShortNameSymbolResolutionStrategy(cfg).attempt(
        { callText: "walk()", receiver: null, member: "walk", startLine: 1 },
        ctx(table),
      );
      expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/util.rs", targetSymbolId: "walk" } });
    },
  );

  it("importMatch still pins the module function when a trait in the same module shares its name", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/foo/bar.rs", [
      def("src/foo/bar.rs", "walk", "function"),
      def("src/foo/bar.rs", "walk", "interface"),
    ]);
    const outcome = new RustImportMatchSymbolResolutionStrategy(cfg).attempt(
      { callText: "bar::walk()", receiver: "bar", member: "walk", startLine: 1 },
      ctx(table, { imports: [{ importText: "crate::foo::bar", startLine: 1 }] }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/foo/bar.rs", targetSymbolId: "walk" } });
  });

  it("an untagged namesake still makes the short name ambiguous", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/util.rs", [def("src/util.rs", "walk", "function")]);
    table.upsertFile("src/legacy.rs", [def("src/legacy.rs", "walk")]);
    const outcome = new RustGlobalShortNameSymbolResolutionStrategy(cfg).attempt(
      { callText: "walk()", receiver: null, member: "walk", startLine: 1 },
      ctx(table),
    );
    expect(outcome.kind).toBe("continue");
  });
});
