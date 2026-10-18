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
  // walker 6: bd tea-rags-mcp-2g2og.24 — the walker publishes native declared
  // returns for receiver chains; the resolver substitutes Self and proven
  // owner generics without field, import-bound, wrapper or fixpoint propagation.
  // walker 7: bd tea-rags-mcp-2g2og.24 — annotated local bindings retain
  // nominal generic arguments for declared-return chain substitution.
  // walker 8: bd tea-rags-mcp-2g2og.24 — placed declared struct fields and
  // simple owner-generic field arguments feed bounded receiver chains.
  // walker 9: bd tea-rags-mcp-2g2og.24 — proven same-file declared bare-call
  // result locals feed receiver typing; .32 keeps placed instance/class dispatch exact.
  // Also under walker 9 (same release cycle, re-pinned, no second bump): bd
  // tea-rags-mcp-2g2og.25 — every CallRef carries `startColumn` (the call
  // expression's start in UTF-16 code units) and turbofish callees
  // (`f::<T>()`) keep their free/scoped/qualified/method shapes; rows written
  // by earlier walkers carry neither, so only the recompute adds them.
  // Also under walker 9 (same release cycle, re-pinned, no second bump): bd
  // tea-rags-mcp-2g2og — direct import-bound bare-call resolution, the
  // language-filtered short-name fallback and the facade's external
  // classification (std prelude + import heads via `hasInProjectDefinition` /
  // `targetsExternalImport`).
  // Also under walker 9 (same release cycle, re-pinned, no second bump): bd
  // tea-rags-mcp-2g2og — workspace-crate types participate in placement: the
  // symbol table answers `hasDirNamed` (a crate dir named after the crate) and
  // the nominal-type veto fires only for EXTERNALLY-bound imports, so a
  // declared return type bound from a workspace crate resolves across the
  // chain fold.
  // Also under walker 9 (same release cycle, re-pinned, no second bump): bd
  // tea-rags-mcp-2g2og — Rust auto-deref: a member the placed owner misses is
  // retried on its `Deref::deref` declared return (project smart pointers;
  // three hops, name cycle guard), cross-file declared returns re-resolve in
  // the declaring file's own lexical scope, and a literal receiver with no
  // in-project member definition classifies external.
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
