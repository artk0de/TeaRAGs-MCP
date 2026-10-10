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
} from "../../../../contracts/types/codegraph.js";
import type { DaemonOpCaller } from "../op-channel.js";

/** `CodegraphSymbolFileStore` over the daemon socket — one op per call. */
export class DaemonSymbolFileStoreProxy implements CodegraphSymbolFileStore {
  constructor(private readonly ops: DaemonOpCaller) {}

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    await this.ops.call("upsertFile", { node, edges });
  }

  async removeFile(relPath: RelPath): Promise<void> {
    await this.ops.call("removeFile", { relPath });
  }

  async removeFiles(relPaths: readonly RelPath[]): Promise<void> {
    await this.ops.call("removeFiles", { relPaths: [...relPaths] });
  }

  async removeSymbolsForFile(relPath: RelPath): Promise<void> {
    await this.ops.call("removeSymbolsForFile", { relPath });
  }

  async upsertSymbols(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    await this.ops.call("upsertSymbols", { relPath, definitions });
  }

  async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    await this.ops.call("upsertSymbolsBulk", { entries });
  }

  async upsertFilesBulk(entries: readonly BulkFileUpsertEntry[]): Promise<void> {
    await this.ops.call("upsertFilesBulk", { entries });
  }

  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    await this.ops.call("updateSymbolChunkIds", { relPath, chunkIds: [...chunkIds.entries()] });
  }

  async updateSymbolChunkIdsBulk(entries: readonly SymbolChunkIdJoinEntry[]): Promise<void> {
    // Each file's join travels as Map entries — a Map does not survive JSON.
    await this.ops.call("updateSymbolChunkIdsBulk", {
      entries: entries.map((e) => ({ relPath: e.relPath, chunkIds: [...e.chunkIds.entries()] })),
    });
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return (await this.ops.call("findSymbolChunk", { symbolId })) as SymbolChunkLocation | null;
  }

  async getSymbolVisibilities(symbolIds: readonly SymbolId[]): Promise<SymbolVisibilityRow[]> {
    return (await this.ops.call("getSymbolVisibilities", { symbolIds: [...symbolIds] })) as SymbolVisibilityRow[];
  }

  async getSymbolLineRangesBulk(relPaths: readonly RelPath[]): Promise<Map<RelPath, PersistedSymbolLineRanges>> {
    // Server serialises the Map as `[key, value][]` entries — rebuild here. A
    // tolerated legacy op: a daemon that predates it answers "no rows known",
    // which leaves every chunk the heal would place unsettled — no write, never
    // a guessed owner (bd tea-rags-mcp-39xca.2).
    return this.ops.callTolerated(
      "getSymbolLineRangesBulk",
      { relPaths },
      (result) => new Map(result as [RelPath, PersistedSymbolLineRanges][]),
      () => new Map<RelPath, PersistedSymbolLineRanges>(),
    );
  }

  async listAllSymbols(): Promise<SymbolDefinition[]> {
    return (await this.ops.call("listAllSymbols", {})) as SymbolDefinition[];
  }

  async listPass1Aggregates(scope: Pass1AggregateReadScope): Promise<CodegraphPass1FileAggregates[]> {
    return (await this.ops.call("listPass1Aggregates", { scope })) as CodegraphPass1FileAggregates[];
  }

  async listHierarchyDependencies(scope: Pass1AggregateReadScope): Promise<PersistedHierarchyDescendantDependency[]> {
    return (await this.ops.call("listHierarchyDependencies", { scope })) as PersistedHierarchyDescendantDependency[];
  }

  async invalidateHierarchyDependentsOfDeletedFiles(relPaths: readonly RelPath[]): Promise<void> {
    await this.ops.call("invalidateHierarchyDependentsOfDeletedFiles", { relPaths: [...relPaths] });
  }

  async listFileContentHashes(): Promise<{ relPath: RelPath; contentHash: string | null }[]> {
    return (await this.ops.call("listFileContentHashes", {})) as { relPath: RelPath; contentHash: string | null }[];
  }
}
