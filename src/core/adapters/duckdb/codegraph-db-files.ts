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

import { existsSync, constants as fsConstants, mkdirSync, readdirSync } from "node:fs";
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

/**
 * Marks the staging copy a storage compaction writes before it publishes it
 * over the live file (bd tea-rags-mcp-dvzdm). Outside the listing pattern for
 * the same reason as {@link CLONE_TMP_SUFFIX}, and one fixed name per database:
 * only the process holding the database's read-write lock compacts it, so a
 * file at this path can only be an interrupted compaction's leftover, which the
 * next compaction clears first.
 */
const COMPACTION_TMP_SUFFIX = ".compact-tmp";

/** Where a compaction of the database at `dbPath` stages its copy. */
export function compactionStagingPath(dbPath: string): string {
  return `${dbPath}${COMPACTION_TMP_SUFFIX}`;
}

/** Where a clone publishing onto the database at `dbPath` stages its copy. */
export function cloneStagingPath(dbPath: string): string {
  return `${dbPath}${CLONE_TMP_SUFFIX}`;
}

/** Extension of a generation's cross-pass input spill under `.xpass`. */
const INPUT_SPILL_EXTENSION = ".ndjson";

/**
 * An operation of this class (or of one of its external collaborators) that
 * can create or unlink a file the layout owns.
 */
export type CodegraphDbArtifactOperation =
  /** `cloneDatabase` — staging copies, pre-publish unlinks, publish renames. */
  | "clone-database"
  /** `removeFiles` / `removeCollection` — the best-effort teardown unlinks. */
  | "remove-files"
  /** `discardOrphanedWal` — WAL reclaim when its database is gone. */
  | "discard-orphaned-wal"
  /** The DuckDB driver itself, opening a database read-write. */
  | "duckdb-driver"
  /** A storage compaction staging its copy via `compactionStagingPath`. */
  | "storage-compaction"
  /** The ingest pipeline appending/draining a generation's input spill. */
  | "pipeline-spill";

/** Which enumeration of `CodegraphDbFiles` can see an artifact class. */
export type CodegraphDbArtifactListing = "db-names" | "generation-names";

/** Identifies a row of {@link CODEGRAPH_DB_ARTIFACT_TAXONOMY}; stable for tests. */
export type CodegraphDbArtifactId =
  | "database"
  | "wal-sidecar"
  | "clone-staging-database"
  | "clone-staging-wal"
  | "compaction-staging-database"
  | "compaction-staging-wal"
  | "cross-pass-input-spill";

/** One class of file the codegraph DB layout can produce on disk. */
export interface CodegraphDbArtifactDescriptor {
  readonly id: CodegraphDbArtifactId;
  /** Directory under `codegraph/` the class lives in. */
  readonly directory: "." | ".xpass";
  /** Filename template; `<stem>` stands for the sanitised physical name. */
  readonly filenamePattern: string;
  /** Lifecycle: operations that create an artifact of this class. */
  readonly createdBy: readonly CodegraphDbArtifactOperation[];
  /** Lifecycle: operations that unlink an artifact of this class. */
  readonly removedBy: readonly CodegraphDbArtifactOperation[];
  /** Whether the artifact survives a clone published onto the same stem. */
  readonly keptAcrossClone: boolean;
  /**
   * Listings that enumerate this class: `listCollectionDbNames` reads
   * `db-names`, `listCollectionGenerationNames` adds `generation-names`.
   * Staging classes list none — deliberately invisible to every sweep.
   */
  readonly visibleToListings: readonly CodegraphDbArtifactListing[];
}

/**
 * Declarative taxonomy of every file class this layout can place on disk —
 * the single place that answers "which files exist for a collection, who
 * creates them, who removes them, which listing can see them".
 *
 * Derived row by row from the methods below; the filename templates reuse the
 * same suffix constants the code builds paths with, so table and code cannot
 * drift apart. The orphan property tests replay arbitrary op sequences and
 * require the on-disk set to equal exactly what this table predicts — no
 * orphans, no stragglers.
 *
 * Both staging pairs — an interrupted clone's and an interrupted compaction's
 * — are reclaimed by `removeFiles` (bd tea-rags-mcp-0qaht.26): a purge of a
 * stem leaves no staging behind. The next `cloneDatabase` onto the same stem
 * clears its own staging first as well, so a leftover is reclaimed by
 * whichever of the two comes next, never left invisible to every listing.
 */
export const CODEGRAPH_DB_ARTIFACT_TAXONOMY: readonly CodegraphDbArtifactDescriptor[] = [
  {
    id: "database",
    directory: ".",
    filenamePattern: "<stem>.duckdb",
    createdBy: ["clone-database", "duckdb-driver"],
    removedBy: ["clone-database", "remove-files"],
    keptAcrossClone: false,
    visibleToListings: ["db-names", "generation-names"],
  },
  {
    id: "wal-sidecar",
    directory: ".",
    filenamePattern: "<stem>.duckdb.wal",
    createdBy: ["clone-database", "duckdb-driver"],
    removedBy: ["clone-database", "remove-files", "discard-orphaned-wal"],
    keptAcrossClone: false,
    visibleToListings: [],
  },
  {
    id: "clone-staging-database",
    directory: ".",
    filenamePattern: `<stem>.duckdb${CLONE_TMP_SUFFIX}`,
    createdBy: ["clone-database"],
    removedBy: ["clone-database", "remove-files"],
    keptAcrossClone: false,
    visibleToListings: [],
  },
  {
    id: "clone-staging-wal",
    directory: ".",
    filenamePattern: `<stem>.duckdb${CLONE_TMP_SUFFIX}.wal`,
    createdBy: ["clone-database"],
    removedBy: ["clone-database", "remove-files"],
    keptAcrossClone: false,
    visibleToListings: [],
  },
  {
    id: "compaction-staging-database",
    directory: ".",
    filenamePattern: `<stem>.duckdb${COMPACTION_TMP_SUFFIX}`,
    createdBy: ["storage-compaction"],
    removedBy: ["storage-compaction", "remove-files"],
    keptAcrossClone: true,
    visibleToListings: [],
  },
  {
    id: "compaction-staging-wal",
    directory: ".",
    filenamePattern: `<stem>.duckdb${COMPACTION_TMP_SUFFIX}.wal`,
    createdBy: ["storage-compaction"],
    removedBy: ["storage-compaction", "remove-files"],
    keptAcrossClone: true,
    visibleToListings: [],
  },
  {
    id: "cross-pass-input-spill",
    directory: ".xpass",
    filenamePattern: `<stem>${INPUT_SPILL_EXTENSION}`,
    createdBy: ["pipeline-spill"],
    removedBy: ["pipeline-spill", "remove-files"],
    keptAcrossClone: true,
    visibleToListings: ["generation-names"],
  },
];

/**
 * Stems of the entries in `dir` named `<base>` or `<base>_v<N>` plus
 * `extension`. Scoped to `^<base>(_v\d+)?$` so it never matches another
 * project's files or a sidecar (`.wal`, staging copies). Empty when `dir` is
 * missing.
 */
function listGenerationStems(dir: string, baseCollectionName: string, extension: string): string[] {
  const base = sanitiseCollectionName(baseCollectionName);
  const pattern = new RegExp(`^(${escapeRegExp(base)}(?:_v\\d+)?)${escapeRegExp(extension)}$`);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Directory missing (never constructed / removed) — nothing to list.
    return [];
  }
  const stems: string[] = [];
  for (const entry of entries) {
    const match = entry.match(pattern);
    if (match) stems.push(match[1]);
  }
  return stems;
}

export class CodegraphDbFiles {
  constructor(private readonly rootDir: string) {}

  /** `<rootDir>/codegraph` — where every per-collection database lives. */
  get dir(): string {
    return join(this.rootDir, "codegraph");
  }

  /** Resolve the disk path for a given collection name. */
  pathFor(physicalCollectionName: PhysicalCollectionName): string {
    return join(this.dir, `${sanitiseCollectionName(physicalCollectionName)}.duckdb`);
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
  writablePathFor(physicalCollectionName: PhysicalCollectionName): string {
    const dbPath = this.pathFor(physicalCollectionName);
    if (existsSync(dbPath)) return dbPath;
    const base = sanitiseCollectionName(physicalCollectionName);
    const generationPhysicalCollectionNames = this.listCollectionDbNames(physicalCollectionName).filter(
      (candidatePhysicalCollectionName) => candidatePhysicalCollectionName !== base,
    );
    if (generationPhysicalCollectionNames.length > 0) {
      throw new CodegraphShadowDatabaseRefusedError({
        collectionName: physicalCollectionName,
        dbPath,
        generations: generationPhysicalCollectionNames,
      });
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
  async discardOrphanedWal(physicalCollectionName: PhysicalCollectionName): Promise<void> {
    const dbPath = this.pathFor(physicalCollectionName);
    if (existsSync(dbPath)) return;
    await unlink(`${dbPath}.wal`).catch(() => undefined);
  }

  /** Whether a graph database file exists for this collection. */
  has(physicalCollectionName: PhysicalCollectionName): boolean {
    return existsSync(this.pathFor(physicalCollectionName));
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
    // Read back from the directory the databases live in: each stem IS the
    // name its generation was opened under.
    return physicalCollectionNamesListedByStorage(listGenerationStems(this.dir, baseCollectionName, ".duckdb"));
  }

  /**
   * Every generation of a base collection that has ANY codegraph file on disk —
   * a database (`listCollectionDbNames`) or a cross-pass input spill
   * (`inputSpillPathFor`) — as collection names.
   *
   * This is what a generation sweep enumerates, not `listCollectionDbNames`: a
   * run that wrote its spill and never reached finalize leaves a spill with no
   * database beside it, and a sweep that only reads `*.duckdb` never sees it.
   * That is how `.xpass` accumulated one ~80 MB file per abandoned generation.
   */
  listCollectionGenerationNames(baseCollectionName: string): PhysicalCollectionName[] {
    const stems = new Set([
      ...listGenerationStems(this.dir, baseCollectionName, ".duckdb"),
      ...listGenerationStems(this.inputSpillDir, baseCollectionName, INPUT_SPILL_EXTENSION),
    ]);
    return physicalCollectionNamesListedByStorage([...stems]);
  }

  /** Cross-pass input-spill directory. Never swept at pool construction (see `inputSpillPathFor`). */
  get inputSpillDir(): string {
    return join(this.dir, ".xpass");
  }

  /**
   * Deterministic cross-pass INPUT spill of one generation (yl9tv): the main
   * thread appends each file's `FileExtraction`, the codegraph worker drains and
   * unlinks it in `finalizeSignals`. No runId — main and worker must resolve the
   * same path. Keyed by the PHYSICAL name like the database, so it belongs to the
   * generation and `removeFiles` takes it with the database.
   */
  inputSpillPathFor(physicalCollectionName: string): string {
    return join(this.inputSpillDir, `${sanitiseCollectionName(physicalCollectionName)}${INPUT_SPILL_EXTENSION}`);
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
    sourcePhysicalCollectionName: PhysicalCollectionName,
    targetPhysicalCollectionName: PhysicalCollectionName,
  ): Promise<void> {
    const from = this.pathFor(sourcePhysicalCollectionName);
    if (!existsSync(from)) return;
    const to = this.writablePathFor(targetPhysicalCollectionName);
    mkdirSync(dirname(to), { recursive: true });
    const staging = cloneStagingPath(to);
    const stagingWal = `${staging}.wal`;
    const sourceHasWal = existsSync(`${from}.wal`);
    // Clear staging leftovers of an interrupted earlier clone onto this target
    // before restaging (ENOENT is the normal first-run case).
    await unlink(staging).catch(() => undefined);
    await unlink(stagingWal).catch(() => undefined);
    // Exclusive: bytes only ever go into a file this copy creates, never over
    // an existing one — a database lands at its path by rename alone, so its
    // inode is new and the pool's dev/ino check sees every replacement (bd
    // tea-rags-mcp-r4veq). An existing staging file here fails the clone.
    await copyFile(from, staging, fsConstants.COPYFILE_EXCL);
    if (sourceHasWal) await copyFile(`${from}.wal`, stagingWal, fsConstants.COPYFILE_EXCL);
    // Publish. The old pair goes first so no intermediate state pairs a new
    // file with a stale one; the renames are atomic within the directory, WAL
    // first and the database last.
    await unlink(to).catch(() => undefined);
    await unlink(`${to}.wal`).catch(() => undefined);
    if (sourceHasWal) await rename(stagingWal, `${to}.wal`);
    await rename(staging, to);
  }

  /**
   * Unlink the collection's DuckDB file, its WAL sidecar, the clone and
   * compaction staging pairs an interrupted operation may have left, and its
   * cross-pass input spill. Idempotent —
   * ENOENT means "already gone". Other unlink errors are swallowed too: a stale
   * file on disk is preferable to aborting a best-effort teardown, and the next
   * open simply overwrites it.
   *
   * Holds no connection, so it never closes one. The pool wraps this with its
   * own cache eviction; callers without a pool are responsible for making sure
   * nothing in THIS process still holds the file.
   */
  async removeFiles(physicalCollectionName: PhysicalCollectionName): Promise<void> {
    const dbPath = this.pathFor(physicalCollectionName);
    await unlink(dbPath).catch(() => undefined);
    await unlink(`${dbPath}.wal`).catch(() => undefined);
    // An interrupted compaction's staging copy belongs to this database too.
    const staging = compactionStagingPath(dbPath);
    await unlink(staging).catch(() => undefined);
    await unlink(`${staging}.wal`).catch(() => undefined);
    // An interrupted clone's staging pair belongs to this database just the
    // same — invisible to every listing, so a purge must take it (bd
    // tea-rags-mcp-0qaht.26), not leave it for the next clone to clear.
    const cloneStaging = cloneStagingPath(dbPath);
    await unlink(cloneStaging).catch(() => undefined);
    await unlink(`${cloneStaging}.wal`).catch(() => undefined);
    // The generation's cross-pass input spill, left behind by a run that never
    // reached the drain. Its lifetime is one run, but its NAME is the
    // generation, so no later run truncates it once the alias moves on.
    await unlink(this.inputSpillPathFor(physicalCollectionName)).catch(() => undefined);
  }

  /**
   * `CodegraphFootprintStore` shape: there is no client cache to evict, so the
   * "was a cached entry evicted" answer is always false.
   */
  async removeCollection(physicalCollectionName: PhysicalCollectionName): Promise<boolean> {
    await this.removeFiles(physicalCollectionName);
    return false;
  }
}
