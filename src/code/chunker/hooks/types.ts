import type Parser from "tree-sitter";

export interface BodyChunkResult {
  content: string;
  startLine: number;
  endLine: number;
  lineRanges?: Array<{ start: number; end: number }>;
}

/** Shared mutable context passed through the hook chain */
export interface HookContext {
  // Read-only inputs
  readonly containerNode: Parser.SyntaxNode;
  readonly validChildren: Parser.SyntaxNode[];
  readonly code: string;
  readonly codeLines: string[];
  readonly config: { maxChunkSize: number };

  // Mutable state — hooks modify these
  excludedRows: Set<number>;
  methodPrefixes: Map<number, string>;
  methodStartLines: Map<number, number>;
  bodyChunks: BodyChunkResult[];
}

/** Single hook in the chain */
export interface ChunkingHook {
  name: string;
  process(ctx: HookContext): void;
}

export function createHookContext(
  containerNode: Parser.SyntaxNode,
  validChildren: Parser.SyntaxNode[],
  code: string,
  config: { maxChunkSize: number },
): HookContext {
  return {
    containerNode,
    validChildren,
    code,
    codeLines: code.split("\n"),
    config,
    excludedRows: new Set(),
    methodPrefixes: new Map(),
    methodStartLines: new Map(),
    bodyChunks: [],
  };
}
