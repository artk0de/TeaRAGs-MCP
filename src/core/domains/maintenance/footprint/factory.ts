import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import type { CollectionArtifact, FootprintContext, ResolvedCollection } from "./artifact.js";
import { CodegraphArtifact } from "./codegraph-artifact.js";
import { QdrantArtifact } from "./qdrant-artifact.js";
import { QuarantineArtifact } from "./quarantine-artifact.js";
import { SnapshotArtifact } from "./snapshot-artifact.js";
import { StatsArtifact } from "./stats-artifact.js";

export interface FootprintDeps {
  qdrant: QdrantManager;
  pool: GraphDbClientPool;
  statsCache: StatsCache;
  snapshotBaseDir: string;
}

export class CollectionFootprintFactory {
  constructor(private readonly deps: FootprintDeps) {}

  build(
    source: ResolvedCollection,
    target: ResolvedCollection,
  ): { context: FootprintContext; artifacts: CollectionArtifact[] } {
    const { qdrant, pool, statsCache, snapshotBaseDir } = this.deps;
    // Order = clone order; rollback / remove walk it in reverse.
    const artifacts: CollectionArtifact[] = [
      new QdrantArtifact(qdrant),
      new CodegraphArtifact(pool),
      new SnapshotArtifact(snapshotBaseDir),
      new StatsArtifact(statsCache),
      new QuarantineArtifact(snapshotBaseDir),
    ];
    return { context: { source, target }, artifacts };
  }
}
