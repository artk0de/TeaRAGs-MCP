import type {
  CodegraphStorageCompactionOutcome,
  CodegraphStorageMaintenance,
  EdgeKindCount,
  FileResolveStatsWrite,
  ResolveRunStatsRow,
} from "../../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../../contracts/types/collection-identity.js";
import { CodegraphSnapshotExportFailedError } from "../../errors.js";
import type { DaemonOpCaller } from "../op-channel.js";

/**
 * `CodegraphStorageMaintenance` over the daemon socket, plus the daemon-only
 * database-file ops (`finalizeReindex`, `removeCollectionDatabase`,
 * `cloneCollectionDatabase`). `init` / `close` are not here: opening and
 * closing is the connection's lifecycle, owned by `DaemonOpChannel`.
 */
export class DaemonStorageMaintenanceProxy implements Omit<CodegraphStorageMaintenance, "init" | "close"> {
  constructor(
    private readonly ops: DaemonOpCaller,
    private readonly physicalCollectionName: PhysicalCollectionName,
  ) {}

  async hasData(): Promise<boolean> {
    return (await this.ops.call("hasData", {})) as boolean;
  }

  async checkpoint(): Promise<void> {
    await this.ops.call("checkpoint", {});
  }

  /**
   * Compact the collection's graph file daemon-side (bd tea-rags-mcp-dvzdm). A
   * tolerated legacy op: a daemon that predates it leaves the file as it is.
   */
  async compactStorage(): Promise<CodegraphStorageCompactionOutcome> {
    return this.ops.callTolerated<CodegraphStorageCompactionOutcome, "compactStorage">(
      "compactStorage",
      {},
      (result) => result as CodegraphStorageCompactionOutcome,
      () => ({ kind: "skipped", reason: "unsupported" }),
    );
  }

  /**
   * Have the daemon — the holder of the collection's file and its WAL — write
   * the snapshot (bd tea-rags-mcp-xi2r9). A tolerated legacy op, but with no
   * stand-in answer: no other process can read what that daemon's WAL holds,
   * so an older daemon is refused with a typed error the caller degrades on.
   */
  async exportSnapshot(targetPath: string): Promise<void> {
    await this.ops.callTolerated(
      "exportSnapshot",
      { targetPath },
      () => undefined,
      () => {
        throw new CodegraphSnapshotExportFailedError(this.physicalCollectionName, targetPath, "unsupported");
      },
    );
  }

  async rebuildEdgeFileTargetIndex(): Promise<void> {
    await this.ops.call("rebuildEdgeFileTargetIndex", {});
  }

  async recordRunStats(rows: ResolveRunStatsRow[]): Promise<void> {
    await this.ops.call("recordRunStats", { rows });
  }

  async recordFileResolveStats(write: FileResolveStatsWrite): Promise<void> {
    await this.ops.call("recordFileResolveStats", { write });
  }

  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    return (await this.ops.call("getRunStats", {})) as ResolveRunStatsRow[];
  }

  async getEdgeKindDistribution(): Promise<EdgeKindCount[]> {
    return (await this.ops.call("getEdgeKindDistribution", {})) as EdgeKindCount[];
  }

  /**
   * Delete the superseded version's DuckDB file after the Qdrant alias swap.
   * Concrete daemon method (NOT on the `GraphDbClient` interface) — driven by
   * the force-reindex path once the alias flips readers onto `newVersion`.
   */
  async finalizeReindex(oldVersion: string, newVersion: string): Promise<void> {
    await this.ops.call("finalizeReindex", { oldVersion, newVersion });
  }

  /**
   * Have the daemon's pool remove `target`'s database under its path lease (bd
   * tea-rags-mcp-r4veq): the ops running on its client finish first. Resolves
   * whether the daemon evicted a cached client, or `undefined` when the daemon
   * predates the op and the caller must remove the files itself.
   */
  async removeCollectionDatabase(target: PhysicalCollectionName): Promise<boolean | undefined> {
    return this.ops.callTolerated(
      "removeCollectionDatabase",
      { target },
      (result) => result === true,
      () => undefined,
    );
  }

  /**
   * Have the daemon's pool clone `source` over `target` under both paths'
   * leases (bd tea-rags-mcp-r4veq). Resolves `false` when the daemon predates
   * the op and the caller must copy the files itself.
   */
  /**
   * Ask ANOTHER build's daemon holding this collection's file to release it (bd
   * tea-rags-mcp-8noie). Resolves whether it did: an idle-past-grace collection
   * is released, a busy one declined, and a daemon that predates the op — or an
   * answer this build cannot read — counts as not released.
   */
  async releaseIdleCollection(): Promise<boolean> {
    return this.ops.callTolerated(
      "releaseIdleCollection",
      {},
      (releaseOutcome) =>
        typeof releaseOutcome === "object" &&
        releaseOutcome !== null &&
        (releaseOutcome as { kind?: unknown }).kind === "released",
      () => false,
    );
  }

  async cloneCollectionDatabase(source: PhysicalCollectionName, target: PhysicalCollectionName): Promise<boolean> {
    return this.ops.callTolerated(
      "cloneCollectionDatabase",
      { source, target },
      () => true,
      () => false,
    );
  }
}
