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
  DispatchEdge,
  DispatchFanoutOutcome,
  FileExtraction,
  GraphEdges,
  NamedSymbol,
  RelPath,
  SymbolResolutionPassPlan,
  SymbolResolutionTarget,
} from "./codegraph.js";
import type { SignalFloors } from "./trajectory.js";

/** A loaded tree-sitter language module. Some packages expose the grammar
 *  under a nested key (`{ typescript, tsx }`); `LanguageKernel.extractLanguage`
 *  picks the right one. */
interface TreeSitterLanguageModule {
  default?: unknown;
  typescript?: unknown;
  [key: string]: unknown;
}

/**
 * The four-state result of a single resolution pass. Replaces the old two-state
 * `SymbolResolutionTarget | null` return so a pass can express the load-bearing
 * **drop** — "this is my case, but it resolves to NO edge, and the chain must
 * stop here" — distinctly from **continue** — "not my case, try the next pass".
 * Conflating the two as `null` hid bugs where a guard pass (e.g. `super`
 * without `classExtends`) silently fell through to a later pass and emitted a
 * wrong edge (bd tea-rags-mcp-4rgg).
 *
 *   - `resolved` — pass owns the call and produced a target (edge to emit).
 *   - `deferred` — pass has a WEAK target (typically module-level, member not
 *                  pinned) and OFFERS it: the chain keeps running, and the
 *                  offer is emitted only if nothing stronger turns up.
 *   - `drop`     — pass owns the call but emits NO edge; STOP the chain.
 *   - `continue` — not this pass's case; try the next pass.
 *
 * `deferred` exists because `resolved` and `continue` are both wrong for a pass
 * that located the target FILE but not the member (bd tea-rags-mcp-5onmn).
 * Committing costs precision — the four `typeChecker` passes at the tail of the
 * TS chain can often pin that member, and never run once an earlier pass
 * commits. Continuing costs recall — flipping TS pass 5 to `continue` was
 * measured to lose 156 edges (2.0% of all TS edges) on tea-rags' own `src`,
 * because 178 file-only module edges have no replacement anywhere downstream
 * (bd tea-rags-mcp-pmxuv). Deferring keeps both: the member gets pinned when
 * someone can, and the module edge survives when nobody can.
 *
 * Runtime constructors `resolved()`, `deferred()`, `DROP`, `CONTINUE` live in
 * `contracts/resolution.ts` (this types file stays runtime-free).
 */
export type SymbolResolutionOutcome =
  | { kind: "resolved"; target: SymbolResolutionTarget }
  | { kind: "deferred"; target: SymbolResolutionTarget }
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
 * The two language-DATA injections the neutral untyped-dispatch narrowing
 * cascade (`buildDispatchCascade`, `domains/language/kernel/dispatch-cascade.ts`)
 * accepts (bd tea-rags-mcp-w205u). The cascade owns the ORDER — the neutral part
 * — and a language contributes only the two facts no engine can know: which
 * members are pure duck/runtime vocabulary, and how a literal receiver's source
 * text maps to a core type. A language that supplies neither gets the signature
 * half of the cascade, which is inert rather than wrong when its walker records
 * no `visibility` / `acceptsBlock`.
 */
export interface DispatchCascadeOptions {
  /** Members that are never short-name resolvable to an in-project target. */
  readonly duckVocabulary?: ReadonlySet<string>;
  /** Literal receiver source text → its core type name, or `null`. */
  readonly classifyLiteralReceiver?: (receiver: string | null) => string | null;
}

/**
 * The per-language knobs on the narrowing terminal (`resolveNarrowedFanout`).
 * Both are optional and both only ever TIGHTEN the neutral default: `cap` is
 * intersected with the corpus-adaptive `DispatchFanoutPolicy` cap (a language may
 * ask for a smaller fan, never a larger one) and `edgeKind` labels the emitted
 * edges for the component that produced them.
 */
export interface NarrowedFanoutOptions {
  /** Cap override; the EFFECTIVE cap is `min(this, policy cap)`. */
  readonly cap?: number;
  /** Edge kind carried by every emitted edge. Default `"dynamic"`. */
  readonly edgeKind?: DispatchEdge["edgeKind"];
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
  /**
   * bd tea-rags-mcp-1v12o.3 — does this call need a definition that lives
   * OUTSIDE the project, judged from the receiver's TYPE and that type's
   * hierarchy rather than from the receiver's text?
   *
   * The text arms above only see calls a library is NAMED in. A receiver typed
   * to a class no project file declares, or to a project class whose ancestor
   * closure is `external`, names no library anywhere and is still a call the
   * project can never own. Optional: a vocabulary that omits it contributes
   * nothing (every such miss stays in the denominator, as before).
   */
  isReceiverDefinitionExternal?: (call: CallRef, ctx: CallContext) => boolean;
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
  /**
   * Raw contents of the project's `Gemfile`, threaded per run so extraction-time
   * DSL consumers compose a gem-gated catalogue (`catalogueForGemfile`) for THIS
   * project. Mirrors {@link WalkInput.gemfileContent}, from which `toWalkContext`
   * copies it. Undefined → the FULL catalogue (gating off). Only Ruby reads it
   * today (bd tea-rags-mcp-adx5p.1b); every other language ignores it.
   */
  gemfileContent?: string;
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
  /**
   * Native node types of which a file must contain at least one for `walk` to
   * yield anything beyond the empty extraction. Absent → every file is walked.
   *
   * Owned by the language module, because only it knows what its walker reads.
   * A consumer holding the NATIVE tree can ask `fileIsInertForExtraction`
   * (`domains/language/kernel/extraction-fast-path.ts`) before materializing,
   * and skip a file that cannot produce output — netbox's
   * `extras/data/un_locode.py` is 111,557 lines of a data table with no def, no
   * class, no call and no import, and materializing it cost 5.33 s of that
   * corpus's 11.6 s pass 1 plus ~800 MB of live heap for an empty answer
   * (bd tea-rags-mcp-1v12o.2.4).
   */
  readonly extractionBearingNodeTypes?: readonly string[];
}

/**
 * What file, if any, an import statement names (bd tea-rags-mcp-9fgdi).
 *
 * Three states, not two. `external` is a POSITIVE verdict — the module belongs
 * to the stdlib or an installed distribution, so a resolver should stop rather
 * than keep guessing, and the external gate counts the call out of the recall
 * denominator. `unknown` means the mapper could not decide (an empty symbol
 * table on a cold pass, a PEP 420 namespace package with no `__init__.py`), and
 * every consumer must keep its pre-mapper conservative behaviour there.
 * Collapsing the two into `RelPath | null` is what makes a resolver either
 * fabricate an edge into numpy or drop a real one.
 */
export type ImportFileTarget = { kind: "project"; relPath: RelPath } | { kind: "external" } | { kind: "unknown" };

/**
 * Translate an import statement's module text into the project file it names.
 *
 * The ONE place a language answers "which file is `foo.bar`". Every consumer
 * that used to synthesise a path itself — the file-edge builder, the
 * import-match strategy, local-binding type resolution, the external
 * vocabulary — asks this instead, so the answer cannot disagree with itself
 * between the file graph and the call graph.
 *
 * `fromFile` is the file CONTAINING the import (relative imports and
 * ancestor-root inference both need it), which is not always `ctx.callerFile`:
 * the file-edge pass maps a whole `FileExtraction`'s imports at once.
 *
 * Implementations answer from `ctx.symbolTable` membership, never from disk —
 * pass 2 runs against a hydrated table whose working tree may have moved on.
 */
export interface ImportFileMapper {
  mapImportToFile: (importText: string, fromFile: RelPath, ctx: CallContext) => ImportFileTarget;
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
   * Optional: the pass is about to start, and this is how many files of this
   * language it will resolve (bd tea-rags-mcp-6aytq). Issued once per language
   * per pass-2, before the first `resolve`, by `CallEdgeResolutionRunner`.
   *
   * Advisory: the plan describes the workload, it does not instruct. A language
   * with nothing to prime omits the method. Mirrors
   * `CallResolver.prepareResolvePass`.
   */
  prepareResolvePass?: (plan: SymbolResolutionPassPlan) => void;
  /**
   * Optional: this resolver's run-scoped cache observables, as an opaque
   * JSON-able record for the pass-2 progress log (bd tea-rags-mcp-6aytq). Read
   * once per progress line, never per call. Mirrors `CallResolver.diagnostics`.
   */
  diagnostics?: () => Record<string, unknown> | undefined;
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
  /**
   * Optional persisted-schema column vocabulary — how this language's ORM turns
   * a schema snapshot into instance accessors that exist at runtime but have no
   * `def` anywhere in source (Rails `db/schema.rb` → `name` / `name=` / `name?`
   * on the owning model). The codegraph provider reads the snapshot ONCE per
   * run at the project root and hands it to the language-agnostic pre-pass; the
   * engine carries no Rails knowledge of its own, exactly as
   * `codegraphExclusionGlobs` keeps `db/migrate/**` in the Ruby domain.
   * Absent → no pre-pass for this language. bd tea-rags-mcp-8l5fo.
   */
  schemaColumnAccessors?: SchemaColumnAccessorSource;
}

/**
 * One schema table and the instance-accessor names its columns synthesize on the
 * owning model. The COLUMN→accessor expansion (reader / writer / query
 * predicate, the implicit primary key, timestamps) is the language's own
 * convention and is already applied here — the consumer sees method names only.
 */
export interface SchemaTableColumns {
  readonly table: string;
  readonly accessors: readonly string[];
  /**
   * Accessor name → the type READING it yields, for the subset of accessors
   * whose column declares a type the language can name honestly
   * (bd tea-rags-mcp-2a5oo). A `t.string "name"` column types its reader as
   * `String`, so a chain continuing past the column hop (`firm.name.strip`) has
   * a known receiver instead of dying at an untyped hop.
   *
   * SPARSE by design and never a total map over {@link accessors}: writers and
   * query predicates carry no value type, and a column whose declared type has
   * no single Ruby class (Rails `boolean`, a PG enum) contributes nothing. The
   * consumer keys these onto the owning model as structured return facts, so a
   * wrong entry is a wrong edge — absence is always the safe answer.
   */
  readonly accessorReturnTypes?: Readonly<Record<string, RubyTypeRef>>;
}

/**
 * The per-language half of the project-scope schema-column pre-pass
 * (bd tea-rags-mcp-8l5fo): where the snapshot lives, how to read it, how a table
 * name maps to a model name, and which base classes make a class a model. The
 * trajectory-side pre-pass supplies everything else (the run's class inventory,
 * the explicit table overrides, the symbol synthesis).
 */
export interface SchemaColumnAccessorSource {
  /** Project-root-relative path of the schema snapshot (`db/schema.rb`). */
  readonly schemaRelPath: string;
  /** Parse the snapshot into table → accessor names. Never throws on garbage. */
  readonly parseSchema: (source: string) => SchemaTableColumns[];
  /** Convention model name for a table (`firms` → `Firm`). Inflection fallback
   *  only — an explicit in-source declaration always wins upstream. */
  readonly modelNameForTable: (table: string) => string;
  /** A class owns a schema table only if its ancestry reaches one of these. */
  readonly modelBaseClasses: readonly string[];
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
  /**
   * Per-language {@link SignalFloors}, keyed by language. Mirrors `supported()`
   * (same native set) and is LIGHTWEIGHT the same way `capabilities()` is — it
   * imports each language's `signal-floors.ts` const and never constructs a
   * provider, so no grammar or Parser is loaded.
   *
   * Mandatory on the contract so a new language cannot ship without a decision
   * about its floors; a language where the mass signals carry no meaning
   * (markdown) declares `{}` explicitly rather than by omission.
   */
  signalFloors: () => Map<string, SignalFloors>;
}

/**
 * Normalized receiver-type reference emitted by a Ruby type source (YARD /
 * Sorbet / RBS). `class` vs `instance` mirrors {@link LocalBinding.valueKind};
 * `union` fans out to a CHA cone; `container` carries an element type for
 * `Array<Post>` / `Relation<X>` element flow. Lives in contracts because
 * `CallContext.structuredReturnTypes` (Task 1.1) references it.
 *
 * `nil` is an arm, not an absence (bd tea-rags-mcp-27q0z). A method that yields
 * a `Firm` on one path and nothing on another says
 * `union[instance(Firm), nil]`; without the arm the only two options were to
 * drop the fact (silence) or to state `Firm` unconditionally (an overstatement
 * that survives into every downstream hop). It carries no name because there is
 * nothing to name — `nil.foo` reaches no in-project definition, so the RESOLVER
 * drops nil arms before dispatch while the fact keeps stating them. Build and
 * compare these through `domains/language/kernel/type-ref.ts`, never by hand.
 */
export type TypeRef =
  | { form: "class" | "instance"; name: string }
  | { form: "union"; members: TypeRef[] }
  | { form: "container"; element: TypeRef }
  | { form: "nil" };

/**
 * The name this type carried while it was Ruby-only (E1 seam 2). Kept as an
 * alias so the 36 files that reference it — contracts, four Ruby resolver
 * modules, the codegraph trajectory, and eleven test files that may not be
 * rewritten — compile unchanged. New code says `TypeRef`.
 */
export type RubyTypeRef = TypeRef;

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

/**
 * Pseudo-language whose stamp vouches for every language at once — the key the
 * shared kernel, resolver chain and chunker sources are stamped under in
 * `CollectionEntry.languageVersions`.
 *
 * Vocabulary rather than policy, which is why it sits in contracts: the
 * language domain declares what its numbers ARE
 * (`domains/language/kernel/capability.ts`, which re-exports this) and the
 * maintenance domain compares them, and those two never import each other.
 */
export const SHARED_LANGUAGE = "*";

/**
 * The hand-bumped half of {@link LanguageCodeVersions}: which revision of OUR
 * per-language machinery produced a language's indexed data. Declared on the
 * capability descriptor, bumped by hand — a version, never a measurement
 * (`.claude/rules/language-capability-sync.md`).
 *
 * Split by REMEDY, not by source file. `chunking` moves the chunk set, so a
 * bump there costs a full reindex; `walker` and `codegraphSchema` leave point
 * ids alone and are repaired by an enrichment recompute. One number spanning
 * both halves could not route the hint, which is the whole point of tracking
 * them (bd tea-rags-mcp-frwka).
 */
export interface LanguageSupportVersions {
  /** Chunker hooks for this language — what the stored chunks LOOK like. */
  chunking: number;
  /** Walker + resolver chain for this language — which edges get emitted. */
  walker: number;
  /** The codegraph edge/kind vocabulary this language emits. */
  codegraphSchema: number;
}

/**
 * Every version axis that decides whether a language's indexed data is behind
 * the code: the upstream grammar we parse with, plus our own three.
 * `grammar` is read from the installed package, not declared — a language that
 * parses without a tree-sitter grammar (markdown) simply has none.
 */
export interface LanguageCodeVersions extends LanguageSupportVersions {
  grammar?: string;
}

export interface LanguageCapability {
  language: string;
  ast: {
    tier: "full" | "partial" | "none";
    engine: string;
    hooks?: AstHookDescriptor[];
    /**
     * npm package supplying the tree-sitter grammar, when there is one. Read at
     * runtime for the `grammar` axis of {@link LanguageCodeVersions}; omitted by
     * languages that chunk without a grammar.
     */
    grammarPackage?: string;
  };
  tests: { tier: "high" | "medium" | "low" | "na"; detection: string; tech: string };
  codegraph: { tier: CodegraphTier | TypingTieredCodegraph; tech: string };
  /** Hand-bumped code versions for this language — see {@link LanguageSupportVersions}. */
  versions: LanguageSupportVersions;
  /** README prose extras (humans only). */
  notes?: string;
}
