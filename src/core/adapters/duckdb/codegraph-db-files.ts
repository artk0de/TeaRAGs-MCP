/**
 * Path layout of the per-collection codegraph DuckDB files, with no connection
 * pool attached.
 *
 * `GraphDbClientPool` owns the same layout and delegates here, so the naming
 * rules — the sanitised leaf, the `<base>(_v<N>)?.duckdb` generation pattern,
 * the WAL sidecar travelling with its database — live in exactly one place.
 * Splitting them across two implementations is what produced the shadow-DuckDB
 * defect (bd 6goqa) and its recurrence (bd snbzk).
 *
 * It exists separately from the pool because CONSTRUCTING a pool has side
 * effects on the shared `.spill` directory — it sweeps whatever no live process
 * still owns, DuckDB's own temp files included (`spill-files.ts`), on behalf of
 * every project at once. Callers that only need to enumerate or delete files —
 * the `projects unregister --purge` path — construct this instead, and touch
 * nothing on the way in.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { copyFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PhysicalCollectionName } from "../../contracts/types/collection-identity.js";
import { physicalCollectionNamesListedByStorage } from "../../infra/collection-name.js";
import { CodegraphShadowDatabaseRefusedError } from "./errors.js";

/**
 * Sanitise the collection name to a filesystem-safe leaf. The Qdrant
 * collection names tea-rags uses today (`code_<hex>` + ad-hoc CLI names)
 * are already safe, but defend against future shapes containing path
 * separators or control characters.
 */
export function sanitiseCollectionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * Escape regex metacharacters in a (sanitised) collection name before
 * embedding it in the versioned-DB-file pattern. Sanitised names may still
 * contain `.` and `-`, which are regex-meaningful.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Marks the staging copy of a clone in progress. Deliberately outside the
 * `<base>(_v<N>)?.duckdb` pattern `listCollectionDbNames` matches, so a
 * half-written staging file is invisible to the orphan sweep — and the
 * published paths are never touched until the copies are whole.
 */
const CLONE_TMP_SUFFIX = ".clone-tmp";

export class CodegraphDbFiles {
  constructor(private readonly rootDir: string) {}

  /** `<rootDir>/codegraph` — where every per-collection database lives. */
  get dir(): string {
    return join(this.rootDir, "codegraph");
  }

  /** Resolve the disk path for a given collection name. */
  pathFor(collectionName: PhysicalCollectionName): string {
    return join(this.dir, `${sanitiseCollectionName(collectionName)}.duckdb`);
  }

  /**
   * The path of a database about to be opened read-write or copied onto —
   * refusing to CREATE a shadow (bd tea-rags-mcp-39xca.1).
   *
   * A file that already exists is returned as is: the orphan sweep reclaims
   * shadows through the pool, and an existing database is never the defect. A
   * missing one is refused when `<name>_v<N>.duckdb` generations exist, because
   * then `<name>` is an alias base and the write belongs to a generation. The
   * evidence is the codegraph directory itself, so the rule holds identically in
   * the daemon, a worker thread and the main process — none of which may be
   * able to ask Qdrant. It cannot see an alias whose generations have no graph
   * file yet; the `PhysicalCollectionName` brand is what covers that.
   */
  writablePathFor(collectionName: PhysicalCollectionName): string {
    const dbPath = this.pathFor(collectionName);
    if (existsSync(dbPath)) return dbPath;
    const base = sanitiseCollectionName(collectionName);
    const generations = this.listCollectionDbNames(collectionName).filter((name) => name !== base);
    if (generations.length > 0) {
      throw new CodegraphShadowDatabaseRefusedError({ collectionName, dbPath, generations });
    }
    return dbPath;
  }

  /**
   * Unlink `<db>.wal` when no `<db>` exists beside it (bd tea-rags-mcp-amh78).
   *
   * A WAL is the tail of ONE database file, so without that file it can only be
   * left by a client that kept writing after its database was unlinked — DuckDB
   * addresses the WAL by path and recreates it there. Opening the path must not
   * hand the driver a log of a database that no longer exists. DuckDB 1.5.3
   * happens to drop such a WAL when it creates the file; the pool does not rely
   * on a driver version for it. No-op when the database exists or no WAL does.
   */
  async discardOrphanedWal(collectionName: PhysicalCollectionName): Promise<void> {
    const dbPath = this.pathFor(collectionName);
    if (existsSync(dbPath)) return;
    await unlink(`${dbPath}.wal`).catch(() => undefined);
  }

  /** Whether a graph database file exists for this collection. */
  has(collectionName: PhysicalCollectionName): boolean {
    return existsSync(this.pathFor(collectionName));
  }

  /**
   * Enumerate the codegraph DB collection names on disk for a base collection —
   * every `<base>_v<N>.duckdb` file plus the UNVERSIONED `<base>.duckdb`,
   * returned as the collection name (suffix stripped).
   *
   * The unversioned file is included deliberately (bd tea-rags-mcp-6goqa): it
   * used to be excluded, which is exactly why the shadow file the incremental
   * path wrote while addressing collections by their alias was invisible to the
   * orphan sweep and could never be reclaimed.
   *
   * Scoped to `^<base>(_v\d+)?$` so it never touches another project's DBs or
   * WAL/spill sidecars. Empty when the codegraph dir is missing.
   */
  listCollectionDbNames(baseCollectionName: string): PhysicalCollectionName[] {
    const base = sanitiseCollectionName(baseCollectionName);
    const pattern = new RegExp(`^(${escapeRegExp(base)}(?:_v\\d+)?)\\.duckdb$`);
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      // Codegraph dir missing (never constructed / removed) — nothing to sweep.
      return [];
    }
    const names: string[] = [];
    for (const entry of entries) {
      const match = entry.match(pattern);
      if (match) names.push(match[1]);
    }
    // Read back from the directory the databases live in: each stem IS the
    // name its generation was opened under.
    return physicalCollectionNamesListedByStorage(names);
  }

  /**
   * Copy the DuckDB file for sourceCollection to targetCollection, WAL sidecar
   * included. No-op when the source file does not exist (codegraph disabled /
   * not built).
   *
   * The `.wal` travels with the database because the database file alone is
   * only the state as of its last checkpoint — everything written since lives
   * in the sidecar, and a clone that drops it is silently rolled back to that
   * checkpoint. A target WAL with no source counterpart is REMOVED rather than
   * left: collection names get reused, and replaying a previous tenant's write
   * log over a freshly copied database is worse than the truncation this copy
   * avoids.
   *
   * Publishing is atomic (bd tea-rags-mcp-i5kiu). Both files are first staged
   * beside the target as `<target>.duckdb.clone-tmp`(+`.wal`), clearing any
   * staging leftovers of an interrupted earlier clone; only completed copies
   * are then renamed into place — WAL first, database last, each rename whole.
   * A SIGKILL at any instant therefore leaves the target either absent ("not
   * cloned"; the next run re-clones) or complete — never a truncated file, and
   * never a checkpoint-only database that merely looks current. The one
   * mid-publish state is an orphaned WAL beside a missing database, which
   * `discardOrphanedWal` already reclaims; publishing the database last is
   * what keeps that state honest.
   */
  async cloneDatabase(
    sourceCollection: PhysicalCollectionName,
    targetCollection: PhysicalCollectionName,
  ): Promise<void> {
    const from = this.pathFor(sourceCollection);
    if (!existsSync(from)) return;
    const to = this.writablePathFor(targetCollection);
    mkdirSync(dirname(to), { recursive: true });
    const staging = `${to}${CLONE_TMP_SUFFIX}`;
    const stagingWal = `${staging}.wal`;
    const sourceHasWal = existsSync(`${from}.wal`);
    // Clear staging leftovers of an interrupted earlier clone onto this target
    // before restaging (ENOENT is the normal first-run case).
    await unlink(staging).catch(() => undefined);
    await unlink(stagingWal).catch(() => undefined);
    await copyFile(from, staging);
    if (sourceHasWal) await copyFile(`${from}.wal`, stagingWal);
    // Publish. The old pair goes first so no intermediate state pairs a new
    // file with a stale one; the renames are atomic within the directory, WAL
    // first and the database last.
    await unlink(to).catch(() => undefined);
    await unlink(`${to}.wal`).catch(() => undefined);
    if (sourceHasWal) await rename(stagingWal, `${to}.wal`);
    await rename(staging, to);
  }

  /**
   * Unlink the collection's DuckDB file and its WAL sidecar. Idempotent —
   * ENOENT means "already gone". Other unlink errors are swallowed too: a stale
   * file on disk is preferable to aborting a best-effort teardown, and the next
   * open simply overwrites it.
   *
   * Holds no connection, so it never closes one. The pool wraps this with its
   * own cache eviction; callers without a pool are responsible for making sure
   * nothing in THIS process still holds the file.
   */
  async removeFiles(collectionName: PhysicalCollectionName): Promise<void> {
    const dbPath = this.pathFor(collectionName);
    await unlink(dbPath).catch(() => undefined);
    await unlink(`${dbPath}.wal`).catch(() => undefined);
  }

  /**
   * `CodegraphFootprintStore` shape: there is no client cache to evict, so the
   * "was a cached entry evicted" answer is always false.
   */
  async removeCollection(collectionName: PhysicalCollectionName): Promise<boolean> {
    await this.removeFiles(collectionName);
    return false;
  }
}
