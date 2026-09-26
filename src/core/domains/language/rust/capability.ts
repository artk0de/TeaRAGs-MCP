import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "rust",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    grammarPackage: "tree-sitter-rust",
    hooks: [{ name: "nameExtractor", short: "named-item extraction" }],
  },
  tests: { tier: "medium", detection: "*_test.rs", tech: "generic AST (#[test] attrs not preserved)" },
  codegraph: { tier: "moderate", tech: "7-strategy; trait-based dispatch" },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-f11nz — innermost-chunk call attribution. Every
  // in-method call used to be emitted again from each enclosing impl/mod/trait
  // chunk; ripgrep measured 18,845 sites collapsing to 14,152, so an already
  // indexed Rust project carries duplicate call rows until it recomputes.
  // walker 4: bd tea-rags-mcp-jwjyr.1. The walker records the DECLARED
  // visibility on `ChunkExtraction.visibility` — `pub` vs module-private (trait members public) — persisted in
  // `cg_symbols.visibility`. Needs `--force-enrichments codegraph` to fill.
  // Also under walker 4 (same release cycle, re-pinned, no second bump): bd
  // tea-rags-mcp-7266 — the `typeReceiver` pass resolves `Type::f()`,
  // `Self::f()` and `Type::new().m()` through an in-project type.
  versions: { chunking: 1, walker: 4, codegraphSchema: 2 },
};
