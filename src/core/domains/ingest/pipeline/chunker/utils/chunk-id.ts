/**
 * Deterministic chunk ID generation based on content and location.
 */

import { createHash } from "node:crypto";

import type { CodeChunk } from "../../../../../types.js";

/**
 * Generate deterministic chunk ID.
 * Format: chunk_{sha256(path:start:end:symbolId:content)[:16]}
 *
 * `symbolId` participates in the hash so SIBLING chunks emitted from the
 * same AST node — same file, same line range, same content, different
 * symbolId — receive distinct Qdrant point IDs and all survive upsert.
 *
 * Two production patterns produce such siblings (see
 * `chunker/tree-sitter.ts:chunkSingleNode`):
 *
 *   1. bd tea-rags-mcp-z95o — `methods.forEach(m => app[m] = fn)` emits
 *      one chunk per HTTP verb (`app.get`, `app.post`, …) all sharing
 *      the same source range.
 *   2. bd tea-rags-mcp-d1f8 — `app.init = function init() {
 *      Object.defineProperty(this, 'router', { get: fn }); }` emits
 *      both `app.init` (the outer assignment) AND `app.router` (the
 *      nested defineProperty sibling) over the same source range.
 *
 * Without symbolId in the hash, all siblings collide on the same chunk
 * ID and only the last upsert wins — find_symbol returns empty for the
 * overwritten ones even though the chunker emitted them. `symbolId`
 * falling back to an empty string preserves the legacy hash for chunks
 * that don't carry one (markdown sections re-derive their symbolId
 * downstream via `assignNavigationAndDocSymbolId`, so the hash here
 * remains stable across that pipeline step).
 */
export function generateChunkId(chunk: CodeChunk): string {
  const { metadata, startLine, endLine, content } = chunk;
  const symbolId = metadata.symbolId ?? "";
  const combined = `${metadata.filePath}:${startLine}:${endLine}:${symbolId}:${content}`;
  const hash = createHash("sha256").update(combined).digest("hex");
  return `chunk_${hash.substring(0, 16)}`;
}
