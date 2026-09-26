import type { LanguageCapability } from "../../../contracts/types/language.js";
import { testFiles } from "./test-files.js";

export const capability: LanguageCapability = {
  language: "rust",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    grammarPackage: "tree-sitter-rust",
    hooks: [{ name: "nameExtractor", short: "named-item extraction" }],
  },
  tests: { tier: "medium", detection: "*_test.rs", tech: "generic AST (#[test] attrs not preserved)" },
  testFiles,
  codegraph: { tier: "moderate", tech: "7-strategy; trait-based dispatch" },
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
  // walker 8: bd tea-rags-mcp-4p3sb.21 — `identifierDeclarations` carries each
  // fn's return type as a `return` (`Self` as the impl's type), so a walker-7
  // index has no return row for call-return to join.
  // Also under walker 8 (same release cycle, re-pinned, no second bump): bd
  // tea-rags-mcp-7266 — the `typeReceiver` pass resolves `Type::f()`,
  // `Self::f()` and `Type::new().m()` through an in-project type.
  // walker 3: release v1.44.2 shipped walker 2 and a release cycle gets ONE
  // walker bump, so every branch-local number above collapses into 3.
  versions: { chunking: 1, walker: 3, codegraphSchema: 2 },
  // Rust API Guidelines (RFC 430): types and traits UpperCamelCase, modules,
  // functions, methods, locals and fields snake_case, `const` / `static`
  // SCREAMING_SNAKE_CASE.
  naming: {
    casing: {
      type: ["pascal"],
      module: ["snake"],
      method: ["snake"],
      param: ["snake"],
      local: ["snake"],
      field: ["snake"],
      constant: ["screamingSnake"],
    },
    // Primitives, `String`, `Self`; maps keep their head through collection unwrapping.
    nonConceptTypes: [
      "String",
      "str",
      "i8",
      "i16",
      "i32",
      "i64",
      "i128",
      "isize",
      "u8",
      "u16",
      "u32",
      "u64",
      "u128",
      "usize",
      "f32",
      "f64",
      "bool",
      "char",
      "Self",
      "HashMap",
      "BTreeMap",
    ],
  },
};
