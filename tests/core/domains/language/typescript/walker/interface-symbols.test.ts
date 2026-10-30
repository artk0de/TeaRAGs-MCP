/**
 * bd tea-rags-mcp-3otbo — a TypeScript `interface` is a codegraph symbol.
 *
 * `tsNameOf` never named `interface_declaration`, so no interface reached
 * `cg_symbols`, and `normalizeInheritanceEdges` — which resolves an ancestor
 * by `symbolTable.lookup(fqName)` — left `ancestorSymbolId` null on EVERY TS
 * `implements` row (526 of 526 on the tea-rags self-index), while `extends`
 * rows resolved because their ancestor is a named class. The class outline then
 * printed `implements ExploreStrategy (unresolved)` for a project interface.
 */
import Parser from "tree-sitter";
import TsLang from "tree-sitter-typescript";
import { describe, expect, it } from "vitest";

import { materializeTree } from "../../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TypeScriptLanguage } from "../../../../../../src/core/domains/language/typescript/index.js";
import { normalizeInheritanceEdges } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/inheritance-edges.js";
import { symbolDefinitionsOf } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-definitions.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const language = new TypeScriptLanguage();

/** The production pass-1 sequence for one file: collect symbols with `walker.nameOf`, then the COMPOSED walk. */
function walk(relPath: string, lines: string[]): FileExtraction {
  const src = `${lines.join("\n")}\n`;
  const parser = new Parser();
  parser.setLanguage(TsLang.typescript);
  const tree = { rootNode: materializeTree(parser.parse(src).rootNode, src) };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return language.walker.walk({ tree, code: src, relPath, language: "typescript", chunks });
}

const PORT = walk("src/port.ts", [
  "export interface ExploreStrategy {",
  "  execute(query: string): Promise<string[]>;",
  "  readonly type: string;",
  "}",
]);

const BASE = walk("src/base.ts", ["export abstract class Base {", "  run(): void {}", "}"]);

const IMPL = walk("src/impl.ts", [
  'import type { ExploreStrategy } from "./port.js";',
  'import { Base } from "./base.js";',
  "",
  "export class Strategy extends Base implements ExploreStrategy, Iterable<string> {",
  "  readonly type = 'x';",
  "  async execute(query: string): Promise<string[]> {",
  "    return [query];",
  "  }",
  "  [Symbol.iterator](): Iterator<string> {",
  "    return [].values();",
  "  }",
  "}",
]);

function projectTable(): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const extraction of [PORT, BASE, IMPL]) table.upsertFile(extraction.relPath, symbolDefinitionsOf(extraction));
  return table;
}

describe("TS interface symbols (bd tea-rags-mcp-3otbo)", () => {
  it("records an interface declaration as an `interface`-kind symbol with no members", () => {
    const defs = symbolDefinitionsOf(PORT);
    expect(defs.map((d) => [d.symbolId, d.symbolKind, d.scope])).toEqual([["ExploreStrategy", "interface", []]]);
  });

  it("resolves a class's `implements` ancestor to the project interface's symbol id", () => {
    const table = projectTable();
    const rows = normalizeInheritanceEdges(IMPL, (fq) => table.lookup(fq)[0]?.symbolId ?? null);
    const byAncestor = Object.fromEntries(rows.map((r) => [`${r.kind}:${r.ancestorFqName}`, r.ancestorSymbolId]));
    expect(byAncestor).toEqual({
      "super:Base": "Base",
      "implements:ExploreStrategy": "ExploreStrategy",
      // An external (lib) interface has no project symbol and stays unresolved.
      "implements:Iterable": null,
    });
  });

  it("resolves interface-to-interface heritage onto the project interface", () => {
    const child = walk("src/child.ts", [
      'import type { ExploreStrategy } from "./port.js";',
      "export interface RankingStrategy extends ExploreStrategy {",
      "  rank(): number;",
      "}",
    ]);
    const table = projectTable();
    table.upsertFile(child.relPath, symbolDefinitionsOf(child));
    const rows = normalizeInheritanceEdges(child, (fq) => table.lookup(fq)[0]?.symbolId ?? null);
    expect(rows.map((r) => [r.sourceSymbolId, r.ancestorSymbolId, r.kind])).toEqual([
      ["RankingStrategy", "ExploreStrategy", "implements"],
    ]);
  });

  it("keeps an interface out of the callee role, so a bare call never lands on it", () => {
    const table = projectTable();
    const callee = new Set(["class", "function", "method"] as const);
    expect(table.lookup("ExploreStrategy", { kinds: callee })).toEqual([]);
    expect(table.lookup("Base", { kinds: callee }).map((d) => d.symbolId)).toEqual(["Base"]);
  });
});
