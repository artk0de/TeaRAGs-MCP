import type Parser from "tree-sitter";

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { LanguageChunkClassifier } from "../../../../contracts/types/chunker.js";
import type { ChunkingHook } from "./hooks/types.js";

// Type for tree-sitter language modules
interface TreeSitterLanguageModule {
  default?: unknown;
  typescript?: unknown;
  [key: string]: unknown;
}

export interface LanguageDefinition {
  /** Function to load the language module (lazy) */
  loadModule: () => Promise<TreeSitterLanguageModule | null>;
  /** Function to extract language from module (some have nested structure) */
  extractLanguage?: (mod: TreeSitterLanguageModule) => unknown;
  /** AST node types that should be chunked */
  chunkableTypes: string[];
  /**
   * Child types to look for when a chunkable node is too large.
   * If a class/module exceeds maxChunkSize, we recurse to find these smaller units.
   */
  childChunkTypes?: string[];
  /**
   * Always extract child chunks from container types (class/module) regardless of size.
   * In Ruby, methods are always inside classes/modules, so we must always extract them.
   * Without this, small classes become a single chunk and methods are not searchable.
   */
  alwaysExtractChildren?: boolean;
  /**
   * Flag to identify documentation languages (markdown, etc.)
   * Used for filtering search results by content type
   */
  isDocumentation?: boolean;
  /** Language-specific chunking hooks */
  hooks?: ChunkingHook[];
  /** Custom name extraction for language-specific node types (e.g., RSpec call nodes) */
  nameExtractor?: (node: AstNode, code: string) => string | undefined;
  /**
   * AST node types that act as **intermediate scope containers** between
   * an outer chunkable container and a leaf child chunk. When set, the
   * chunker accumulates names of these node types while traversing into
   * the child chunk so the leaf's `parentSymbolId` matches the
   * fully-qualified scope. Required for nested-namespace languages
   * (Ruby `module A; module B; class C; def foo`). Without this the
   * chunker's `parentName` stays at the OUTERMOST container's name and
   * the leaf symbolId diverges from the codegraph's (bd tea-rags-mcp-bdvm).
   * See `.claude/rules/symbolid-convention.md`.
   */
  scopeContainerTypes?: string[];
  /**
   * Separator joining intermediate scope names (e.g. `"::"` for Ruby).
   * Used together with `scopeContainerTypes`. Defaults to `"."` when
   * `scopeContainerTypes` is set but separator is omitted (matches the
   * codegraph's default scopeSeparator for `.` languages).
   */
  scopeSeparator?: string;
  /**
   * Child chunk types that should bypass the 50-character minimum length
   * floor in `processChildren`. By default the chunker drops short
   * candidates to avoid emitting trivial one-line chunks, but for
   * languages with **declaration-only** AST shapes (Java abstract /
   * interface methods: `String findById(String id);`) the signature IS
   * the symbol and must be emitted regardless of length so
   * `find_symbol("Pair#getLeft")` resolves. bd tea-rags-mcp-52e8.
   */
  keepShortChildChunkTypes?: string[];
  /**
   * When true, duplicate composed symbolIds emitted by `processChildren`
   * are disambiguated with `~N` (1-based; first stays unchanged, second
   * becomes `~2`, etc.) instead of producing identical ids that collide
   * on the Qdrant point id. Mirrors the codegraph provider convention
   * so Qdrant payload + cg_symbols agree on a per-physical-AST-node
   * identifier. Enable for languages where overloads are valid and
   * carry distinct bodies (Java method overloads — bd tea-rags-mcp-a466).
   * Leave false for languages where same-name siblings are typically
   * accessor pairs (TS get/set) or singledispatch stub/impl pairs that
   * should keep the first-occurrence behaviour.
   */
  disambiguateOverloads?: boolean;
}

export interface LanguageConfig {
  parser: Parser;
  chunkableTypes: string[];
  childChunkTypes?: string[];
  alwaysExtractChildren?: boolean;
  isDocumentation?: boolean;
  hooks?: ChunkingHook[];
  nameExtractor?: (node: AstNode, code: string) => string | undefined;
  scopeContainerTypes?: string[];
  scopeSeparator?: string;
  keepShortChildChunkTypes?: string[];
  disambiguateOverloads?: boolean;
  /**
   * Language-agnostic node→chunk classifier capability, threaded from
   * `LanguageChunkerHooks.classifier` via the provider. The engine reads
   * `langConfig.classifier` to decide chunk type / shape per node without
   * importing the concrete `domains/language/<lang>` module. Absent for
   * languages whose default generic shaping is correct for every node.
   */
  classifier?: LanguageChunkClassifier;
}

/**
 * Language definitions - modules are NOT loaded until first use
 */
export const LANGUAGE_DEFINITIONS: Record<string, LanguageDefinition> = {
  typescript: {
    loadModule: async () => import("tree-sitter-typescript") as Promise<TreeSitterLanguageModule>,
    extractLanguage: (mod: TreeSitterLanguageModule) => {
      if (typeof mod.default === "object" && mod.default !== null && "typescript" in mod.default) {
        return (mod.default as Record<string, unknown>).typescript;
      }
      return mod.typescript;
    },
    chunkableTypes: [
      "function_declaration",
      "method_definition",
      "class_declaration",
      // tree-sitter-typescript emits `abstract_class_declaration` (NOT
      // `class_declaration`) for `abstract class X {}` — bd tea-rags-mcp-olc2.
      // Without it the abstract container is never recognized, so its methods
      // never become standalone chunks and `find_symbol("Base#foo")` misses
      // the body even though the codegraph layer has the symbol. The codegraph
      // provider already treats both node types alike (symbols/provider.ts).
      "abstract_class_declaration",
      "interface_declaration",
      "type_alias_declaration",
      "enum_declaration",
      "call_expression", // Filtered by testDslFilterHook to DSL calls in test files
    ],
    childChunkTypes: ["method_definition", "call_expression"],
    alwaysExtractChildren: true,
    // NOTE: TypeScript is now a NATIVE `domains/language/typescript` provider
    // (tea-rags-mcp-cen6) — the factory builds `typescript`
    // so the chunker hooks / walker / resolver come from
    // `TypeScriptLanguage`, not this entry. This `LANGUAGE_DEFINITIONS.typescript`
    // row is retained only so `CODE_LANGUAGES` / `LANGUAGE_MAP` still report
    // typescript as a code language; its `hooks` field is intentionally absent
    // (the native provider owns it).
  },
  javascript: {
    loadModule: async () => import("tree-sitter-javascript") as Promise<TreeSitterLanguageModule>,
    extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
    // `expression_statement` / `lexical_declaration` / `variable_declaration`
    // are kept ONLY when they carry a function value — the
    // `jsAssignmentFilterHook` drops the others so we don't chunk
    // `const x = 1` or bare statements that have no symbolId. The chunker
    // resolves the proper symbolId via `chunkSymbols` (the native provider's
    // capability) in `tree-sitter.ts:chunkSingleNode`. Mirrors codegraph
    // `jsNameOf` — see `.claude/rules/symbolid-convention.md` (bd tea-rags-mcp-kfzx).
    chunkableTypes: [
      "function_declaration",
      "method_definition",
      "class_declaration",
      "export_statement",
      "expression_statement",
      "lexical_declaration",
      "variable_declaration",
    ],
    // NOTE: JavaScript is now a NATIVE `domains/language/javascript` provider
    // (tea-rags-mcp-cen6) — the factory builds `javascript`
    // so the chunker hooks / walker / resolver / chunkSymbols
    // come from `JavaScriptLanguage`, not this entry. This
    // `LANGUAGE_DEFINITIONS.javascript` row is retained only so `CODE_LANGUAGES`
    // / `LANGUAGE_MAP` still report javascript as a code language; its `hooks`
    // field is intentionally absent (the native provider owns it).
  },
  python: {
    loadModule: async () => import("tree-sitter-python") as Promise<TreeSitterLanguageModule>,
    extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
    chunkableTypes: ["function_definition", "class_definition", "decorated_definition"],
    // bd tea-rags-mcp-t6sr — emit class methods as separate chunks so
    // `find_symbol(symbol: "Flask#__init__")` resolves to the method
    // body, matching cg_symbols.symbol_id from the codegraph provider.
    // Without this, classes chunked whole (then split by enforceMaxChunkSize
    // into anonymous `Foo#part1..partN`). `decorated_definition` covers
    // `@classmethod`/`@staticmethod` methods — unwrapped in
    // tree-sitter.ts:unwrapDecoratedDefinition for name + static detection.
    childChunkTypes: ["function_definition", "decorated_definition"],
    alwaysExtractChildren: true,
    // Nested class declarations compose with `.` per
    // .claude/rules/symbolid-convention.md (`Outer.Inner#method`). The
    // default `scopeSeparator` in composeParentSymbol is `.` so we
    // omit the explicit setting.
    scopeContainerTypes: ["class_definition"],
    // NOTE: Python is now a NATIVE `domains/language/python` provider
    // (tea-rags-mcp-cen6) — the factory builds `python`
    // so the chunker hooks / walker / resolver come from
    // `PythonLanguage`, not this entry. This `LANGUAGE_DEFINITIONS.python` row
    // is retained only so `CODE_LANGUAGES` / `LANGUAGE_MAP` still report python
    // as a code language. Python has no `hooks` chain (generic chunking) — the
    // native provider's `chunkerHooks` mirrors the chunkableTypes /
    // childChunkTypes / alwaysExtractChildren / scopeContainerTypes here 1:1.
  },
  go: {
    loadModule: async () => import("tree-sitter-go") as Promise<TreeSitterLanguageModule>,
    extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
    chunkableTypes: ["function_declaration", "method_declaration", "type_declaration", "interface_declaration"],
    // NOTE: Go is now a NATIVE `domains/language/go` provider
    // (tea-rags-mcp-cen6) — the factory builds `go`
    // so the chunker hooks / walker / resolver come from
    // `GoLanguage`, not this entry. This `LANGUAGE_DEFINITIONS.go` row is
    // retained only so `CODE_LANGUAGES` / `LANGUAGE_MAP` still report go as a
    // code language. Go has no `hooks` chain (generic chunking) — the native
    // provider's `chunkerHooks` mirrors the chunkableTypes here 1:1.
  },
  rust: {
    loadModule: async () => import("tree-sitter-rust") as Promise<TreeSitterLanguageModule>,
    extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
    // bd tea-rags-mcp-fwa1 / 2hbd / h82m / lk6i — emit impl-block methods
    // as separate chunks so `find_symbol("Searcher#new")` resolves to the
    // method body, matching cg_symbols.symbol_id from the codegraph
    // provider's `rustNameOf`. Without this, impl blocks chunked whole
    // (then split by enforceMaxChunkSize into anonymous `Foo#part1..partN`).
    // Mirrors Python t6sr / Go n7x5 / Java c5wt. `self`-param detection
    // lives in `infra/symbolid/classify.ts::rustHasSelfParam` (already
    // wired into `isStaticMethodNode`).
    chunkableTypes: [
      "function_item",
      "impl_item",
      "trait_item",
      "struct_item",
      "enum_item",
      "mod_item",
      "macro_definition",
    ],
    // Leaf chunks emitted by the chunker: methods (function_item),
    // top-level functions (also function_item), and macro definitions.
    // `impl_item` / `trait_item` / `mod_item` are intentionally excluded
    // here — they act as scope containers so `findChildChunkableNodes`
    // traverses THROUGH them to reach methods. Per `chunker-hooks.md`.
    childChunkTypes: ["function_item", "macro_definition"],
    alwaysExtractChildren: true,
    // bd tea-rags-mcp-h82m — strip generics + lifetimes from impl type
    // name so `impl<'s> Worker<'s>` → `Worker#send`, not `Worker<'s>#send`.
    // bd tea-rags-mcp-2hbd — for `impl Trait for Type`, the implementing
    // TYPE owns the method scope, NOT the trait. Read `impl_item.type`
    // field (which is the implementing type in both `impl T` and
    // `impl Trait for T` shapes — tree-sitter-rust names the
    // implementing type as the `type` field regardless of trait
    // presence).
    nameExtractor: (node: AstNode, code: string): string | undefined => {
      if (node.type !== "impl_item") return undefined;
      const ty = node.childForFieldName("type");
      if (!ty) return undefined;
      const raw = code.substring(ty.startIndex, ty.endIndex);
      // Strip generic params + lifetimes: `Worker<'s>` → `Worker`,
      // `Container<T: Clone>` → `Container`. The bare type identifier
      // is the part before the first `<`.
      const lt = raw.indexOf("<");
      return (lt === -1 ? raw : raw.slice(0, lt)).trim();
    },
    // Rust uses `::` for module/type namespacing. Methods still use
    // `#`/`.` per symbolid-convention.md — the universal separator
    // logic in composeParentSymbol handles that.
    scopeSeparator: "::",
    // Nested impl/trait/mod blocks contribute their name to the symbolId
    // scope. `struct_item` / `enum_item` listed too so a method defined
    // inside an `impl` whose type matches a previously-declared struct
    // composes correctly.
    scopeContainerTypes: ["impl_item", "trait_item", "mod_item"],
    // NOTE: Rust is now a NATIVE `domains/language/rust` provider
    // (tea-rags-mcp-cen6) — the factory builds `rust`
    // so the chunker hooks / walker / resolver come from
    // `RustLanguage`, not this entry. This `LANGUAGE_DEFINITIONS.rust` row is
    // retained only so `CODE_LANGUAGES` / `LANGUAGE_MAP` still report rust as a
    // code language. Rust has no `hooks` chain (generic chunking) — the native
    // provider's `chunkerHooks` mirrors the chunkableTypes / childChunkTypes /
    // alwaysExtractChildren / nameExtractor here 1:1, kernel carries
    // scopeContainerTypes + scopeSeparator.
  },
  java: {
    loadModule: async () => import("tree-sitter-java") as Promise<TreeSitterLanguageModule>,
    extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
    chunkableTypes: [
      "method_declaration",
      "constructor_declaration",
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "annotation_type_declaration",
    ],
    // bd tea-rags-mcp-c5wt — emit class/interface methods + constructors as
    // separate chunks so `find_symbol(symbol: "StringUtils#isEmpty")` resolves
    // to the method body, matching cg_symbols.symbol_id from the codegraph
    // provider's `javaNameOf`. Without this, classes chunked whole (then
    // split by enforceMaxChunkSize into anonymous `Foo#part1..partN`). Mirrors
    // the Python t6sr / Go n7x5 fixes. `static` modifier detection lives in
    // `infra/symbolid/classify.ts::javaHasStaticModifier` (already wired into
    // the universal `isStaticMethodNode`). Constructor `name` field equals the
    // class identifier in tree-sitter-java, so `Foo() {}` inside `class Foo`
    // composes as `Foo#Foo` (instance) per .claude/rules/symbolid-convention.md.
    //
    // childChunkTypes lists ONLY the leaf chunks we want extracted — methods
    // and constructors. We intentionally exclude `class_declaration` /
    // `interface_declaration` / `enum_declaration` here so the descent in
    // `findChildChunkableNodes` traverses THROUGH nested class bodies to
    // reach methods without stopping at the nested class itself. Nested
    // class scope-composition is handled instead by `scopeContainerTypes`
    // below, which makes `collectIntermediateScopes` walk up from the leaf
    // method and accumulate `Outer.Inner` into the symbolId. Mirrors the
    // Python t6sr config exactly (where `class_definition` is in
    // `scopeContainerTypes` but NOT in `childChunkTypes`).
    childChunkTypes: ["method_declaration", "constructor_declaration"],
    alwaysExtractChildren: true,
    // Nested class/interface/enum declarations compose with `.` per
    // .claude/rules/symbolid-convention.md (`Outer.Inner#method`). The
    // default `scopeSeparator` in composeParentSymbol is `.` so we omit it.
    scopeContainerTypes: [
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "annotation_type_declaration",
    ],
    // bd tea-rags-mcp-52e8 — abstract / interface method declarations
    // (`String findById(String id);`) are signature-only and routinely
    // shorter than the default 50-char child-chunk floor. The declaration
    // IS the symbol; emit it regardless of length so abstract API
    // surfaces are searchable via `find_symbol("Pair#getLeft")`.
    keepShortChildChunkTypes: ["method_declaration"],
    // bd tea-rags-mcp-a466 — Java overloads share a name and would
    // produce identical composed symbolIds (`StringUtils.upperCase` for
    // every overload). Suffix the N-th duplicate with `~N` so each
    // overload has a distinct symbolId addressable by find_symbol /
    // get_callers / get_callees.
    disambiguateOverloads: true,
    // NOTE: Java is now a NATIVE `domains/language/java` provider
    // (tea-rags-mcp-cen6) — the factory builds `java`
    // so the chunker hooks / walker / resolver come from
    // `JavaLanguage`, not this entry. This `LANGUAGE_DEFINITIONS.java` row is
    // retained only so `CODE_LANGUAGES` / `LANGUAGE_MAP` still report java as a
    // code language. Java has no `hooks` chain (generic chunking) — the native
    // provider's `chunkerHooks` mirrors the chunkableTypes / childChunkTypes /
    // alwaysExtractChildren / keepShortChildChunkTypes here 1:1, and its kernel
    // carries scopeContainerTypes + disambiguateOverloads.
  },
  bash: {
    loadModule: async () => import("tree-sitter-bash") as Promise<TreeSitterLanguageModule>,
    extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
    chunkableTypes: ["function_definition", "command"],
    // NOTE: Bash is now a NATIVE `domains/language/bash` provider
    // (tea-rags-mcp-cen6) — the factory builds `bash`
    // so the chunker hooks / walker / resolver come from
    // `BashLanguage`, not this entry. This `LANGUAGE_DEFINITIONS.bash` row is
    // retained only so `CODE_LANGUAGES` / `LANGUAGE_MAP` still report bash as a
    // code language. Bash has no `hooks` chain (generic chunking) — the native
    // provider's `chunkerHooks` mirrors `chunkableTypes` here 1:1, kernel
    // carries scopeSeparator. Two extensions (.sh / .bash), one grammar.
  },
  ruby: {
    loadModule: async () => import("tree-sitter-ruby") as Promise<TreeSitterLanguageModule>,
    extractLanguage: (mod: TreeSitterLanguageModule) => mod.default ?? mod,
    chunkableTypes: [
      "method", // def method_name ... end
      "singleton_method", // def self.method_name ... end
      "class", // class Foo ... end (small classes kept whole)
      "module", // module Bar ... end (small modules kept whole)
      "singleton_class", // class << self ... end
      "call", // RSpec describe/context/it (filtered by rspec-filter hook)
    ],
    // When class/module is too large, recursively look for these smaller units
    // NOTE: "singleton_class" removed from childChunkTypes - we traverse THROUGH it
    // to find the methods inside (class << self ... end contains methods)
    childChunkTypes: ["method", "singleton_method", "call"],
    nameExtractor: (node: AstNode, code: string): string | undefined => {
      if (node.type !== "call") return undefined;
      const id = node.children.find((c) => c.type === "identifier");
      const methodName = id ? code.substring(id.startIndex, id.endIndex) : "";
      const args = node.childForFieldName("arguments");
      if (args && args.namedChildren.length > 0) {
        const firstArg = args.namedChildren[0];
        const argText = code.substring(firstArg.startIndex, firstArg.endIndex);
        return `${methodName} ${argText}`;
      }
      return methodName || undefined;
    },
    // In Ruby, virtually all code lives inside class/module. Without this flag,
    // small classes become a single chunk and individual methods are not searchable.
    alwaysExtractChildren: true,
    // Bug tea-rags-mcp-bdvm — `module A; module B; class C; def foo` must
    // emit `A::B::C#foo` (matching the codegraph), not `A#foo`. Listing
    // `class`/`module` here makes the chunker accumulate their names
    // while traversing into the leaf method. `singleton_class` is the
    // `class << self` form; named scope name handled by nameExtractor.
    scopeContainerTypes: ["class", "module", "singleton_class"],
    scopeSeparator: "::",
    // NOTE: Ruby is now a NATIVE `domains/language/ruby` provider
    // (tea-rags-mcp-cen6) — the factory builds `ruby`,
    // so the chunker hooks / walker / resolver come from `RubyLanguage`, not
    // this entry. This `LANGUAGE_DEFINITIONS.ruby` row is retained only so
    // `CODE_LANGUAGES` / `LANGUAGE_MAP` still report ruby as a code language;
    // its `hooks` field is intentionally absent (the native provider owns it).
    // Removed problematic types:
    // - "lambda", "block" → too small (1 line), fragments context
    // - "do_block" → creates too many tiny chunks from iterators
    // - "rescue" → loses protected code context
    // - "singleton_class" → we pass through it to find methods inside
  },
  markdown: {
    // NOTE: Markdown is a NATIVE `domains/language/markdown` provider
    // (tea-rags-mcp-cen6, the FINAL vertical) — the factory builds it itself, so
    // the chunker hooks come from `MarkdownLanguage`, not this entry. This
    // `LANGUAGE_DEFINITIONS.markdown` row is retained only so `LANGUAGE_MAP`
    // still resolves `.md` / `.markdown` to language "markdown".
    // Markdown uses remark parser (unified/mdast) instead of tree-sitter
    // due to compatibility issues with tree-sitter-markdown grammar (requires tree-sitter 0.26+)
    // Remark is a robust CommonMark/GFM parser used by VS Code, Gatsby, etc.
    loadModule: async () => Promise.resolve(null),
    chunkableTypes: [],
    // Flag for documentation files - enables filtering in search API
    isDocumentation: true,
    // Skip tree-sitter parsing, use remark-based chunker
    skipTreeSitter: true,
  } as LanguageDefinition & { skipTreeSitter?: boolean },
};

/**
 * Code language identifiers with AST support (non-documentation).
 * Single source of truth for which languages get per-language signal stats.
 */
export const CODE_LANGUAGES: ReadonlySet<string> = new Set(
  Object.keys(LANGUAGE_DEFINITIONS).filter((lang) => !LANGUAGE_DEFINITIONS[lang].isDocumentation),
);

/**
 * Maps file extensions to language identifiers used by tree-sitter and chunker.
 */
export const LANGUAGE_MAP: Record<string, string> = {
  // TypeScript/JavaScript
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",

  // Backend languages
  ".py": "python",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",

  // Systems languages
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "c_sharp",

  // Mobile
  ".swift": "swift",
  ".kt": "kotlin",
  ".dart": "dart",

  // Functional
  ".scala": "scala",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".hs": "haskell",
  ".ml": "ocaml",

  // Scripting
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "fish",

  // Data/Query
  ".sql": "sql",
  ".proto": "proto",
  ".graphql": "graphql",

  // Markup/Config
  ".md": "markdown",
  ".markdown": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",

  // Web
  ".vue": "vue",
  ".svelte": "svelte",
};
