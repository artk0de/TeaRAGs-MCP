/**
 * ArchitectureReportSnapshotCache — the judged `get_architecture_report`
 * snapshots a paging call reads back by `reportId` (bd tea-rags-mcp-00309).
 *
 * One report costs seconds of detector runs; its pages cost a projection. The
 * cache holds the JUDGEMENT (detector runs + cost model), never a shaped
 * page, so every view param (`limit`, `offset`) is re-cut in memory. Each held
 * judgement carries the key it was judged under — collection, working-tree
 * fingerprint, scope params — and a paging call whose current key differs is
 * refused, so a page never mixes a fresh judgement with old ones.
 *
 * In-memory and process-local: the MCP server holds reports across calls; a
 * one-process CLI `call` never finds one. The fingerprint is the working-tree
 * marker's commits, dirtiness and counts, so re-editing a file that was
 * already changed leaves it unchanged — accepted, and bounded by the TTL.
 */

import { randomUUID } from "node:crypto";

import type { EmptyAnswerExplanation } from "../../../contracts/types/empty-answer.js";
import type { WorkingTreeMarker } from "../../../contracts/types/working-tree.js";
import { ByteBoundedLru } from "../../../primitives/collections/index.js";
import type { GetArchitectureReportRequest } from "../../public/dto/architecture.js";
import type { ArchitectureReportJudgement } from "./architecture-report-ops.js";

/** How many judged reports the cache holds; the least recently used is evicted first. */
export const ARCHITECTURE_REPORT_SNAPSHOT_LIMIT = 8;

/** How long a held report answers paging calls, from when it was judged. */
export const ARCHITECTURE_REPORT_SNAPSHOT_TTL_MS = 10 * 60_000;

/**
 * The bytes each held report declares to the LRU. A judgement's real size is
 * not measured — the bound is a COUNT of reports, expressed in the LRU's unit.
 */
const ARCHITECTURE_REPORT_SNAPSHOT_BYTES = 1;

/** The answer to a `reportId` the cache refused: nothing of a fresh judgement rides along. */
export const ARCHITECTURE_REPORT_STALE: EmptyAnswerExplanation = {
  reason: "reportStale",
  message:
    "reportId names no held report for this tree and scope (evicted, expired, or the tree changed) — re-call without reportId.",
};

interface HeldArchitectureReport {
  snapshotKey: string;
  judgement: ArchitectureReportJudgement;
  createdAt: number;
}

/**
 * The key a judgement is valid under: the collection, the tree fingerprint
 * (absent when no overlay measured the tree), and every request param that
 * changes what the detectors judge. View params — `limit`, `offset` — are
 * left out: a page differs from another only in what it cuts.
 */
export function architectureReportSnapshotKey(
  collectionName: string,
  marker: WorkingTreeMarker | undefined,
  request: GetArchitectureReportRequest,
): string {
  const fingerprint = marker
    ? [
        marker.tree,
        marker.indexedCommit,
        marker.treeCommit,
        marker.indexedDirty,
        marker.changedFiles,
        marker.deletedFiles,
      ]
    : null;
  const { pathPattern, domain, norms, changeReasons, layerMap, knotOf } = request;
  return JSON.stringify([collectionName, fingerprint, pathPattern, domain, norms, changeReasons, layerMap, knotOf]);
}

export class ArchitectureReportSnapshotCache {
  private readonly held = new ByteBoundedLru<HeldArchitectureReport>(
    ARCHITECTURE_REPORT_SNAPSHOT_LIMIT * ARCHITECTURE_REPORT_SNAPSHOT_BYTES,
  );

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Hold `judgement` under `snapshotKey`; the returned id reads it back. */
  hold(snapshotKey: string, judgement: ArchitectureReportJudgement): string {
    const reportId = randomUUID();
    this.held.set(reportId, { snapshotKey, judgement, createdAt: this.now() }, ARCHITECTURE_REPORT_SNAPSHOT_BYTES);
    return reportId;
  }

  /**
   * The judgement `reportId` names when it is still held, unexpired, and was
   * judged under `snapshotKey`; undefined otherwise — the caller answers
   * stale. An expired report is dropped; a key mismatch leaves it held for
   * the scope it does match.
   */
  lookup(reportId: string, snapshotKey: string): ArchitectureReportJudgement | undefined {
    const entry = this.held.get(reportId);
    if (!entry) return undefined;
    if (this.now() - entry.createdAt > ARCHITECTURE_REPORT_SNAPSHOT_TTL_MS) {
      this.held.delete(reportId);
      return undefined;
    }
    return entry.snapshotKey === snapshotKey ? entry.judgement : undefined;
  }
}
