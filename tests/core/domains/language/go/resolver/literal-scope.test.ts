import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";
import { describe, expect, it } from "vitest";

import type { CallContext, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-e6xx — a function literal's parameter SHADOWS every outer
 * meaning of its name for the literal's own lines, and only for them. The
 * chunk-wide `localCallBindings` (`c := New()` → `c` is whatever `New`
 * returns) used to type a literal parameter `c` that shadows it; the literal's
 * binding is now scoped (`scopeEndLine`), and a local of unknown type inside
 * that scope is a local — neither the outer call binding nor an import speaks
 * for it. Walker and resolver together, on source shaped after gin.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

function parse(src: string) {
  const p = new Parser();
  p.setLanguage(GoLang as unknown as Parser.Language);
  return p.parse(src);
}

function resolveAll(src: string, table: InMemoryGlobalSymbolTable): Map<number, string | null> {
  const go = new GoLanguage();
  // The fixture's function runs from line 2 to its closing brace, the last
  // non-empty line.
  const endLine = src.trimEnd().split("\n").length;
  const extraction = go.walker.walk({
    tree: parse(src),
    code: src,
    relPath: "gin.go",
    language: "go",
    chunks: [{ symbolId: "Default", scope: [], startLine: 2, endLine }],
  });
  const chunk = extraction.chunks[0];
  const ctx: CallContext = {
    callerFile: "gin.go",
    callerScope: [],
    imports: extraction.imports,
    symbolTable: table,
    localBindings: chunk.localBindings,
    localCallBindings: chunk.localCallBindings,
    // Run-global in production: `New` is declared in another file of gin.
    functionReturnTypes: { New: "Engine" },
  };
  const out = new Map<number, string | null>();
  for (const call of chunk.calls) {
    if (call.member !== "Use") continue;
    out.set(call.startLine, go.resolver.resolve(call, ctx)?.targetSymbolId ?? null);
  }
  return out;
}

function ginTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("gin.go", [
    sym("Engine", "gin.go"),
    sym("New", "gin.go"),
    sym("Engine#Use", "gin.go"),
    sym("Plugin", "gin.go"),
    sym("Plugin#Use", "gin.go"),
  ]);
  return t;
}

describe("Go function-literal scope against call-bound names", () => {
  it("an UNTYPED literal parameter shadows `c := New()` inside the literal, and only there", () => {
    const src = [
      "package gin",
      "func Default() *Engine {",
      "\tc := New()",
      "\tc.Use()",
      "\teach(func(c interface{ Use() }) {",
      "\t\tc.Use()",
      "\t})",
      "\tc.Use()",
      "\treturn c",
      "}",
      "",
    ].join("\n");
    const resolved = resolveAll(src, ginTable());
    expect(resolved.get(4)).toBe("Engine#Use");
    expect(resolved.get(6)).toBeNull();
    expect(resolved.get(8)).toBe("Engine#Use");
  });

  it("a TYPED literal parameter wins inside the literal; the call binding is back after it", () => {
    const src = [
      "package gin",
      "func Default() *Engine {",
      "\tc := New()",
      "\teach(func(c *Plugin) {",
      "\t\tc.Use()",
      "\t})",
      "\tc.Use()",
      "\treturn c",
      "}",
      "",
    ].join("\n");
    const resolved = resolveAll(src, ginTable());
    expect(resolved.get(5)).toBe("Plugin#Use");
    expect(resolved.get(7)).toBe("Engine#Use");
  });
});
