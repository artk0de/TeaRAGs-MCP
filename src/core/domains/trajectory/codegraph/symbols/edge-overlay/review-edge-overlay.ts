/**
 * The per-review edge overlay value (bd tea-rags-mcp-89k7k.1.2, moved into the
 * codegraph domain by bd tea-rags-mcp-89k7k.35.19): the diff's files MASKED
 * out of the indexed file graph, plus the review's own file edges. Pure — it
 * holds only what it was constructed from and touches no global state.
 *
 * Who produces the reads is not this module's concern: the review_changes
 * working-tree reader (`api/internal/ops/review-edge-overlay.ts`) is one
 * producer; a what-if overlay (bd tea-rags-mcp-r8hme.21) is another. A
 * consumer judges the indexed graph THROUGH the overlay — see
 * `applyEdgeOverlay` for the architecture facts, `DiffDetectorRun` for the
 * diff-scoped detectors.
 */

import type { ReviewFileEdge } from "../../../../../contracts/types/codegraph-storage.js";

/** Why a changed file yielded no edges (upstream renders it as notJudged, never edge-free). */
export type ReviewEdgeSkipReason = "noCodegraphLanguage" | "unreadable" | "unsupportedLanguage" | "parseFailed";

/** One file's edge read: its edges, or why none could be read. */
export interface ReviewFileEdgeRead {
  relPath: string;
  language?: string;
  edges: readonly ReviewFileEdge[];
  skip?: { reason: ReviewEdgeSkipReason; detail?: string };
}

/**
 * Per-review view over file edges: every read file MASKED out of the indexed
 * graph, plus that read's edges. Immutable after construction.
 */
export class ReviewEdgeOverlay {
  private readonly edgesBySource: ReadonlyMap<string, readonly ReviewFileEdge[]>;
  private readonly maskedPaths: ReadonlySet<string>;
  private readonly unsupportedReads: readonly {
    relPath: string;
    reason: ReviewEdgeSkipReason;
    detail?: string;
  }[];

  constructor(reads: readonly ReviewFileEdgeRead[]) {
    const edgesBySource = new Map<string, readonly ReviewFileEdge[]>();
    const unsupported: { relPath: string; reason: ReviewEdgeSkipReason; detail?: string }[] = [];
    for (const read of reads) {
      // A diff lists a file once; a repeated relPath keeps the LATER read —
      // the fresher working-tree state.
      edgesBySource.set(read.relPath, Object.freeze([...read.edges]));
      if (read.skip !== undefined) {
        unsupported.push(Object.freeze({ relPath: read.relPath, ...read.skip }));
      }
    }
    this.edgesBySource = edgesBySource;
    this.maskedPaths = new Set(reads.map((read) => read.relPath));
    this.unsupportedReads = Object.freeze(unsupported);
  }

  /** Every read relPath — the files whose indexed edges the review replaces, whatever the read found. */
  get masked(): ReadonlySet<string> {
    return this.maskedPaths;
  }

  /** The working-tree edges of one file: `[]` for a masked file with no edges, and for any file outside the read. */
  edgesFrom(relPath: string): readonly ReviewFileEdge[] {
    return this.edgesBySource.get(relPath) ?? EMPTY_EDGES;
  }

  /** The skipped reads — the notJudged files upstream must report, never treat as edge-free. */
  unsupported(): readonly { relPath: string; reason: ReviewEdgeSkipReason; detail?: string }[] {
    return this.unsupportedReads;
  }
}

const EMPTY_EDGES: readonly ReviewFileEdge[] = Object.freeze([]);
