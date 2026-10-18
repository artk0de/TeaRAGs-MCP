import type { LanguageCapability } from "../../../contracts/types/language.js";
import { testFiles } from "./test-files.js";

export const capability: LanguageCapability = {
  language: "rust",
  ast: {
    tier: "full",
    engine: "tree-sitter",
    grammarPackage: "tree-sitter-rust",
    hooks: [
      { name: "nameExtractor", short: "named-item extraction" },
      { name: "rustTestScopeChunker", short: "#[cfg(test)] / #[test] scopes" },
    ],
  },
  tests: {
    tier: "high",
    detection: "*_test.rs + #[cfg(test)] modules",
    tech: "attribute-based test scope chunking (#[cfg(test)] / #[test])",
  },
  testFiles,
  codegraph: {
    tier: "moderate",
    tech: "7-strategy; trait dispatch; declared return/struct-field chains (Self, owner generics); same-file declared bare-call result locals",
    // Generic return substitution reads the declaring owner's genericParameters.
    resolverReadsTypeDeclarations: true,
    // Kind roles (bd tea-rags-mcp-jqvbn, spec §1a).
    // A tuple struct is called (`Point(1, 2)`). A call spelled with an enum's name
    // builds a VARIANT (`SpecValue::Style(style)`), never the enum, so an enum is a
    // receiver only — the spec table says C R; measured wrong on ripgrep.
    symbolKindRoles: {
      callee: new Set(["class", "function", "method"]),
      receiver: new Set(["class", "module", "interface", "enum", "constant", "function", "method"]),
    },
  },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // walker 2: bd tea-rags-mcp-f11nz — innermost-chunk call attribution. Every
  // in-method call used to be emitted again from each enclosing impl/mod/trait
  // chunk; ripgrep measured 18,845 sites collapsing to 14,152, so an already
  // indexed Rust project carries duplicate call rows until it recomputes.
  // walker 9: bd tea-rags-mcp-2g2og.24 — proven same-file declared bare-call
  // result locals feed receiver typing; .32 keeps placed instance/class dispatch exact.
  versions: { chunking: 4, walker: 9, codegraphSchema: 2 },
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
