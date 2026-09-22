/**
 * Chunker hook contracts — the interfaces a language's chunking hooks
 * implement and the chunker engine (`tree-sitter.ts`) consumes.
 *
 * Lives in `contracts/` per `.claude/rules/domain-boundaries.md`: foundation
 * layer, no runtime, no Zod. Relocated from
 * `domains/ingest/pipeline/chunker/hooks/types.ts` so the per-language
 * `LanguageChunkerHooks` interface in `types/language.ts` can reference
 * `ChunkingHook` without a domain→domain import. The runtime helper
 * `createHookContext` stays in the ingest domain (contracts has no runtime).
 */

import type { AstNode } from "./ast.js";

/**
 * Maps a chunk to its point ID for Phase 2 git enrichment. Relocated from
 * `core/types.ts` so contracts files (provider.ts, enrichment-executor.ts)
 * reach it without crossing the contracts→core/types soft edge.
 */
export interface ChunkLookupEntry {
  chunkId: string;
  startLine: number;
  endLine: number;
  /** Non-contiguous line ranges for precise overlap detection (e.g. Ruby body groups). */
  lineRanges?: { start: number; end: number }[];
  /**
   * The chunker's payload symbolId, as stored — `#partN` suffix included; absent
   * for block chunks. The codegraph chunk-owner rule anchors on it (bd
   * tea-rags-mcp-9i2ow), so every producer of an entry carries it when the
   * chunk has one.
   */
  symbolId?: string;
}

export interface BodyChunkResult {
  content: string;
  startLine: number;
  endLine: number;
  lineRanges?: { start: number; end: number }[];
  /** Hook-provided chunk type. When present, chunker uses instead of "block". */
  chunkType?: string;
  /** Hook-provided symbolId. When present, chunker uses instead of buildSymbolId(). */
  symbolId?: string;
  /** Hook-provided chunk name. When present, chunker uses instead of parentSymbolId. */
  name?: string;
  /** Whether this chunk represents a static/class method. Default: false (instance). */
  isStatic?: boolean;
  /** Hook-provided parent name. */
  parentSymbolId?: string;
}

/** Shared mutable context passed through the hook chain */
export interface HookContext {
  // Read-only inputs
  readonly containerNode: AstNode;
  readonly validChildren: AstNode[];
  readonly code: string;
  readonly codeLines: string[];
  readonly config: { maxChunkSize: number };
  readonly filePath: string;

  // Mutable state — hooks modify these
  excludedRows: Set<number>;
  methodPrefixes: Map<number, string>;
  methodStartLines: Map<number, number>;
  /**
   * Per-child chunkType override, keyed by the child's index in
   * `validChildren` — the same addressing `methodPrefixes` uses. The engine
   * falls back to its node-type mapping when a child has no entry.
   *
   * The lever a language needs when a member's chunk SHAPE is already right and
   * only its LABEL is wrong: Swift's XCTest cases and swift-testing `@Test`
   * functions are ordinary methods whose symbolId the engine composes
   * correctly, so labelling them `test` / `test_setup` must not cost the
   * container-claiming re-emission a scope chunker does — that would move
   * symbolId composition into the hook, against
   * `.claude/rules/symbolid-convention.md`, and forfeit overload
   * disambiguation, intermediate-scope collection and the oversized-child split.
   */
  methodChunkTypes: Map<number, ChunkType>;
  bodyChunks: BodyChunkResult[];
  /** When true, processChildren() skips child chunk emission. */
  skipChildren?: boolean;
}

/**
 * A synthetic CHUNK symbol the chunker emits for a single node, with its
 * symbolId ALREADY composed by the language provider (no further scope join by
 * the engine). The engine wraps each into a `CodeChunk` with
 * `chunkType="function"` at the node's own source range, emitting them in array
 * order at consecutive chunk indices (`index + i`).
 *
 * The `symbolId` is pre-composed by the provider — node-level
 * CommonJS/prototype assignment shapes (`obj.method = fn`, `Foo.prototype.bar`,
 * `exports.foo`, `const Bar = fn`), the `methods.forEach` HTTP-verb dispatch
 * fan-out, and the nested `Object.defineProperty(this, …)` getter installs —
 * where the receiver/this resolution has already produced the full id. Internal
 * to the JavaScript provider (`jsChunkSymbols`), wrapped by `JsChunkClassifier`
 * into `ChunkDecision.emit` chunks the engine emits verbatim — reached via the
 * provider's `LanguageChunkerHooks.classifier` capability (no direct
 * `domains/language/<lang>` import — the reverse-guard forbids it). See
 * `.claude/rules/symbolid-convention.md`.
 */
export interface ChunkSymbol {
  /** Fully-composed symbolId emitted verbatim to chunk metadata. */
  symbolId: string;
  /** Display name — same string as `symbolId` for these shapes. */
  name: string;
}

/** The chunkType vocabulary the chunker emits (mirrors the engine's getChunkType return). */
export type ChunkType = "function" | "class" | "interface" | "block" | "test" | "test_setup";

/**
 * The chunk types that hold a callable BODY — the population a chunk-scoped
 * history signal is meaningfully compared within.
 *
 * Both entries are needed together because scope detection splits them: a
 * `function` chunk lands in the source bucket and a `test` chunk in the test
 * one, so a filter naming only one leaves the other scope with no distribution
 * at all. `test_setup` is excluded by `detectScope` before sampling either way.
 *
 * The excluded types are declaration surfaces rather than units of work —
 * `block` covers barrel re-exports, import lists and top-level constants, and
 * outnumbers `function` on a typical index. Ranking a method's churn against
 * theirs compares different things.
 */
export const CALLABLE_CHUNK_TYPES: readonly ChunkType[] = ["function", "test"];

/**
 * One chunk a language classifier asks the engine to emit verbatim for a node.
 *
 * The engine flags each emitted chunk `claimed` so it is exempt from the
 * min-length floor AND adjacent-merge — these carry an explicit symbolId that
 * merging would destroy.
 */
export interface EmittedChunk {
  /** Display name — same string as `symbolId` for these shapes. */
  name: string;
  /** Fully-composed symbolId, emitted verbatim (no further scope join). */
  symbolId: string;
  /** The chunk's type label. */
  chunkType: ChunkType;
}

/**
 * Per-node classification result.
 *   - `passthrough` — the engine applies its generic shaping (extractName +
 *     buildSymbolId + getChunkType) and the min-length floor. The common case.
 *   - `skip` — drop this node entirely.
 *   - `emit` — emit these explicit chunks at the node's source range (Go = 1,
 *     JS = N); the engine flags them `claimed`.
 */
export type ChunkDecision = { kind: "passthrough" } | { kind: "skip" } | { kind: "emit"; chunks: EmittedChunk[] };

/**
 * Per-language node→chunk classification. The engine consults it for each
 * chunkable AST node before its generic shaping. Optional capability on
 * `LanguageChunkerHooks` — absent ⇒ the engine uses the generic path for every
 * node. Only languages whose default shaping is wrong for some node types ship
 * one (Go, JavaScript).
 */
export interface LanguageChunkClassifier {
  classifyNode: (node: AstNode) => ChunkDecision;
}

/** Single hook in the chain */
export interface ChunkingHook {
  name: string;
  process: (ctx: HookContext) => void;
  /** Filter nodes during chunkable/child node discovery.
   *  Return true to include, false to exclude, undefined for no opinion.
   *  Called for EACH candidate node by findChunkableNodes/findChildChunkableNodes. */
  filterNode?: (node: AstNode, code: string, filePath: string) => boolean | undefined;
}
