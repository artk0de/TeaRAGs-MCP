/**
 * Post-chunk pass over a single file's chunk array — the sibling of
 * `symbol-mass.ts`: both run after chunking, before the pipeline, and both
 * mutate the file's chunks in place.
 *
 * Lives beside the chunker (not in `file-processor.ts`) so the per-file
 * ingestor and the batch orchestrator can each reach it without importing one
 * another. `file-processor.ts` re-exports it — that is the historical import
 * path and stays the public one.
 */

import { createHash } from "node:crypto";
import { relative } from "node:path";

import type { CodeChunk } from "../../../../types.js";

/**
 * Post-process chunks of a single file:
 * 1. Replace readable symbolId with doc:hash for documentation chunks
 * 2. Assign navigation links (prevSymbolId / nextSymbolId) for all chunks
 *
 * Mutates chunks in place. Must be called AFTER chunking, BEFORE pipeline.
 */
export function assignNavigationAndDocSymbolId(chunks: CodeChunk[], basePath: string): void {
  // Phase 1: compute doc symbolIds
  for (const chunk of chunks) {
    if (chunk.metadata.isDocumentation) {
      const relPath = relative(basePath, chunk.metadata.filePath);
      const hp = chunk.metadata.headingPath;
      let hashInput: string;
      if (hp && hp.length > 0) {
        hashInput = `${relPath}#${hp.map((h) => h.text).join(" > ")}`;
      } else if (chunk.metadata.name === "Preamble") {
        hashInput = `${relPath}#preamble`;
      } else {
        hashInput = `${relPath}#${chunk.metadata.chunkIndex}`;
      }
      chunk.metadata.symbolId = `doc:${createHash("sha256").update(hashInput).digest("hex").slice(0, 12)}`;
      chunk.metadata.parentSymbolId = relPath;
    }
  }

  // Phase 2: assign navigation. A neighbour sharing the chunk's own symbolId
  // (the windows of one oversized doc section, the body groups of one class)
  // is skipped: navigation names the previous / next DIFFERENT symbol, so
  // following it never lands back on the symbol it started from (bd
  // tea-rags-mcp-308ff).
  for (let i = 0; i < chunks.length; i++) {
    const own = chunks[i].metadata.symbolId;
    const nav: { prevSymbolId?: string; nextSymbolId?: string } = {};
    const prev = neighbourSymbolId(chunks, i, -1, own);
    const next = neighbourSymbolId(chunks, i, 1, own);
    if (prev) nav.prevSymbolId = prev;
    if (next) nav.nextSymbolId = next;
    chunks[i].metadata.navigation = nav;
  }
}

/**
 * Nearest symbolId in `step` direction that differs from `own`. Only chunks
 * sharing `own` are skipped; the first differing neighbour decides, and one
 * without a symbolId means no link, as before.
 */
function neighbourSymbolId(
  chunks: CodeChunk[],
  from: number,
  step: 1 | -1,
  own: string | undefined,
): string | undefined {
  for (let j = from + step; j >= 0 && j < chunks.length; j += step) {
    const id = chunks[j].metadata.symbolId;
    if (own !== undefined && id === own) continue;
    return id;
  }
  return undefined;
}
