/**
 * Composition of the full-footprint purge used by `projects unregister --purge`.
 *
 * It lives in bootstrap rather than in the maintenance domain because the
 * concrete snapshot and quarantine stores belong to `domains/ingest`, which
 * maintenance may not import — the DIP factories in `CollectionFootprintFactory`
 * exist exactly so a composition root supplies them. This is the second such
 * root after `createAppContext`; the purge path is deliberately NOT built from
 * the full AppContext, which would spin up embeddings, the codegraph pool and
 * the daemon just to delete files.
 */

import { join } from "node:path";

import { CodegraphDbFiles } from "../core/adapters/duckdb/codegraph-db-files.js";
import { getDaemonPaths, getStorageDir, readDaemonPid, readRefs } from "../core/adapters/duckdb/daemon/lifecycle.js";
import type { QdrantManager } from "../core/adapters/qdrant/client.js";
import { CollectionIndexingLock } from "../core/domains/ingest/infra/index.js";
import { QuarantineStore } from "../core/domains/ingest/sync/index.js";
import { ShardedSnapshotManager } from "../core/domains/ingest/sync/snapshot/index.js";
import {
  CollectionFootprintFactory,
  CollectionFootprintPurger,
  type CodegraphDaemonLiveness,
} from "../core/domains/maintenance/footprint/index.js";
import type { CollectionRegistry } from "../core/domains/maintenance/registry/index.js";
import { StatsCache } from "../core/infra/stats-cache.js";

export interface FootprintPurgeDeps {
  qdrant: QdrantManager;
  /** Read-only here — used to name worktree clones the purge deliberately keeps. */
  registry: CollectionRegistry;
  /** `~/.tea-rags` or `$TEA_RAGS_DATA_DIR`; snapshots default to `<appData>/snapshots`. */
  appDataDir: string;
}

/**
 * Read the shared codegraph daemon's lifecycle files. Nothing is spawned and no
 * socket is opened — a purge only needs to know whether something else still
 * holds graph handles, so it can report that instead of taking a daemon down
 * that other projects are using.
 */
export function readCodegraphDaemonLiveness(appDataDir: string): CodegraphDaemonLiveness {
  const paths = getDaemonPaths(getStorageDir(appDataDir));
  return {
    pid: () => readDaemonPid(paths),
    refs: () => readRefs(paths),
  };
}

export function createCollectionFootprintPurger(deps: FootprintPurgeDeps): CollectionFootprintPurger {
  const snapshotBaseDir = join(deps.appDataDir, "snapshots");
  const codegraphFiles = new CodegraphDbFiles(deps.appDataDir);
  const footprintFactory = new CollectionFootprintFactory({
    qdrant: deps.qdrant,
    pool: codegraphFiles,
    statsCache: new StatsCache(snapshotBaseDir),
    snapshotBaseDir,
    snapshotStoreFactory: (baseDir, logicalName) => new ShardedSnapshotManager(baseDir, logicalName),
    quarantineStoreFactory: (baseDir, logicalName) => new QuarantineStore(baseDir, logicalName),
    indexingLockStoreFactory: (baseDir, logicalName) => ({
      removeIfStale: async () => new CollectionIndexingLock({ lockDir: baseDir }).removeIfStale(logicalName),
    }),
  });
  return new CollectionFootprintPurger({
    qdrant: deps.qdrant,
    footprintFactory,
    listCodegraphDbs: (base) => codegraphFiles.listCollectionDbNames(base),
    registry: deps.registry,
    daemon: readCodegraphDaemonLiveness(deps.appDataDir),
  });
}
