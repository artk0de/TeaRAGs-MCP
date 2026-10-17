import type { StatsCache } from "../../../adapters/filesystem/stats-cache.js";
import type {
  CodegraphFootprintStore,
  CollectionFootprintPort,
  IndexingLockArtifactStoreFactory,
  QuarantineArtifactStoreFactory,
  SnapshotArtifactStoreFactory,
} from "../../../contracts/index.js";
import type { CollectionArtifact, FootprintContext, ResolvedCollection } from "./artifact.js";
import { cloneCollectionFootprint, removeCollectionFootprint } from "./clone-saga.js";
import { CodegraphArtifact } from "./codegraph-artifact.js";
import { IndexingLockArtifact } from "./indexing-lock-artifact.js";
import { QdrantArtifact, type QdrantArtifactSurface } from "./qdrant-artifact.js";
import { QuarantineArtifact } from "./quarantine-artifact.js";
import { SnapshotArtifact } from "./snapshot-artifact.js";
import { StatsArtifact } from "./stats-artifact.js";

export interface FootprintDeps {
  qdrant: QdrantArtifactSurface;
  /** Structural, not `GraphDbClientPool` — see {@link CodegraphFootprintStore} for why the purge path cannot pass a pool. */
  pool: CodegraphFootprintStore;
  statsCache: StatsCache;
  snapshotBaseDir: string;
  /** Builds the per-collection snapshot store — concrete is wired by the composition root (DIP, keeps footprint out of ingest). */
  snapshotStoreFactory: SnapshotArtifactStoreFactory;
  /** Builds the per-collection quarantine store — concrete is wired by the composition root (DIP, keeps footprint out of ingest). */
  quarantineStoreFactory: QuarantineArtifactStoreFactory;
  /** Builds the per-collection indexing-lock store — concrete is wired by the composition root (DIP, keeps footprint out of ingest). */
  indexingLockStoreFactory: IndexingLockArtifactStoreFactory;
}

export class CollectionFootprintFactory implements CollectionFootprintPort {
  constructor(private readonly deps: FootprintDeps) {}

  /**
   * The port methods run the saga over this factory's own artifact set —
   * consumers see clone/remove intent (bd tea-rags-mcp-54xwd.2); `build`
   * stays the mechanism-level query the purge path and the saga share.
   */
  async clone(source: ResolvedCollection, target: ResolvedCollection): Promise<void> {
    return cloneCollectionFootprint(this, source, target);
  }

  async remove(source: ResolvedCollection, target: ResolvedCollection): Promise<void> {
    return removeCollectionFootprint(this, source, target);
  }

  build(
    source: ResolvedCollection,
    target: ResolvedCollection,
  ): { context: FootprintContext; artifacts: CollectionArtifact[] } {
    const {
      qdrant,
      pool,
      statsCache,
      snapshotBaseDir,
      snapshotStoreFactory,
      quarantineStoreFactory,
      indexingLockStoreFactory,
    } = this.deps;
    // Order = clone order; rollback / remove walk it in reverse.
    const artifacts: CollectionArtifact[] = [
      new QdrantArtifact(qdrant),
      new CodegraphArtifact(pool),
      new SnapshotArtifact(snapshotBaseDir, snapshotStoreFactory),
      new StatsArtifact(statsCache),
      new QuarantineArtifact(snapshotBaseDir, quarantineStoreFactory),
      new IndexingLockArtifact(snapshotBaseDir, indexingLockStoreFactory),
    ];
    return { context: { source, target }, artifacts };
  }
}
