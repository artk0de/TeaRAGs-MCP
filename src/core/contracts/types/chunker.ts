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
