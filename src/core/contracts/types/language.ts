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

import type { AstNode, MaterializedTree } from "./ast.js";
import type { ChunkingHook, LanguageChunkClassifier } from "./chunker.js";
import type {
  CallContext,
  CallRef,
  DispatchFanoutOutcome,
  FileExtraction,
  GraphEdges,
  NamedSymbol,
  RelPath,
  SymbolResolutionTarget,
} from "./codegraph.js";

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
  resolveDispatch: (call: CallRef, ctx: CallContext) => DispatchFanoutOutcome;
}

/**
 * The two language-specific primitives the generic CHA cone-dispatch engine
 * (`ConeDispatchResolver`, `domains/language/cone-dispatch.ts`) needs from each
 * language (bd tea-rags-mcp-f10y). The CHA fan-out algorithm itself —
 * descendants ∩ override, K-threshold, cone / poly-base policy, confidence —
 * is language-neutral; the ONLY language-specific operations are (a) resolve a
 * type name → declaring file, and (b) find a method declared DIRECTLY on a type
 * (the override pin). One implementation per language (`RubyConeTypeLocator`,
 * `PythonConeTypeLocator`).
 *
 * The engine OWNS the poly-base composition (`findDirectMethod(T,m) ??
 * { resolveTypeFile(T), null }`) — `resolveBaseDecl` is deliberately NOT on the
 * locator so no language's base-decl assumption leaks into the shared core.
 */
export interface ConeTypeLocator {
  /** Resolve a (possibly qualified) type name to its declaring file, or null. */
  resolveTypeFile: (typeName: string, ctx: CallContext) => RelPath | null;
  /** Method declared DIRECTLY on `typeName` (the override pin), or null. */
  findDirectMethod: (typeName: string, member: string, ctx: CallContext) => SymbolResolutionTarget | null;
}

/**
 * The language-specific predicates the generic `ExternalCallClassifier`
 * (`domains/language/external-classifier.ts`) needs to decide whether an
 * UNRESOLVED call targets an external library / framework runtime rather than an
 * in-project resolver miss (bd tea-rags-mcp-cai0). The engine owns the
 * language-neutral receiver-shape branch (bare call vs qualified receiver);
 * these two predicates own the language-specific decisions — which bare member
 * names are framework vocabulary, and whether a qualified receiver resolves
 * in-project. One implementation per language (`RubyExternalVocabulary`, …).
 * Mirrors `ConeTypeLocator`.
 */
export interface ExternalVocabulary {
  /**
   * Is this no-receiver member a framework/runtime/builtin name (zero project
   * defs)? `ctx` (optional) carries the caller's `gemfileContent` so a gem-gated
   * vocabulary's bare-call names are recognised as external ONLY when the gem is
   * declared (`catalogueForGemfile(ctx.gemfileContent)`); an implementation that
   * does not gate its vocabulary, or a caller that threads no `ctx`, is unaffected
   * (bd tea-rags-mcp-adx5p.1).
   */
  isBareCallExternal: (member: string, ctx?: CallContext) => boolean;
  /**
   * Does this qualified receiver name a gem/stdlib symbol (no in-project target)?
   *
   * `atLine` (optional, 1-based) enables position-aware local-binding type lookup:
   * when a lowercase receiver resolves to a LOCAL VARIABLE whose inferred type is a
   * KNOWN non-in-project class (Ruby core `Hash`/`String`/`Integer`, or a gem type
   * like `Sawyer::Resource`), the call is correctly classified as external rather
   * than counted as an in-project miss (bd tea-rags-mcp-dnd9s). When `atLine` is
   * absent the implementation falls back to the pre-dnd9s behaviour so callers that
   * don't thread the call's `startLine` are unaffected.
   *
   * `member` (optional) is the call's member name — for a `super` CallRef it is
   * the ENCLOSING method's name. It lets a `super` to a Ruby runtime hook
   * (`method_missing`, `respond_to_missing?`, …) be classified external even
   * when the enclosing class has in-project ancestors: such a hook's `super`
   * always targets BasicObject / Module in the runtime when no ancestor DEFINES
   * the hook (the super pass suppresses the file-only fallback and drops it).
   * Absent `member` preserves the pre-existing behaviour (bd 08tss follow-up).
   */
  isQualifiedReceiverExternal: (receiver: string, ctx: CallContext, atLine?: number, member?: string) => boolean;
  /**
   * Is this MEMBER, on an untyped qualified receiver, an external base-class
   * instance method (e.g. `agent.update` → ActiveRecord::Base#update)? Optional:
   * a vocabulary that does not distinguish the member axis omits it and the
   * classifier treats it as `false` (no behavior change). bd tea-rags-mcp-i9id8.
   */
  isQualifiedMemberExternal?: (member: string) => boolean;
  /**
   * bd tea-rags-mcp-83cl7 — is this MEMBER part of the language's CORE
   * vocabulary (`each`, `to_s`, `first`, `join`)? The VOCABULARY half of the
   * core-homonym classification; the classifier pairs it with
   * {@link isReceiverTyped}. Optional: a vocabulary that omits it contributes
   * nothing to the `coreAmbiguous` bucket (every miss stays in the denominator).
   */
  isCoreAmbiguousMember?: (member: string) => boolean;
  /**
   * bd tea-rags-mcp-83cl7 — does this receiver have a KNOWN static type
   * (localBinding / ivar / chain / declared param), or is it a structurally
   * self-identifying receiver (`self`, `super`, a constant)? The TYPEDNESS half
   * of the core-homonym classification, and its precision guard: a TYPED
   * receiver whose class genuinely defines the core-named member must stay a
   * REAL miss, so returning `true` here forbids the `coreAmbiguous` bucket.
   *
   * `atLine` (1-based) is the call's `startLine`, needed for position-aware
   * local-binding lookup. Optional: a vocabulary that omits the predicate is
   * treated as "always typed", which disables the bucket entirely — the
   * conservative direction (never hides a miss).
   */
  isReceiverTyped?: (receiver: string, ctx: CallContext, atLine?: number) => boolean;
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
  run: (root: AstNode, ctx: WalkContext) => T;
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

/**
 * One collected symbol-range row: a fully-qualified `symbolId` plus its
 * 1-indexed line span and lexical scope chain. The shape the codegraph walker
 * consumes (`FileExtraction.chunks` symbol-range input) and the
 * `CollectSymbolsFn` result (yl9tv).
 */
export interface CollectedSymbolRange {
  symbolId: string;
  startLine: number;
  endLine: number;
  scope: string[];
}

/**
 * Walks a materialized AST and collects every named symbol's fully-qualified id
 * + line range. The kernel implementation (`domains/language/kernel`) is pure —
 * the cross-language `composer` is passed in so the function carries no state.
 * Injected via DI into the codegraph provider (trajectory may not import
 * `domains/language`) and dynamically imported by the chunker worker (yl9tv).
 *
 * Accepts `MaterializedTree` (not the native `Parser.Tree`) so callers that
 * already materialized the tree (chunker worker, extractOneFile) can pass it
 * directly without re-touching native accessors (rdv7d fix).
 */
export type CollectSymbolsFn = (
  tree: MaterializedTree,
  nameOf: (node: AstNode) => NamedSymbol | NamedSymbol[] | null,
  separator: string,
  disambiguateOverloads: boolean,
  composer: SymbolIdComposer,
) => CollectedSymbolRange[];

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
  isInstanceMethod: (node: AstNode) => boolean;
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
  nameExtractor?: (node: AstNode, code: string) => string | undefined;
  /**
   * Child chunk types that bypass the minimum-length floor in `processChildren`.
   * For declaration-only AST shapes (Java abstract / interface methods) the
   * signature IS the symbol and must be emitted regardless of length so
   * `find_symbol("Pair#getLeft")` resolves. bd tea-rags-mcp-52e8.
   */
  keepShortChildChunkTypes?: string[];
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
 * `LanguageConfig.walker` argument (a parsed tree plus the chunk boundaries
 * already produced for the file). The walker emits a `FileExtraction` for graph
 * construction.
 *
 * `tree` is `MaterializedTree` (not the native `Parser.Tree`) so callers that
 * already materialized the tree (chunker worker, extractOneFile) can pass it
 * directly without re-touching native accessors (rdv7d fix).
 */
export interface WalkInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
  /**
   * Raw contents of the project's `Gemfile`, threaded per run so extraction-time
   * DSL consumers (emit / declare / type-source) compose a gem-gated catalogue
   * (`catalogueForGemfile`) for THIS project. Undefined → the FULL catalogue
   * (gating off, byte-identical to pre-gating). Only the Ruby walker reads it
   * today (bd tea-rags-mcp-adx5p.1b).
   */
  gemfileContent?: string;
}

/**
 * The codegraph-extraction capability for one language. `walk` produces the
 * per-file `FileExtraction`; `nameOf` maps an AST node to its symbol
 * descriptor(s) — an array for Ruby DSL macros (`attr_accessor :a, :b`) that
 * emit multiple symbols from one node, `null` for non-symbol nodes.
 */
export interface LanguageWalker {
  walk: (input: WalkInput) => FileExtraction;
  /**
   * Map an AST node to its symbol descriptor(s). `gemfileContent` (optional) is
   * the run's raw Gemfile, threaded so a language can gate gem-conditional
   * class-body DSL grammar to the project's declared gems — only Ruby reads it
   * (`catalogueForGemfile`); every other language ignores the arg. Undefined →
   * the FULL catalogue (gating off, byte-identical to pre-gating). The kernel
   * `collectSymbols` calls this per node with a call-site-bound `gemfileContent`
   * (bd tea-rags-mcp-o5kwh).
   */
  nameOf: (node: AstNode, gemfileContent?: string) => NamedSymbol | NamedSymbol[] | null;
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
   * dispatching call site expands to N `(caller, callee)` edges. Returns empty
   * edges when the call does not dispatch through a table; returns an
   * `ambiguous` outcome when the fan-out exceeded the corpus-adaptive
   * DispatchFanoutPolicy cap (bd tea-rags-mcp-f2jsb) — the provider records it
   * as an ambiguousFanout aggregate instead of materializing edges.
   */
  resolveDispatch: (call: CallRef, ctx: CallContext) => DispatchFanoutOutcome;
  /**
   * Optional per-file edge resolution (tea-rags-mcp Ruby Zeitwerk +
   * inheritance). When present, the codegraph provider delegates ALL file→file
   * edge construction for this language to it — covering channels the generic
   * import loop can't see (Ruby `zeitwerk:` constant refs, inheritance/mixins).
   * Languages whose file graph is purely explicit imports omit it and the
   * provider falls back to the generic synthesised-call loop. Mirrors
   * `CallResolver.resolveFileEdges`.
   */
  resolveFileEdges?: (extraction: FileExtraction, ctx: CallContext) => GraphEdges["fileEdges"];
  /**
   * Optional: does this UNRESOLVED call target an external library / runtime
   * import rather than an in-project resolver miss? (tea-rags-mcp-ykj7). The
   * provider consults it ONLY for calls `resolve`/`resolveDispatch` could not
   * pin to a target, so it never reclassifies a resolved call. Returning `true`
   * excludes the call from the `resolveSuccessRate` denominator (it is counted
   * separately as `callsExternalSkipped`), so the metric reflects the resolver's
   * capability on PROJECT-INTERNAL calls instead of the un-resolvable
   * external-library noise (`Math.max`, `fs.readFile`, `Net::HTTP.get`, …).
   *
   * Mirrors `CallResolver.targetsExternalImport`. Languages that omit it keep
   * every unresolved call in the denominator (conservative — never over-shrinks).
   */
  targetsExternalImport?: (call: CallRef, ctx: CallContext) => boolean;
  /**
   * Optional: is this UNRESOLVED, non-external call a CORE HOMONYM
   * (tea-rags-mcp-83cl7)? A core-vocabulary member (`each`, `to_s`, `first`) on
   * an UNTYPED receiver, where some project class defines the same short name —
   * the real callee is the runtime, so counting it as a recall hole is a phantom.
   * Returning `true` moves the call into `callsCoreAmbiguous`, out of the
   * `inProjectEdgeRecall` denominator. A TYPED receiver whose class defines the
   * member must answer `false` (precision runs in reverse — a wrong `true` hides
   * a real miss). Mirrors `CallResolver.targetsCoreAmbiguousMember`.
   */
  targetsCoreAmbiguousMember?: (call: CallRef, ctx: CallContext) => boolean;
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
  /**
   * Optional codegraph-ONLY exclusion globs — path patterns for files that parse
   * as this language but are NOT part of the application call graph (Rails
   * `db/migrate/**` procedural schema ops, generated schema snapshots). The
   * generic `buildCodegraphExclusionFilter` aggregates these across EVERY
   * registered language so the codegraph engine carries no language-specific
   * knowledge of its own. `.gitignore` glob syntax. Absent → the language
   * contributes nothing (conservative). codegraph-only: semantic ingest still
   * indexes the files; only the fan-graph drops them. bd tea-rags-mcp-biwbq.
   */
  codegraphExclusionGlobs?: readonly string[];
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

/**
 * Normalized receiver-type reference emitted by a Ruby type source (YARD /
 * Sorbet / RBS). `class` vs `instance` mirrors {@link LocalBinding.valueKind};
 * `union` fans out to a CHA cone; `container` carries an element type for
 * `Array<Post>` / `Relation<X>` element flow. Lives in contracts because
 * `CallContext.structuredReturnTypes` (Task 1.1) references it.
 */
export type RubyTypeRef =
  | { form: "class" | "instance"; name: string }
  | { form: "union"; members: RubyTypeRef[] }
  | { form: "container"; element: RubyTypeRef };

export type CodegraphTier = "maximum" | "high" | "moderate" | "minimal" | "none";

/**
 * Ruby's codegraph capability is not a single tier — it depends on the
 * annotation tier present in the project (untyped vs YARD vs RBS/Sorbet).
 */
export interface TypingTieredCodegraph {
  untyped: CodegraphTier;
  yard: CodegraphTier;
  "rbs/sorbet": CodegraphTier | "tbd";
}

/**
 * Static, per-language capability ceiling for the language-compatibility
 * matrix. The MEASURED `resolveSuccessRate` is NOT part of this — it is
 * per-index state owned by prime. Aggregated by `LanguageFactory.capabilities()`
 * and rendered by `domains/language/capability/{rule,readme}.ts`.
 */
/**
 * One AST chunker-hook entry on a language's capability descriptor. `name` is the
 * implementation hook id (e.g. `bodyChunker`); `short` is a REQUIRED, ≤4-word
 * product phrase describing what the hook DOES (`"method-body splitting"`), never
 * the impl name. The README renderer shows only `short`; `name` is retained for
 * traceability. Decoupled from the runtime `ChunkingHook` — this is hand-written
 * descriptor prose, not the executable chain (spec
 * `docs/superpowers/specs/2026-07-04-capability-table-redesign-design.md` §1).
 */
export interface AstHookDescriptor {
  name: string;
  short: string;
}

export interface LanguageCapability {
  language: string;
  ast: { tier: "full" | "partial" | "none"; engine: string; hooks?: AstHookDescriptor[] };
  tests: { tier: "high" | "medium" | "low" | "na"; detection: string; tech: string };
  codegraph: { tier: CodegraphTier | TypingTieredCodegraph; tech: string };
  /** README prose extras (humans only). */
  notes?: string;
}
