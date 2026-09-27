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
import { DaemonDatabaseFileReplacer } from "../core/adapters/duckdb/daemon/database-file-replacer.js";
import { getDaemonPaths, getStorageDir, readDaemonPid, readRefs } from "../core/adapters/duckdb/daemon/lifecycle.js";
import type { QdrantManager } from "../core/adapters/qdrant/client.js";
import type { CodegraphFootprintStore } from "../core/contracts/types/footprint.js";
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

/**
 * The purge's codegraph store: file layout from `CodegraphDbFiles`, file
 * replacement routed through this build's daemon when one is up (bd
 * tea-rags-mcp-r4veq). The purge runs while the daemon may still hold a client
 * on the collection it deletes — it reports the daemon "left running" rather
 * than stopping it — so deleting the file from here would replace it under that
 * client. The daemon's pool drains the client's in-flight ops and removes the
 * file under its path lease instead; with no daemon up, or one that predates
 * the ops, the files are removed here, as before. Like the liveness report it
 * never spawns a daemon.
 */
export function createPurgeCodegraphStore(appDataDir: string): CodegraphFootprintStore {
  const codegraphFiles = new CodegraphDbFiles(appDataDir);
  const daemon = new DaemonDatabaseFileReplacer(getDaemonPaths(getStorageDir(appDataDir)).socketPath);
  return {
    listCollectionDbNames: (base) => codegraphFiles.listCollectionDbNames(base),
    removeCollection: async (collectionName) => {
      const replaced = await daemon.removeDatabase(collectionName);
      if (replaced.handledBy === "daemon") return replaced.evicted;
      return codegraphFiles.removeCollection(collectionName);
    },
    cloneDatabase: async (sourceCollection, targetCollection) => {
      const replaced = await daemon.cloneDatabase(sourceCollection, targetCollection);
      if (replaced.handledBy === "daemon") return;
      await codegraphFiles.cloneDatabase(sourceCollection, targetCollection);
    },
  };
}

export function createCollectionFootprintPurger(deps: FootprintPurgeDeps): CollectionFootprintPurger {
  const snapshotBaseDir = join(deps.appDataDir, "snapshots");
  const codegraphStore = createPurgeCodegraphStore(deps.appDataDir);
  const footprintFactory = new CollectionFootprintFactory({
    qdrant: deps.qdrant,
    pool: codegraphStore,
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
    // Generations, not databases: a spill left without its `.duckdb` is swept
    // too (see `CodegraphDbFiles#listCollectionGenerationNames`).
    listCodegraphDbs: (base) => new CodegraphDbFiles(deps.appDataDir).listCollectionGenerationNames(base),
    registry: deps.registry,
    daemon: readCodegraphDaemonLiveness(deps.appDataDir),
  });
}
