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
  codegraph: { tier: "moderate", tech: "6-strategy; trait-based dispatch" },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-f11nz — innermost-chunk call attribution. Every
  // in-method call used to be emitted again from each enclosing impl/mod/trait
  // chunk; ripgrep measured 18,845 sites collapsing to 14,152, so an already
  // indexed Rust project carries duplicate call rows until it recomputes.
  // walker 4: bd tea-rags-mcp-jwjyr.1. The walker records the DECLARED
  // visibility on `ChunkExtraction.visibility` — `pub` vs module-private (trait members public) — persisted in
  // `cg_symbols.visibility`. Needs `--force-enrichments codegraph` to fill.
  // walker 5: bd tea-rags-mcp-4p3sb.5 — the walker publishes
  // `identifierDeclarations` (params, `let` locals, struct fields; annotation,
  // struct-literal and `X::new` types) for the naming lexicon. Rows written by
  // walker 4 carry none, so only the recompute adds them.
  // walker 7: bd tea-rags-mcp-4p3sb.17 — an `identifierDeclarations` annotation
  // of `Vec / VecDeque / HashSet / BTreeSet / Option / Box / Rc / Arc<T>` or a
  // slice `&[T]` names its element, so a walker-6 row types `items` as `Vec`.
  versions: { chunking: 1, walker: 7, codegraphSchema: 2 },
  // Rust API Guidelines (RFC 430): types and traits UpperCamelCase, modules,
  // functions, methods, locals and fields snake_case, `const` / `static`
  // SCREAMING_SNAKE_CASE.
  naming: {
    type: ["pascal"],
    module: ["snake"],
    method: ["snake"],
    param: ["snake"],
    local: ["snake"],
    field: ["snake"],
    constant: ["screamingSnake"],
  },
};
