import type { LanguageCapability } from "../../../contracts/types/language.js";
import { testFiles } from "./test-files.js";

export const capability: LanguageCapability = {
  language: "rust",
  languageVersion: {
    policy: "fixture-validated",
    target: "Rust 1.88.0 / edition 2024",
    evidence: "tests/core/domains/language/capability/version-policy.test.ts",
    limitations:
      "Syntax fixtures only, not compiler conformance; latest upstream release unverified; macro expansion and nightly syntax not certified",
  },
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
    tech: "10-strategy (last: rust-analyzer SCIP); trait dispatch; return/field chains (Self, owner generics); same-file bare-call result locals; crate-scoped impls",
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
  // walker 10: bd tea-rags-mcp-2g2og.33 — `self`/`super` paths start from the
  // file's own module (`x.rs` is module x, not its directory) and repeated
  // `super::` prefixes climb one module each.
  // walker 11 (one bump for the release after 1.49.0, epic s3i8m):
  // - bd tea-rags-mcp-s3i8m.2 — `macro_rules!` chunks carry symbolKind "macro"
  //   so macro invocations resolve in the macro namespace only.
  // - bd tea-rags-mcp-2g2og.24 slice 1 — tuple-struct fields (`0`) and fields
  //   with nested/primitive type arguments are recorded by head.
  // - bd tea-rags-mcp-s3i8m.3 — params / typed lets annotated with a
  //   primitive, str, slice or array bind (`str`, `usize`, `[u8]`).
  // - bd tea-rags-mcp-sjego — workspace crate names map to member directories
  //   and an imported type alias no longer pins its members to its own file.
  // - bd tea-rags-mcp-s3i8m Task 1a — pattern-bound names (`if let`, match
  //   arms, `for`, closure params, destructuring `let`) record shadowing
  //   `patternProjection` bindings; tuple return types are recorded.
  // - bd tea-rags-mcp-s3i8m Task 1b — enum variant payloads are recorded as
  //   fields of `<Enum>::<Variant>` (positional `0`, `1`, … and named), their
  //   type arguments on the enum's fact keyed `<Variant>::<field>`.
  // - bd tea-rags-mcp-s3i8m.8 — nested `pub use` trees record every leaf with
  //   its full source module (`pub use self::{peer::{find_peer}}`).
  // - bd tea-rags-mcp-s3i8m.4 (B1) — a `macro_rules!` records visibility:
  //   "public" under `#[macro_export]`, else "private".
  // - bd tea-rags-mcp-s3i8m Task 2 — a type name unique in its crate owns the
  //   crate's impl members in every file: `self.m()`, `self` chain seeding and
  //   placed-owner member lookup answer from cross-file impls.
  // - bd tea-rags-mcp-s3i8m.4 (B2) — a crate root records its
  //   `#[macro_use] extern crate` list (`rustMacroUseCrates`), in source order.
  // - bd tea-rags-mcp-s3i8m (letCall S4a) — a file records its `use` import
  //   texts (`rustUseImports`); nothing reads them yet, resolution unchanged.
  // - bd tea-rags-mcp-s3i8m Task 2 rule 5 — a silent `self.m()` reaches a
  //   trait's declaration: Deref target first, then the trait proven by impl
  //   edges / a trait body's supertraits, else a sole non-std project trait.
  // - bd tea-rags-mcp-s3i8m (letCall S4b) — a callee's return or a struct's
  //   field type spelled through `use` is placed via the declaring file's own
  //   imports (re-exports followed), never the caller's.
  // - bd tea-rags-mcp-sjego (renames) — the crate map also answers a renamed
  //   dependency's key (`webxr-api = { package = "servo-webxr-api" }`, direct
  //   or via `[workspace.dependencies]`) and a `[lib] name` member's package
  //   name, each only when it names one member and no member already owns it.
  // - bd tea-rags-mcp-s3i8m (rule 5 A/B) — a trait impl is a re-opening type
  //   fact (trait, line span, a generic Self's bounds); trait self-calls prove
  //   traits from `impl<T: B> Tr for T` bounds and from same-crate impls only.
  // - bd tea-rags-mcp-s3i8m Task 1d — a typed pattern receiver's member miss
  //   reaches a smart pointer's pointee and a project trait's provided
  //   method, and drops only when the miss is proven.
  // - bd tea-rags-mcp-s3i8m.6 (R3-1) — a call records its member token position
  //   (`memberStartLine` / `memberStartColumn`); nothing reads it yet.
  // - bd tea-rags-mcp-s3i8m.7 T3 arm C — a member the external signature table
  //   holds as a stable inherent item of a std/dependency type is external even
  //   when a project trait or blanket owner shares its name.
  // - bd tea-rags-mcp-s3i8m (shadow) — a call-result `let` a scoped pattern,
  //   a destructuring `let` or a parameter also binds stays recorded: its
  //   window is cut around the rows the pattern rebinds the name in, instead
  //   of the name declining.
  // - bd tea-rags-mcp-s3i8m.6 (R3a) — a last `rustAnalyzerScip` pass answers the
  //   residual from rust-analyzer's SCIP definition at the member token; a
  //   SCIP-proven external target with a project namesake is externalSkipped.
  // - bd tea-rags-mcp-s3i8m.6 (R3b) — a call SCIP proves targets an in-project
  //   type or local (tuple constructor, closure variable) has no in-project def.
  // - bd tea-rags-mcp-s3i8m.7 T3b — an external receiver's member returns its
  //   table-declared inherent type, and a type with a table `Deref::Target`
  //   (`MutexGuard`, `Ref`, `String`) hands members it does not answer to it.
  // - bd tea-rags-mcp-s3i8m.6 (R3c) — a SCIP answer naming an external trait's
  //   DECLARATION member is external only when no project `impl Trait for X`
  //   declares that member; otherwise the site stays in the denominator.
  // - bd tea-rags-mcp-s3i8m.6 (R3d) — on a receiver proven to be a std type
  //   (`usize::from`, a `Sender` local's `.clone()`) only a project impl of the
  //   trait FOR that type keeps the site in the denominator.
  // - bd tea-rags-mcp-s3i8m.7 T3c (path calls) — a `let` bound from
  //   `ExtType::assoc(..)` (`Vec::new()`, `Url::parse(s)?`) takes the table's
  //   declared return; `Arc::new(x)` carries a typed local `x` as its argument.
  // - bd tea-rags-mcp-s3i8m.7 T3c (fields) — a public field of a std/dependency
  //   struct (`range.start`) types the next hop from the table.
  // - bd tea-rags-mcp-s3i8m.7 T3c (std traits) — a member no declaration answers
  //   reads the closed std-trait return model: `to_string` → `String`, `cmp` →
  //   `Ordering`, `eq` → `bool`, `clone` → `Self` when no deref target could
  //   take it, `Type::default()` → the type.
  // - bd tea-rags-mcp-s3i8m.7 T-A1 — the external signature table (extractor 2)
  //   holds free functions in a value namespace apart from types (`mpsc::channel`
  //   → `(Sender<T>, Receiver<T>)`) and tuple returns; nothing reads them yet.
  versions: { chunking: 4, walker: 11, codegraphSchema: 2 },
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
