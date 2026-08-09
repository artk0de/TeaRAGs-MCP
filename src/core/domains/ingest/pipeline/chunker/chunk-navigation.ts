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

  // Phase 2: assign navigation
  for (let i = 0; i < chunks.length; i++) {
    const nav: { prevSymbolId?: string; nextSymbolId?: string } = {};
    if (i > 0 && chunks[i - 1].metadata.symbolId) {
      nav.prevSymbolId = chunks[i - 1].metadata.symbolId;
    }
    if (i < chunks.length - 1 && chunks[i + 1].metadata.symbolId) {
      nav.nextSymbolId = chunks[i + 1].metadata.symbolId;
    }
    chunks[i].metadata.navigation = nav;
  }
}
