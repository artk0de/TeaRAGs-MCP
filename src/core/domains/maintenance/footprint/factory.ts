import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type {
  CodegraphFootprintStore,
  IndexingLockArtifactStoreFactory,
  QuarantineArtifactStoreFactory,
  SnapshotArtifactStoreFactory,
} from "../../../contracts/index.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import type { CollectionArtifact, FootprintContext, ResolvedCollection } from "./artifact.js";
import { CodegraphArtifact } from "./codegraph-artifact.js";
import { IndexingLockArtifact } from "./indexing-lock-artifact.js";
import { QdrantArtifact } from "./qdrant-artifact.js";
import { QuarantineArtifact } from "./quarantine-artifact.js";
import { SnapshotArtifact } from "./snapshot-artifact.js";
import { StatsArtifact } from "./stats-artifact.js";

export interface FootprintDeps {
  qdrant: QdrantManager;
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

export class CollectionFootprintFactory {
  constructor(private readonly deps: FootprintDeps) {}

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
