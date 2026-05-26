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

import type Parser from "tree-sitter";

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
  readonly containerNode: Parser.SyntaxNode;
  readonly validChildren: Parser.SyntaxNode[];
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
 * A synthetic method symbol declared by a language's class-body DSL macro
 * (Ruby `attr_accessor` / `delegate` / `define_method`, etc.) — methods that
 * exist without a `def`. The chunker engine wraps each into a `CodeChunk` with
 * `chunkType="function"` and `symbolId = parent #|. name` so they look like a
 * regular method symbol, keeping the chunker's Qdrant payload in lockstep with
 * the codegraph's cg_symbols rows (`.claude/rules/symbolid-convention.md`).
 *
 * Lives in `contracts/` (relocated from the Ruby walker's `RubyMacroSymbol`,
 * mirroring the `2b94e178` precedent) so the engine reaches it through the
 * `LanguageChunkerHooks.macroSymbols` capability rather than importing a
 * `domains/language/<lang>` concrete — which the reverse-guard forbids.
 */
export interface MacroSymbol {
  /** Method name (e.g. `foo`, `foo=`). */
  name: string;
  /** `instance` joins to the parent with `#`; `static` (class-level) with `.`. */
  kind: "instance" | "static";
  /** 1-based source line where the macro call appears. */
  startLine: number;
  /** 1-based end line (inclusive) of the macro call. */
  endLine: number;
}

/** Single hook in the chain */
export interface ChunkingHook {
  name: string;
  process: (ctx: HookContext) => void;
  /** Filter nodes during chunkable/child node discovery.
   *  Return true to include, false to exclude, undefined for no opinion.
   *  Called for EACH candidate node by findChunkableNodes/findChildChunkableNodes. */
  filterNode?: (node: Parser.SyntaxNode, code: string, filePath: string) => boolean | undefined;
}
