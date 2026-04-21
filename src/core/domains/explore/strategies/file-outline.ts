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
    const must: Record<string, unknown>[] = [{ key: "relativePath", match: { text: this.input.relativePath } }];
    if (this.input.language) {
      must.push({ key: "language", match: { value: this.input.language } });
    }

    const chunks = await this.qdrant.scrollFiltered(ctx.collectionName, { must }, SCROLL_LIMIT);
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
  protected override postProcess(results: ExploreResult[], originalCtx: ExploreContext): ExploreResult[] {
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
      processed = this.reranker.rerank(processed, rerank, "semantic_search");
    }

    return processed;
  }
}
