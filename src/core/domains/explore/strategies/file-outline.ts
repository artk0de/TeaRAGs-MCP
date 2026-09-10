/**
 * FileOutlineStrategy — outline a file by its relative path.
 *
 * Scrolls all chunks sharing the given relativePath and groups them into
 * a single file-level outline. Code files use CodeChunkGrouper; doc files
 * (markdown etc.) use DocChunkGrouper.
 *
 * Per-request strategy — takes input via constructor, mirroring
 * SimilarSearchStrategy.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import { CodeChunkGrouper, DocChunkGrouper } from "../chunk-grouping/index.js";
import type { Reranker, RerankMode } from "../reranker.js";
import { BaseExploreStrategy } from "./base.js";
import type { ExploreContext, ExploreResult } from "./types.js";

const SCROLL_LIMIT = 200;

export interface FileOutlineInput {
  relativePath: string;
  language?: string;
}

export class FileOutlineStrategy extends BaseExploreStrategy {
  readonly type = "outline" as unknown as "vector" | "hybrid" | "scroll-rank" | "similar";

  constructor(
    qdrant: QdrantManager,
    reranker: Reranker,
    payloadSignals: PayloadSignalDescriptor[],
    essentialKeys: string[],
    private readonly input: FileOutlineInput,
  ) {
    super(qdrant, reranker, payloadSignals, essentialKeys);
  }

  /** No overfetch — a single scroll page is enough for one file's chunks. */
  protected override applyDefaults(ctx: ExploreContext): ExploreContext {
    return ctx;
  }

  protected async executeExplore(ctx: ExploreContext): Promise<ExploreResult[]> {
    // Exact keyword match — NOT `match: { text }` (bd tea-rags-mcp-znxg8).
    // `relativePath` carries both a keyword and a "word"-tokenized text index
    // (schema-manager v4/v5). Qdrant's full-text predicate matches when the
    // query's tokens are a SUBSET of the field's, and `/`, `.` and `_` are all
    // token boundaries — so "app/services/workflow/tasks/update.rb" matched
    // "app/services/workflow/async_operations/notify/tasks/batch_update.rb".
    // The path mode addresses ONE file, so the keyword index is both the exact
    // and the cheap predicate. `globToTextFilter` already draws this same line
    // for an unglobbed path (adapters/qdrant/filters/glob.ts).
    const must: Record<string, unknown>[] = [{ key: "relativePath", match: { value: this.input.relativePath } }];
    if (this.input.language) {
      must.push({ key: "language", match: { value: this.input.language } });
    }

    const scrolled = await this.qdrant.scrollFiltered(ctx.collectionName, { must }, SCROLL_LIMIT);

    // Second gate on the same invariant: `CodeChunkGrouper.groupFile` labels the
    // merged outline with the FIRST chunk's path, so a single foreign chunk
    // would silently retitle another file's outline as the requested one. Drop
    // anything that is not the requested path — exact or empty, never a
    // substitute the caller cannot detect.
    const chunks = scrolled.filter((c) => (c.payload.relativePath as string | undefined) === this.input.relativePath);
    if (chunks.length === 0) return [];

    const isDoc = chunks.some((c) => c.payload.isDocumentation);
    const grouped = isDoc ? [DocChunkGrouper.group(chunks)] : [CodeChunkGrouper.groupFile(chunks)];
    return grouped as ExploreResult[];
  }

  /**
   * Custom post-process: metaOnly strips payload.content only (not the
   * BaseExploreStrategy.applyMetaOnly signal-filtered shape, which would
   * erase the outline structure).
   */
  protected override async postProcess(
    results: ExploreResult[],
    originalCtx: ExploreContext,
  ): Promise<ExploreResult[]> {
    let processed = results;

    if (originalCtx.metaOnly) {
      processed = processed.map((r) => {
        if (!r.payload) return r;
        const payload = { ...r.payload };
        delete payload.content;
        return { ...r, payload };
      });
    }

    const rerank = originalCtx.rerank as RerankMode<string> | undefined;
    if (rerank) {
      processed = await this.reranker.rerank(processed, rerank, "semantic_search");
    }

    return processed;
  }
}
