/**
 * `CodegraphStorageMaintenance` for DuckDB (bd tea-rags-mcp-0qaht.38): the
 * session's lifecycle and durability operations, the edge-index rebuild, the
 * `hasData` probe, and the resolve-run stats `DuckDbRunStatsStore` owns.
 */

import type {
  CodegraphStorageCompactionOutcome,
  CodegraphStorageMaintenance,
  EdgeKindCount,
  FileResolveStatsWrite,
  ResolveRunStatsRow,
} from "../../contracts/types/codegraph.js";
import type { DuckDbFileGraphStore } from "./file-graph-store.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import type { DuckDbRunStatsStore } from "./run-stats-store.js";

export class DuckDbStorageMaintenance implements CodegraphStorageMaintenance {
  constructor(
    private readonly session: DuckDbGraphSession,
    private readonly fileGraph: DuckDbFileGraphStore,
    private readonly runStats: DuckDbRunStatsStore,
  ) {}

  // ── Lifecycle + durability ──

  async init(): Promise<void> {
    return this.session.open();
  }

  async close(): Promise<void> {
    return this.session.close();
  }

  async checkpoint(): Promise<void> {
    return this.session.checkpoint();
  }

  /** See `GraphDbClient.compactStorage`; the protocol is `DuckDbGraphSession#compactDatabaseFile`. */
  async compactStorage(): Promise<CodegraphStorageCompactionOutcome> {
    return this.session.compactDatabaseFile();
  }

  /** See `GraphDbClient.exportSnapshot`; the protocol is `DuckDbGraphSession#exportSnapshot`. */
  async exportSnapshot(targetPath: string): Promise<void> {
    return this.session.exportSnapshot(targetPath);
  }

  async hasData(): Promise<boolean> {
    return this.fileGraph.hasData();
  }

  /**
   * See `GraphDbClient.rebuildEdgeFileTargetIndex` (contracts/types/codegraph-storage.ts).
   *
   * Queued behind every transactional write, like `checkpoint` (bd
   * tea-rags-mcp-sgo8v). Every writer of this database shares ONE connection —
   * the daemon's per-collection client — so a DDL issued directly would execute
   * inside whichever writer's BEGIN happened to be open: the node-flush chain
   * during pass-2, and with one pass-2 per language partition, the other
   * partition's `upsertFilesBulk` into the very table being re-indexed.
   */
  async rebuildEdgeFileTargetIndex(): Promise<void> {
    await this.session.serialize(async () =>
      this.session.exec(
        "DROP INDEX IF EXISTS idx_cg_symbols_edges_file_target; " +
          "CREATE INDEX idx_cg_symbols_edges_file_target ON cg_symbols_edges_file (target_rel_path);",
      ),
    );
  }

  // ── Resolve-run stats (bd tea-rags-mcp-j431) ──

  async recordRunStats(rows: ResolveRunStatsRow[]): Promise<void> {
    return this.runStats.recordRunStats(rows);
  }

  async recordFileResolveStats(write: FileResolveStatsWrite): Promise<void> {
    return this.runStats.recordFileResolveStats(write);
  }

  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    return this.runStats.getRunStats();
  }

  async getEdgeKindDistribution(): Promise<EdgeKindCount[]> {
    return this.runStats.getEdgeKindDistribution();
  }
}
