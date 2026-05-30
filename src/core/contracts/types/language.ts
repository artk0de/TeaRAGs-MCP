/**
 * Per-language code-consolidation contracts — the interfaces the
 * `domains/language/` leaf domain implements and the `ingest` chunker /
 * `codegraph` provider consume via an injected `LanguageFactoryDescriptor`.
 *
 * Lives in `contracts/` per `.claude/rules/domain-boundaries.md`: interfaces
 * belong to the foundation layer, no runtime, no Zod. Concrete implementations
 * (the resolver components, walker passes, the dispatch fan-out, the symbolId
 * mapper) live outside `contracts/`.
 *
 * Spec: `docs/superpowers/specs/2026-05-25-domains-language-consolidation-design.md`
 */

import type Parser from "tree-sitter";

import type { ChunkingHook, LanguageChunkClassifier, MacroSymbol } from "./chunker.js";
import type { CallContext, CallRef, DispatchEdge, FileExtraction, NamedSymbol, SymbolResolutionTarget } from "./codegraph.js";

/** A loaded tree-sitter language module. Some packages expose the grammar
 *  under a nested key (`{ typescript, tsx }`); `LanguageKernel.extractLanguage`
 *  picks the right one. */
interface TreeSitterLanguageModule {
  default?: unknown;
  typescript?: unknown;
  [key: string]: unknown;
}

/**
 * The three-state result of a single resolution pass. Replaces the old
 * two-state `SymbolResolutionTarget | null` return so a pass can express the
 * load-bearing **drop** — "this is my case, but it resolves to NO edge, and the
 * chain must stop here" — distinctly from **continue** — "not my case, try the
 * next pass". Conflating the two as `null` hid bugs where a guard pass (e.g.
 * `super` without `classExtends`) silently fell through to a later pass and
 * emitted a wrong edge (bd tea-rags-mcp-4rgg).
 *
 *   - `resolved` — pass owns the call and produced a target (edge to emit).
 *   - `drop`     — pass owns the call but emits NO edge; STOP the chain.
 *   - `continue` — not this pass's case; try the next pass.
 *
 * Runtime constructors `resolved()`, `DROP`, `CONTINUE` live in
 * `contracts/resolution.ts` (this types file stays runtime-free).
 */
export type SymbolResolutionOutcome =
  | { kind: "resolved"; target: SymbolResolutionTarget }
  | { kind: "drop" }
  | { kind: "continue" };

/**
 * One resolution **approach** inside a language resolver's chain (e.g.
 * `super`, `this`-intra-class, `bare-import`). Each strategy answers a single
 * question — "can I resolve this call my way?" — and returns a
 * `SymbolResolutionOutcome`. The language resolver runs an ordered
 * `SymbolResolutionStrategy[]` first-decisive-wins via `resolveViaChain`; the
 * order encodes precedence (it mirrors the original `<lang>-resolver.ts`
 * if-ladder).
 *
 * `name` is a stable debug id (`"super"`, `"namedImport"`, …) for tracing which
 * pass decided a call. `deps` (tsconfig options, ambiguous-resolve mode, path
 * mapper) are injected through each concrete strategy's constructor — NOT part
 * of this interface. See spec §1b.
 */
export interface SymbolResolutionStrategy {
  readonly name: string;
  attempt: (call: CallRef, ctx: CallContext) => SymbolResolutionOutcome;
}

/**
 * Language-neutral lookup-table dispatch fan-out (bd tea-rags-mcp-n0zj). A
 * single dispatching call-site expands to N `(caller, callee)` edges, so the
 * return shape is fan-out — distinct from `SymbolResolutionStrategy`'s single-target
 * `resolve`. One implementation is shared by every language resolver rather
 * than duplicated per language.
 */
export interface DispatchResolverComponent {
  resolveDispatch: (call: CallRef, ctx: CallContext) => DispatchEdge[];
}

/**
 * Inputs shared across a file's extraction passes. Mirrors the walker's
 * `ExtractInput` minus the parsed `Tree` (passes receive the root node
 * directly). `dispatchTableNames` is threaded from the table pass into the
 * call pass — the one data dependency between otherwise-independent passes
 * (the call pass must know which subscript receivers are real dispatch tables
 * before tagging `CallRef.dispatch`).
 */
export interface WalkContext {
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
  dispatchTableNames?: ReadonlySet<string>;
}

/**
 * One **projection** of the AST onto a single facet of `FileExtraction`
 * (imports, calls, class-extends, field-types, param-bindings,
 * dispatch-tables, callback-params). Pure: same `(root, ctx)` → same `T`.
 *
 * A shared **form**, not a shared return type — each pass yields its own facet
 * shape. The walker facade orchestrates: it runs every pass and drops each
 * result into the matching `FileExtraction` slot (a **union** of facets, NOT a
 * first-hit chain like `SymbolResolutionStrategy`). An extension point is a new facet
 * = one new `ExtractionPass` + one `FileExtraction` slot. See spec §1b.
 */
export interface ExtractionPass<T> {
  run: (root: Parser.SyntaxNode, ctx: WalkContext) => T;
}

/** Options controlling how `SymbolIdComposer.compose` joins prefix + name. */
export interface ComposeSymbolIdOptions {
  /**
   * `"instance"` → `#` separator (instance method); `"static"` → `.`
   * (class/static method). Omitted → use `scopeSeparator` (namespace / nested
   * scope). Per `.claude/rules/symbolid-convention.md`.
   */
  methodKind?: "instance" | "static";
  /** Namespace separator for nested scopes (`"::"` Ruby/Rust, `"."` TS/Py/Go/Java). Default `"."`. */
  scopeSeparator?: string;
  /** When true, emit `localName` verbatim regardless of prefix (already-absolute id). */
  absolute?: boolean;
}

/**
 * The single source of truth for `.claude/rules/symbolid-convention.md`. Every
 * part of the project that BUILDS a symbolId — the chunker engine, language
 * chunker hooks, the codegraph walker/provider, the resolvers — composes it
 * through ONE injected `SymbolIdComposer` rather than re-implementing the
 * `#`/`.`/`::` rules locally (today the convention is duplicated in 5+ sites:
 * `tree-sitter.ts:buildSymbolId` + `composeParentSymbol`, the go/js chunker
 * hooks, `provider.ts:joinSymbol`, the go resolver). Consumers receive it via
 * DI from `api/internal/`; they never import the concrete composer directly.
 */
export interface SymbolIdComposer {
  compose: (prefix: string, localName: string, opts?: ComposeSymbolIdOptions) => string;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-language CAPABILITY interfaces (spec §1, §4). A `LanguageProvider` is a
// thin facade composing four OPTIONAL capabilities; `LanguageFactoryDescriptor.create`
// spawns one per language (with its own tree-sitter Parser). The fields below
// are split between `kernel` and `chunkerHooks` from today's duplicated
// `LanguageDefinition` (chunker/config.ts) + `LanguageConfig` (provider.ts).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parser loading + per-language detection/config shared by a language's
 * capabilities. Owns the per-language **detection** (`isInstanceMethod`) that
 * `symbolid-convention.md` mandates power BOTH the chunker and the walker, plus
 * the namespace `scopeSeparator` and overload-disambiguation flag previously
 * declared twice (once per concern). symbolId **formatting** is a separate
 * cross-language concern — see `SymbolIdComposer`.
 */
export interface LanguageKernel {
  /** Lazily load the tree-sitter language module for this language. */
  loadModule: () => Promise<TreeSitterLanguageModule | null>;
  /** Extract the grammar from a loaded module when nested (e.g. `{ typescript, tsx }`). */
  extractLanguage?: (mod: TreeSitterLanguageModule) => unknown;
  /**
   * Namespace separator joining nested scope names: `"::"` (Ruby/Rust), `"."`
   * (TS/JS/Python/Go/Java). Default `"."`. Applies to namespaces / nested
   * classes / top-level chains — NOT to the class↔method boundary (that is the
   * `#`/`.` rule owned by `SymbolIdComposer`).
   */
  scopeSeparator?: string;
  /**
   * AST node types that act as **intermediate scope containers** between an
   * outer chunkable container and a leaf child chunk. When set, the chunker
   * accumulates names of these node types while traversing into the child so
   * the leaf's `parentSymbolId` matches the fully-qualified scope. Required for
   * nested-namespace languages (Ruby `module A; module B; class C; def foo`).
   * bd tea-rags-mcp-bdvm.
   */
  scopeContainerTypes?: string[];
  /**
   * When true, duplicate composed symbolIds inside one file are disambiguated
   * with `~N` (1-based; first unchanged, second → `~2`, …) instead of being
   * deduped. Mirrors the chunker convention so cg_symbols + Qdrant payload
   * agree on a per-physical-AST-node identifier. Enable for languages where
   * overloads carry distinct bodies (Java — bd tea-rags-mcp-a466). bd a466/d4ab.
   */
  disambiguateOverloads?: boolean;
  /**
   * The single per-language **detection** powering both the chunker and the
   * walker (`symbolid-convention.md`). Returns `true` when the node is an
   * instance method declaration (binds to `this`/`self`), `false` for
   * class/static/abstract methods and non-method nodes. The `#`-vs-`.`
   * separator decision derives from this flag.
   */
  isInstanceMethod: (node: Parser.SyntaxNode) => boolean;
}

/**
 * Chunking config for one language (the chunk-boundary slice of today's
 * `LanguageDefinition`). All fields are how the chunker engine splits this
 * language's source into searchable chunks. Optional on `LanguageProvider`:
 * doc languages still need this, code-only kernels may omit fields.
 */
export interface LanguageChunkerHooks {
  /** AST node types that should be chunked. */
  chunkableTypes: string[];
  /**
   * Child types to look for when a chunkable node exceeds `maxChunkSize`; the
   * chunker recurses to find these smaller units.
   */
  childChunkTypes?: string[];
  /**
   * Always extract child chunks from container types regardless of size. In
   * Ruby, methods always live inside classes/modules, so they must always be
   * extracted to stay searchable.
   */
  alwaysExtractChildren?: boolean;
  /** Flags documentation languages (markdown, etc.) for content-type filtering. */
  isDocumentation?: boolean;
  /** Language-specific chunking hooks (ordered chain). */
  hooks?: ChunkingHook[];
  /** Custom name extraction for language-specific node types (e.g. RSpec call nodes). */
  nameExtractor?: (node: Parser.SyntaxNode, code: string) => string | undefined;
  /**
   * Child chunk types that bypass the minimum-length floor in `processChildren`.
   * For declaration-only AST shapes (Java abstract / interface methods) the
   * signature IS the symbol and must be emitted regardless of length so
   * `find_symbol("Pair#getLeft")` resolves. bd tea-rags-mcp-52e8.
   */
  keepShortChildChunkTypes?: string[];
  /**
   * Extract synthetic method symbols from a class/module container's body for
   * languages with `def`-less method declarations (Ruby DSL macros:
   * `attr_accessor`, `delegate`, `define_method`, …). Returns one `MacroSymbol`
   * per declared method at the container's scope. The chunker engine emits a
   * `chunkType="function"` chunk per result so bare-id call resolution can land
   * on `Class#accessor` and `get_callers`/`get_callees` work on Rails code (bd
   * tea-rags-mcp-3nf3 / zy3f). Omitted for languages with no such idiom. The
   * engine reaches this via the provider (no direct `domains/language/` import).
   *
   * Contrast with `classifier`: `macroSymbols` yields container-level synthetic
   * METHOD symbols whose final symbolId the engine STILL composes against the
   * class scope with the `#`/`.` separator (`pushMacroSymbolChunk`).
   */
  macroSymbols?: (containerNode: Parser.SyntaxNode) => MacroSymbol[];
  /**
   * Per-language node→chunk classifier. When present, the engine consults it for
   * each chunkable node before its generic shaping. A `ChunkDecision.emit` carries
   * one or more `EmittedChunk`s whose symbolIds are ALREADY composed by the
   * provider — the engine emits each verbatim (no scope join) at the node's own
   * source range, in array order at consecutive indices (`index + i`), flagged
   * `claimed`. Used by Go (method/type shaping) and JavaScript (CommonJS /
   * pre-class assignment shapes, `methods.forEach` dispatch, nested
   * defineProperty getters — the former `chunkSymbols` fan-out). Absent for
   * languages whose default shaping is always right (TypeScript, Python, Java,
   * Rust, Bash, Ruby, Markdown). Reached via the provider (no direct
   * `domains/language/` import — the reverse-guard forbids it).
   */
  classifier?: LanguageChunkClassifier;
}

/**
 * Input passed to `LanguageWalker.walk` — mirrors today's
 * `LanguageConfig.walker` argument (a parsed `Tree` plus the chunk boundaries
 * already produced for the file). The walker emits a `FileExtraction` for graph
 * construction.
 */
export interface WalkInput {
  tree: Parser.Tree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

/**
 * The codegraph-extraction capability for one language. `walk` produces the
 * per-file `FileExtraction`; `nameOf` maps an AST node to its symbol
 * descriptor(s) — an array for Ruby DSL macros (`attr_accessor :a, :b`) that
 * emit multiple symbols from one node, `null` for non-symbol nodes.
 */
export interface LanguageWalker {
  walk: (input: WalkInput) => FileExtraction;
  nameOf: (node: Parser.SyntaxNode) => NamedSymbol | NamedSymbol[] | null;
}

/**
 * The per-language call-resolution facade. Mirrors `CallResolver`
 * (`contracts/codegraph.ts`) but is the LANGUAGE-domain surface: it composes an
 * ordered `SymbolResolutionStrategy[]` chain internally (first-decisive-wins via
 * `resolveViaChain`) and a shared `DispatchResolverComponent` for lookup-table
 * fan-out — both implementation details the interface does not expose.
 */
export interface LanguageSymbolResolver {
  /** Resolve a single call site to its target, or `null` to drop the edge. */
  resolve: (call: CallRef, ctx: CallContext) => SymbolResolutionTarget | null;
  /**
   * Fan-out resolution for lookup-table dispatch (bd tea-rags-mcp-n0zj): one
   * dispatching call site expands to N `(caller, callee)` edges. Returns `[]`
   * when the call does not dispatch through a table.
   */
  resolveDispatch: (call: CallRef, ctx: CallContext) => DispatchEdge[];
}

/**
 * Thin per-language facade composing the OPTIONAL capabilities. A code language
 * has all four; a doc language (markdown) has only `chunkerHooks` (no
 * walker/resolver — its chunks use `doc:<hash>` ids with no codegraph symbols,
 * spec §1a). Created per-context by `LanguageFactoryDescriptor.create` so each owns its
 * own stateful tree-sitter `Parser`.
 */
export interface LanguageProvider {
  kernel: LanguageKernel;
  chunkerHooks?: LanguageChunkerHooks;
  walker?: LanguageWalker;
  resolver?: LanguageSymbolResolver;
}

/**
 * Keyed family resolver for `LanguageProvider`s. `create(lang)` is
 * **expensive** (loads the grammar, builds a Parser) — callers MUST cache the
 * instance per language within their context, never call it per file (spec §5).
 * Injected into `ingest`/`codegraph` as the `contracts/` interface; the chunker
 * worker is a second composition root that imports the concrete factory.
 */
export interface LanguageFactoryDescriptor {
  /** Spawn a fresh `LanguageProvider` (with its own Parser) for `lang`. */
  create: (lang: string) => LanguageProvider;
  /** The languages this factory can `create`. */
  supported: () => string[];
}
