import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "java",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-java" },
  tests: { tier: "medium", detection: "*Test.java / *IT.java", tech: "generic AST" },
  codegraph: { tier: "moderate", tech: "6-strategy + java.lang stdlib whitelist + overload disambiguation" },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-f11nz — innermost-chunk call attribution. Every
  // in-method call used to be emitted a second time from its enclosing class
  // chunk; commons-lang measured 17,641 sites collapsing to 8,719, so an already
  // indexed Java project carries duplicate call rows until it recomputes.
  // walker 4: bd tea-rags-mcp-jwjyr.1. The walker records the DECLARED
  // visibility on `ChunkExtraction.visibility` — `private` / `protected` / `public` (package-private unrecorded) — persisted in
  // `cg_symbols.visibility`. Needs `--force-enrichments codegraph` to fill.
  // walker 5: bd tea-rags-mcp-ezm9o. The test-file classifier matches
  // `*Test.java` / `*IT.java` case-sensitively, so `Latest.java` / `Audit.java`
  // enter the graph they were excluded from, and lose `skippedAs: "test"`.
  // `payload.isTest` moves too but is chunker-owned static payload, which only
  // `--force` rewrites; not bumping `chunking` for a false-positive repair.
  versions: { chunking: 1, walker: 6, codegraphSchema: 2 },
};
