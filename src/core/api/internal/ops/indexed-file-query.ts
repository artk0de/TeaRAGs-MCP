/**
 * Index membership of one file (bd tea-rags-mcp-ueplg): is this file part of
 * the index snapshot that serves its working tree? The plugin's
 * PreToolUse(Read) hook asks it on every `Read`, so it stays I/O-light — the
 * registry file, `git rev-parse` for the tree root, and the collection's
 * sharded snapshot. No Qdrant, no daemon, no embedding provider.
 *
 * "Indexed" means the path the last index run recorded, the same set
 * `find_symbol(relativePath:)` serves from. A file created after that run is
 * NOT indexed yet and answers null.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";

import { ShardedSnapshotManager } from "../../../domains/ingest/sync/snapshot/sharded-snapshot.js";
import { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
import { resolveWorkingTree } from "../collection-resolver.js";

export interface IndexedFileMatch {
  /** Registered alias of the serving index, null when the entry carries none. */
  project: string | null;
  collectionName: string;
  /** The file's path relative to the working tree that holds it. */
  relativePath: string;
}

export interface IndexedFileQueryDeps {
  registry: CollectionRegistry;
  /** Directory holding every collection's sharded snapshot (`<data dir>/snapshots`). */
  snapshotsDir: string;
}

/**
 * The serving index's view of `path`, or null when no registered index lists
 * it: the path is missing, outside every registered project, not yet indexed,
 * or the snapshot cannot be read. Never throws — a caller deciding whether to
 * block a read must fail open.
 */
export async function findIndexedFile(deps: IndexedFileQueryDeps, path: string): Promise<IndexedFileMatch | null> {
  return findFirstIndexedFile(deps, [path]);
}

/**
 * {@link findIndexedFile} over a batch: the first path, in order, that a
 * registered index lists. Each collection's snapshot is read once per batch —
 * a compound shell read (`cat a.rb; sed -n 1,40p b.rb`) costs one load.
 */
export async function findFirstIndexedFile(
  deps: IndexedFileQueryDeps,
  paths: readonly string[],
): Promise<IndexedFileMatch | null> {
  const listedByCollection = new Map<string, Promise<ReadonlySet<string> | null>>();
  const listedFiles = async (collectionName: string): Promise<ReadonlySet<string> | null> => {
    let listed = listedByCollection.get(collectionName);
    if (!listed) {
      listed = new ShardedSnapshotManager(deps.snapshotsDir, collectionName)
        .load()
        .then((snapshot) => (snapshot ? new Set(snapshot.files.keys()) : null))
        .catch(() => null);
      listedByCollection.set(collectionName, listed);
    }
    return listed;
  };
  for (const path of paths) {
    const match = await matchIndexedFile(deps.registry, path, listedFiles);
    if (match) return match;
  }
  return null;
}

/** One path's match against its serving index; null on any failure (fail open). */
async function matchIndexedFile(
  registry: CollectionRegistry,
  path: string,
  listedFiles: (collectionName: string) => Promise<ReadonlySet<string> | null>,
): Promise<IndexedFileMatch | null> {
  try {
    const realFile = realpathSync(path);
    const workingTree = resolveWorkingTree(registry, { path: dirname(realFile) });
    const entry = registry.get(workingTree.baseIndex.collectionName);
    if (!entry || !workingTree.root) return null;
    const relativePath = relative(workingTree.root, realFile).split(sep).join("/");
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
    if (!(await listedFiles(entry.collectionName))?.has(relativePath)) return null;
    return { project: entry.name ?? null, collectionName: entry.collectionName, relativePath };
  } catch {
    return null;
  }
}

/** {@link findFirstIndexedFile} over the registry kept in `dataDir`. */
export async function findFirstIndexedFileInDataDir(
  dirs: { dataDir: string; snapshotsDir: string },
  paths: readonly string[],
): Promise<IndexedFileMatch | null> {
  return findFirstIndexedFile(
    { registry: new CollectionRegistry(dirs.dataDir), snapshotsDir: dirs.snapshotsDir },
    paths,
  );
}
