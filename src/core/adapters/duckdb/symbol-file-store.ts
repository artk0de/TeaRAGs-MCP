/**
 * `CodegraphSymbolFileStore` for DuckDB (bd tea-rags-mcp-0qaht.38): the per-file
 * write path and its read-backs. File rows and edges belong to
 * `DuckDbFileGraphStore`, the symbol table to `DuckDbSymbolStore`; this store
 * owns the transaction envelopes of the file upserts and routes every other
 * member to the store owning its tables.
 */

import type {
  BulkFileUpsertEntry,
  BulkSymbolUpsertEntry,
  CodegraphPass1FileAggregates,
  CodegraphSymbolFileStore,
  GraphEdges,
  GraphFileNode,
  Pass1AggregateReadScope,
  PersistedHierarchyDescendantDependency,
  PersistedSymbolLineRanges,
  RelPath,
  SymbolChunkIdJoinEntry,
  SymbolChunkLocation,
  SymbolDefinition,
  SymbolId,
  SymbolVisibilityRow,
} from "../../contracts/types/codegraph.js";
import type { DuckDbFileGraphStore } from "./file-graph-store.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import type { DuckDbSymbolStore } from "./symbol-store.js";

export class DuckDbSymbolFileStore implements CodegraphSymbolFileStore {
  constructor(
    private readonly session: DuckDbGraphSession,
    private readonly fileGraph: DuckDbFileGraphStore,
    private readonly symbols: DuckDbSymbolStore,
  ) {}

  // ── File-graph writes ──
  //
  // `upsertFile` and `upsertFilesBulk` write the SAME rows and differ only in
  // transaction granularity — one BEGIN/COMMIT per file versus one per batch.
  // The store therefore keeps the two envelopes and dispatches both through a
  // single `upsertFileRows` seam; the row body itself lives in the file-graph
  // store.

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    return this.session.transaction(async () => this.upsertFileRows(node, edges));
  }

  /**
   * Bulk variant of `upsertFile` (mirrors `upsertSymbolsBulk`): fold M files'
   * node + edge writes into ONE `BEGIN/COMMIT` instead of M per-file
   * transactions — and, on the daemon path, ONE IPC round-trip instead of M.
   * Unlike `upsertFile`, the DELETE+INSERT lifecycle is batched ACROSS the
   * whole set (`DuckDbFileGraphStore#writeFileRowsBulk`), not looped per file:
   * a chunked IN-list DELETE per table instead of one DELETE per file per
   * table. Persisted rows are byte-identical to calling `upsertFile` per
   * file — last-wins per relPath, cross-file PK collisions first-wins by
   * batch order — only the statement count drops (bd tea-rags-mcp-wgt19
   * follow-up: per-file DELETEs re-scanned the FSST-compressed
   * source_rel_path column on every call). Any row failure rolls the whole
   * batch back (callers cap batch size + skip pathological files upstream).
   */
  async upsertFilesBulk(entries: readonly BulkFileUpsertEntry[]): Promise<void> {
    if (entries.length === 0) return;
    return this.session.transaction(async () => this.fileGraph.writeFileRowsBulk(entries));
  }

  /** The per-file DELETE+INSERT body both envelopes above share, unwrapped. */
  private async upsertFileRows(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    return this.fileGraph.writeFileRows(node, edges);
  }

  async removeFile(relPath: RelPath): Promise<void> {
    return this.fileGraph.removeFile(relPath);
  }

  async removeFiles(relPaths: readonly RelPath[]): Promise<void> {
    return this.fileGraph.removeFiles(relPaths);
  }

  async listFileContentHashes(): Promise<{ relPath: RelPath; contentHash: string | null }[]> {
    return this.fileGraph.listFileContentHashes();
  }

  async listPass1Aggregates(scope: Pass1AggregateReadScope): Promise<CodegraphPass1FileAggregates[]> {
    return this.fileGraph.listPass1Aggregates(scope);
  }

  async listHierarchyDependencies(scope: Pass1AggregateReadScope): Promise<PersistedHierarchyDescendantDependency[]> {
    return this.fileGraph.listHierarchyDependencies(scope);
  }

  async invalidateHierarchyDependentsOfDeletedFiles(relPaths: readonly RelPath[]): Promise<void> {
    return this.fileGraph.invalidateHierarchyDependentsOfDeletedFiles(relPaths);
  }

  // ── Symbol persistence ──

  async upsertSymbols(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    return this.symbols.upsertSymbols(relPath, definitions);
  }

  async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    return this.symbols.upsertSymbolsBulk(entries);
  }

  async removeSymbolsForFile(relPath: RelPath): Promise<void> {
    return this.symbols.removeSymbolsForFile(relPath);
  }

  async listAllSymbols(): Promise<SymbolDefinition[]> {
    return this.symbols.listAllSymbols();
  }

  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    return this.symbols.updateSymbolChunkIds(relPath, chunkIds);
  }

  async updateSymbolChunkIdsBulk(entries: readonly SymbolChunkIdJoinEntry[]): Promise<void> {
    return this.symbols.updateSymbolChunkIdsBulk(entries);
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return this.symbols.findSymbolChunk(symbolId);
  }

  async getSymbolVisibilities(symbolIds: readonly SymbolId[]): Promise<SymbolVisibilityRow[]> {
    return this.symbols.getSymbolVisibilities(symbolIds);
  }

  async getSymbolLineRangesBulk(relPaths: readonly RelPath[]): Promise<Map<RelPath, PersistedSymbolLineRanges>> {
    return this.symbols.getSymbolLineRangesBulk(relPaths);
  }
}
