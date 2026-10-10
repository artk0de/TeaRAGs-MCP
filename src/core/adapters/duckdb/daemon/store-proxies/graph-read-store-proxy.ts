import type {
  AmbiguousCallerSite,
  CalleeEdge,
  CallerEdge,
  ChunkGraphSignals,
  CodegraphGraphReadStore,
  FileGraphMetrics,
  FileScopedSymbolId,
  FileScopedSymbolRef,
  HierarchySnapshot,
  InheritanceEdge,
  RelPath,
  SymbolId,
} from "../../../../contracts/types/codegraph.js";
import type { DaemonOpCaller } from "../op-channel.js";

/**
 * `CodegraphGraphReadStore` over the daemon socket. Every read routes through
 * the daemon's own RW connection: DuckDB's RW lock is process-exclusive, so a
 * cross-process READ_ONLY attach throws "Conflicting lock is held" while the
 * daemon holds RW. The daemon being the sole file opener means zero conflict.
 */
export class DaemonGraphReadStoreProxy implements CodegraphGraphReadStore {
  constructor(private readonly ops: DaemonOpCaller) {}

  async getFanIn(relPath: RelPath): Promise<number> {
    return (await this.ops.call("getFanIn", { relPath })) as number;
  }

  async getFanInP95(): Promise<number> {
    return (await this.ops.call("getFanInP95", {})) as number;
  }

  async getFanOut(relPath: RelPath): Promise<number> {
    return (await this.ops.call("getFanOut", { relPath })) as number;
  }

  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    return (await this.ops.call("getCallers", { symbolId })) as CallerEdge[];
  }

  async getCallees(symbolId: SymbolId): Promise<CalleeEdge[]> {
    return (await this.ops.call("getCallees", { symbolId })) as CalleeEdge[];
  }

  async getAmbiguousCallersByMember(member: string, limit?: number): Promise<AmbiguousCallerSite[]> {
    return (await this.ops.call("getAmbiguousCallersByMember", { member, limit })) as AmbiguousCallerSite[];
  }

  async getCalleeEdges(symbolIds: SymbolId[]): Promise<Map<SymbolId, SymbolId[]>> {
    // The server serialises the `Map<SymbolId, SymbolId[]>` as `[key, value][]`
    // entries (a Map cannot JSON-serialise) — rebuild the Map here.
    const entries = (await this.ops.call("getCalleeEdges", { symbolIds })) as [SymbolId, SymbolId[]][];
    return new Map(entries);
  }

  async getCalleeEdgesScoped(refs: FileScopedSymbolRef[]): Promise<Map<FileScopedSymbolId, FileScopedSymbolRef[]>> {
    // Own op rather than a widened `getCalleeEdges` payload (bd
    // tea-rags-mcp-oxnvl): a daemon from an older build stays running across a
    // rebuild, and reusing the name would hand it a shape it cannot read.
    // Serialised as `[key, value][]` entries — a Map cannot JSON-serialise.
    const entries = (await this.ops.call("getCalleeEdgesScoped", { refs })) as [
      FileScopedSymbolId,
      FileScopedSymbolRef[],
    ][];
    return new Map(entries);
  }

  async getSymbolRelPaths(symbolIds: SymbolId[]): Promise<Map<SymbolId, RelPath[]>> {
    const entries = (await this.ops.call("getSymbolRelPaths", { symbolIds })) as [SymbolId, RelPath[]][];
    return new Map(entries);
  }

  async getCalledByCount(symbolId: SymbolId): Promise<number> {
    return (await this.ops.call("getCalledByCount", { symbolId })) as number;
  }

  async getCallSiteCount(symbolId: SymbolId): Promise<number> {
    return (await this.ops.call("getCallSiteCount", { symbolId })) as number;
  }

  async getChunkSignalsBulk(): Promise<Map<FileScopedSymbolId, ChunkGraphSignals>> {
    // Server serialises the Map as `[key, value][]` entries — rebuild here
    // (same pattern as getCalleeEdges / listAdjacency). The key is the
    // file-scoped composite (bd tea-rags-mcp-xtdkq), so the wire shape is
    // unchanged — one more string, still one flat entry list.
    const entries = (await this.ops.call("getChunkSignalsBulk", {})) as [FileScopedSymbolId, ChunkGraphSignals][];
    return new Map(entries);
  }

  async getTransitiveImpact(relPath: RelPath, maxDepth?: number): Promise<number> {
    return (await this.ops.call("getTransitiveImpact", { relPath, maxDepth })) as number;
  }

  async getFileMetricsBulk(relPaths: readonly RelPath[], maxDepth?: number): Promise<Map<RelPath, FileGraphMetrics>> {
    // Server serialises the Map as `[key, value][]` entries — rebuild here
    // (same pattern as getChunkSignalsBulk / getCalleeEdges). The caller
    // bounds `relPaths`: this array IS the request frame, and the daemon's
    // reply frame carries one entry per root it knows about.
    return this.ops.callTolerated(
      "getFileMetricsBulk",
      { relPaths, maxDepth },
      (result) => new Map(result as [RelPath, FileGraphMetrics][]),
      async () => this.fileMetricsPerFile(relPaths, maxDepth),
    );
  }

  /**
   * Legacy-daemon fallback for `getFileMetricsBulk`, a tolerated legacy op. A
   * pool tolerates a daemon from another build while it advertises every
   * REQUIRED op (pool.ts), so a client from this build can meet a daemon that
   * never heard of the setwise op. Rather than failing the whole finalize pass,
   * walk the same roots through the three per-file reads the op replaces and
   * assemble the identical map: absent means all-zero, so a root with nothing
   * in either direction is left out.
   *
   * Deliberately serialized and deliberately slow — this is the pre-setwise
   * cost, on a path that only has to stay CORRECT until the daemon is
   * restarted from the matching build.
   */
  private async fileMetricsPerFile(
    relPaths: readonly RelPath[],
    maxDepth?: number,
  ): Promise<Map<RelPath, FileGraphMetrics>> {
    const out = new Map<RelPath, FileGraphMetrics>();
    for (const relPath of relPaths) {
      const fanIn = await this.getFanIn(relPath);
      const fanOut = await this.getFanOut(relPath);
      const transitiveImpact = await this.getTransitiveImpact(relPath, maxDepth);
      if (fanIn !== 0 || fanOut !== 0 || transitiveImpact !== 0) {
        out.set(relPath, { fanIn, fanOut, transitiveImpact });
      }
    }
    return out;
  }

  async getSupertypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.ops.call("getSupertypes", { fqName })) as InheritanceEdge[];
  }

  async getSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.ops.call("getSubtypes", { fqName })) as InheritanceEdge[];
  }

  async getTransitiveSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.ops.call("getTransitiveSubtypes", { fqName })) as InheritanceEdge[];
  }

  async loadHierarchySnapshot(): Promise<HierarchySnapshot> {
    // HierarchySnapshot is plain Records of arrays — JSON-serialisable as-is,
    // no Map rebuild needed (unlike getCalleeEdges / listAdjacency).
    return (await this.ops.call("loadHierarchySnapshot", {})) as HierarchySnapshot;
  }
}
