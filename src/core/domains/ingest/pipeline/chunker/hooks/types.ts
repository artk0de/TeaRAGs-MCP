import type Parser from "tree-sitter";

import type { BodyChunkResult, ChunkingHook, HookContext } from "../../../../../contracts/types/chunker.js";

// The hook interfaces moved to `contracts/types/chunker.ts` (foundation layer)
// so the per-language `LanguageChunkerHooks` interface can reference
// `ChunkingHook` without a domain→domain import. They are re-exported here so
// existing `import { ChunkingHook } from "../types.js"` sites keep working.
// `createHookContext` stays in the ingest domain — it is runtime, and
// `contracts/` has no runtime.
export type { BodyChunkResult, ChunkingHook, HookContext };

export function createHookContext(
  containerNode: Parser.SyntaxNode,
  validChildren: Parser.SyntaxNode[],
  code: string,
  config: { maxChunkSize: number },
  filePath = "",
): HookContext {
  return {
    containerNode,
    validChildren,
    code,
    codeLines: code.split("\n"),
    config,
    filePath,
    excludedRows: new Set(),
    methodPrefixes: new Map(),
    methodStartLines: new Map(),
    bodyChunks: [],
    skipChildren: false,
  };
}
