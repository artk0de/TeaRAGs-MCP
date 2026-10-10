import type {
  CodegraphGraphAnalyticsStore,
  CodegraphSignalDrift,
  CycleEntry,
  CycleScope,
  FileDependencyGraph,
  FileImportLookup,
  NonPublicMemberEdge,
  RelPath,
  SymbolId,
} from "../../../../contracts/types/codegraph.js";
import type { DaemonOpCaller } from "../op-channel.js";

/**
 * Thrown when a daemon-internal op is invoked on the daemon client. In daemon
 * mode the `DaemonGraphDbClient` is the SOLE accessor of the DuckDB file, so it
 * proxies the ENTIRE `GraphDbClient` surface — every write AND every read — over
 * the socket. The lone exception is `streamAdjacency`: the heavy graph analysis
 * runs daemon-side via `computeAndPersistCyclesAndSignals`, so the adjacency
 * stream must NOT cross IPC and still throws this error if called on the client.
 */
export class UnsupportedDaemonReadError extends Error {
  constructor(op: string) {
    super(`DaemonGraphDbClient is write-only; read op "${op}" must use the in-process RO handle`);
    this.name = "UnsupportedDaemonReadError";
  }
}

/**
 * `CodegraphGraphAnalyticsStore` over the daemon socket. `streamAdjacency` is
 * the ONE member that is not proxied — see {@link UnsupportedDaemonReadError}.
 */
export class DaemonGraphAnalyticsStoreProxy implements CodegraphGraphAnalyticsStore {
  constructor(private readonly ops: DaemonOpCaller) {}

  async pruneDerivedForDeletedFiles(relPaths: readonly RelPath[]): Promise<void> {
    await this.ops.call("pruneDerivedForDeletedFiles", { relPaths: [...relPaths] });
  }

  async hasStaleDerivedTables(): Promise<boolean> {
    return (await this.ops.call("hasStaleDerivedTables", {})) as boolean;
  }

  async replaceCycles(scope: CycleScope, sccs: readonly (readonly string[])[]): Promise<void> {
    await this.ops.call("replaceCycles", { scope, sccs });
  }

  async replacePageRanks(ranks: ReadonlyMap<string, number>): Promise<void> {
    // A Map cannot JSON-serialise — send entries; the server rebuilds the Map.
    await this.ops.call("replacePageRanks", { ranks: [...ranks.entries()] });
  }

  /**
   * Concrete daemon method (NOT yet on the `GraphDbClient` interface — added in
   * Task 7). Runs SCC + PageRank daemon-side so the heavy graph build stays in
   * the single daemon process.
   */
  async computeAndPersistCyclesAndSignals(): Promise<void> {
    await this.ops.call("computeAndPersistCyclesAndSignals", {});
  }

  /**
   * Record the current signals as the baseline for the next run's drift diff
   * (bd tea-rags-mcp-a2ddb). A tolerated legacy op: a daemon that predates it
   * has not run migration 023 either, so there is no baseline to refresh.
   */
  async refreshSymbolSignalsPrev(): Promise<void> {
    await this.ops.callTolerated(
      "refreshSymbolSignalsPrev",
      {},
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Symbols and files whose derived signals moved since the baseline
   * (bd tea-rags-mcp-a2ddb). A tolerated legacy op: a daemon that predates it
   * answers "nothing moved" — why that and not "everything moved" is recorded
   * on `LEGACY_TOLERATED_OPS`.
   */
  async diffSymbolSignals(): Promise<CodegraphSignalDrift> {
    return this.ops.callTolerated(
      "diffSymbolSignals",
      {},
      (result) => result as CodegraphSignalDrift,
      () => ({ symbols: [], files: [] }),
    );
  }

  async findCycles(scope: CycleScope, pathPattern?: string): Promise<CycleEntry[]> {
    return (await this.ops.call("findCycles", { scope, pathPattern })) as CycleEntry[];
  }

  async listAdjacency(scope: CycleScope): Promise<Map<string, string[]>> {
    // The server serialises the `Map<string, string[]>` as `[key, value][]`
    // entries (a Map cannot JSON-serialise) — rebuild the Map here.
    const entries = (await this.ops.call("listAdjacency", { scope })) as [string, string[]][];
    return new Map(entries);
  }

  async readFileDependencyGraph(): Promise<FileDependencyGraph> {
    return (await this.ops.call("readFileDependencyGraph", {})) as FileDependencyGraph;
  }

  async readNonPublicMemberEdges(languages: readonly string[]): Promise<NonPublicMemberEdge[]> {
    return (await this.ops.call("readNonPublicMemberEdges", { languages: [...languages] })) as NonPublicMemberEdge[];
  }

  async getFileImporters(relPath: RelPath): Promise<FileImportLookup> {
    return (await this.ops.call("getFileImporters", { relPath })) as FileImportLookup;
  }

  async getFileImports(relPath: RelPath): Promise<FileImportLookup> {
    return (await this.ops.call("getFileImports", { relPath })) as FileImportLookup;
  }

  async getPageRank(symbolId: SymbolId, relPath?: RelPath): Promise<number> {
    return (await this.ops.call("getPageRank", relPath === undefined ? { symbolId } : { symbolId, relPath })) as number;
  }

  // ── daemon-internal (NOT proxied) ──
  // `streamAdjacency` stays daemon-internal: the heavy graph analysis runs
  // inside the daemon (computeAndPersistCyclesAndSignals), so streaming the
  // adjacency over IPC is never correct. Throws on first iteration.

  streamAdjacency(_scope: CycleScope): AsyncIterableIterator<[source: string, target: string, weight?: number]> {
    const error = new UnsupportedDaemonReadError("streamAdjacency");
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<[source: string, target: string, weight?: number]>> {
        throw error;
      },
    };
  }
}
