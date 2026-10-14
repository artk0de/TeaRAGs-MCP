/**
 * The file-level facts a review reads off the index payload — every file's
 * git maintenance readings and its indexed imports — from ONE scroll (bd
 * tea-rags-mcp-i2zr8).
 *
 * `readPayloadFileMaintenanceSignals` and `readPayloadIndexedFileImports` each
 * scroll every point to reduce it to one row per file (taxdome: 155k points,
 * ~13.4k files, 58 MB per pass). A review consumes both, so the scan here
 * scrolls the union of their payload keys once and feeds each page, in scroll
 * order, to both reducers — each keeps its own dedupe rule, so each answer is
 * the one its standalone reader gives.
 */

import type { QdrantPointReader } from "../../../adapters/qdrant/ports.js";
import type { GitFileMaintenanceSignals } from "../../../contracts/types/architecture-report.js";
import type { RelPath } from "../../../contracts/types/codegraph.js";
import type { IndexedFileImports } from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  FileMaintenanceSignalsAccumulator,
  readPayloadFileMaintenanceSignals,
} from "./payload-file-maintenance-signal-reader.js";
import { IndexedFileImportsAccumulator, readPayloadIndexedFileImports } from "./payload-import-specifier-reader.js";

type PayloadPageScroller = Pick<QdrantPointReader, "scrollPayloadPages">;

/** Both file-level reductions of one scroll. */
export interface PayloadFileFacts {
  maintenanceSignals: Map<RelPath, GitFileMaintenanceSignals>;
  indexedFileImports: Map<RelPath, IndexedFileImports>;
}

/** One scroll over the union of both reducers' payload keys, every page fed to both. */
export async function readPayloadFileFacts(
  qdrant: PayloadPageScroller,
  collectionName: string,
): Promise<PayloadFileFacts> {
  const maintenance = new FileMaintenanceSignalsAccumulator();
  const imports = new IndexedFileImportsAccumulator();
  const payloadKeys = [
    ...new Set([...FileMaintenanceSignalsAccumulator.payloadKeys(), ...IndexedFileImportsAccumulator.payloadKeys()]),
  ];
  for await (const page of qdrant.scrollPayloadPages(collectionName, payloadKeys)) {
    maintenance.accept(page);
    imports.accept(page);
  }
  return { maintenanceSignals: maintenance.signals, indexedFileImports: imports.files };
}

/**
 * The two file-fact ports a review is wired with, sharing one scan per
 * collection while a review is open (`withinReview`). However many sections
 * consume either fact, a review scrolls once; the scan is dropped when the
 * last open review ends, so a later review never reads a finished one's facts.
 * Overlapping reviews share the scan the first of them started. Outside any
 * review each port scrolls its own narrow keys, as its standalone reader does.
 * A failed scan rejects every consumer that shares it.
 */
export class ReviewScopedFileFactsReader {
  private openReviews = 0;
  private readonly scans = new Map<string, Promise<PayloadFileFacts>>();

  constructor(private readonly qdrant: PayloadPageScroller) {}

  async withinReview<T>(review: () => Promise<T>): Promise<T> {
    this.openReviews++;
    try {
      return await review();
    } finally {
      this.openReviews--;
      if (this.openReviews === 0) this.scans.clear();
    }
  }

  async readFileMaintenanceSignals(collectionName: string): Promise<Map<RelPath, GitFileMaintenanceSignals>> {
    const scan = this.sharedScan(collectionName);
    if (scan === undefined) return readPayloadFileMaintenanceSignals(this.qdrant, collectionName);
    return (await scan).maintenanceSignals;
  }

  async readIndexedFileImports(collectionName: string): Promise<Map<RelPath, IndexedFileImports>> {
    const scan = this.sharedScan(collectionName);
    if (scan === undefined) return readPayloadIndexedFileImports(this.qdrant, collectionName);
    return (await scan).indexedFileImports;
  }

  private sharedScan(collectionName: string): Promise<PayloadFileFacts> | undefined {
    if (this.openReviews === 0) return undefined;
    let scan = this.scans.get(collectionName);
    if (scan === undefined) {
      scan = readPayloadFileFacts(this.qdrant, collectionName);
      this.scans.set(collectionName, scan);
    }
    return scan;
  }
}
