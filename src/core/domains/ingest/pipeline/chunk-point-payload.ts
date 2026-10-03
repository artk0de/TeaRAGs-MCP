/**
 * The chunker-owned point payload of one chunk (bd tea-rags-mcp-xi2r9.3) — what
 * ingest stores for a chunk before any enrichment provider writes onto it.
 *
 * Ingest builds it in two halves split by the batch accumulator:
 * `SourceFileIngestor#submitChunks` projects the parsed chunk to the pipeline
 * chunk ({@link toChunkPointInput}), and `ChunkPipeline` applies the injected
 * `PayloadBuilder` to it right before upsert. {@link buildChunkPointPayload}
 * composes the same two steps for a reader with no pipeline in between — the
 * working-tree overlay — so both answer one payload for one chunk. Git and
 * codegraph keys are absent by construction: enrichment writes them later,
 * scoped under their own provider key (`enrichment/CLAUDE.md`).
 */

import type { PayloadBuilder } from "../../../contracts/types/provider.js";
import type { CodeChunk } from "../../../types.js";
import type { ChunkItem } from "./types.js";

export interface ChunkPointPayloadContext {
  /** Root the chunk's `filePath` is made relative to — the indexed tree. */
  codebasePath: string;
  /** Module specifiers of the chunk's FILE; empty → no `imports` key. */
  imports: readonly string[];
  payloadBuilder: PayloadBuilder;
}

/**
 * The chunk ingest hands the pipeline: the parsed chunk with its metadata cut
 * to the keys the payload builder and enrichment read, plus the file's imports.
 */
export function toChunkPointInput(chunk: CodeChunk, imports: readonly string[]): ChunkItem["chunk"] {
  return {
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    metadata: {
      filePath: chunk.metadata.filePath,
      language: chunk.metadata.language,
      chunkIndex: chunk.metadata.chunkIndex,
      name: chunk.metadata.name,
      chunkType: chunk.metadata.chunkType,
      parentSymbolId: chunk.metadata.parentSymbolId,
      parentType: chunk.metadata.parentType,
      symbolId: chunk.metadata.symbolId,
      isDocumentation: chunk.metadata.isDocumentation,
      methodLines: chunk.metadata.methodLines,
      memberCount: chunk.metadata.memberCount,
      moduleLines: chunk.metadata.moduleLines,
      moduleMethodCount: chunk.metadata.moduleMethodCount,
      headingPath: chunk.metadata.headingPath,
      navigation: chunk.metadata.navigation,
      scopeLineRanges: chunk.metadata.scopeLineRanges,
      memberRowCounts: chunk.metadata.memberRowCounts,
      memberSymbolIds: chunk.metadata.memberSymbolIds,
      memberLineRanges: chunk.metadata.memberLineRanges,
      ...(imports.length > 0 && { imports: [...imports] }),
    } as CodeChunk["metadata"],
  };
}

/** The payload ingest stores for `chunk` before enrichment. */
export function buildChunkPointPayload(chunk: CodeChunk, ctx: ChunkPointPayloadContext): Record<string, unknown> {
  return ctx.payloadBuilder.buildPayload(toChunkPointInput(chunk, ctx.imports), ctx.codebasePath);
}
