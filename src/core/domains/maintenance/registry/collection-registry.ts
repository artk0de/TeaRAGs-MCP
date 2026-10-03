import { watch, type FSWatcher } from "node:fs";

import type { LanguageCodeVersions } from "../../../contracts/types/language.js";
import {
  embeddingThroughputOptimumKey,
  type AutoUpdateRunRecord,
  type CollectionEntry,
  type EmbeddingThroughputOptimum,
  type RecordEntryInput,
  type RegistryAutoUpdateConfig,
  type RegistryFileV1,
} from "../../../contracts/types/registry.js";
import { PROJECT_NAME_RE } from "./constants.js";
import {
  formatRegistryEnvPinDrops,
  isRegistryEnvPinMigrationDue,
  migrateRegistryEnvPins,
  type RegistryEnvCodeDefaultsProvider,
} from "./env-pin-migration.js";
import { RegistryConcurrencyError, RegistryNameConflictError, RegistryWriteError } from "./errors.js";
import { flushWithCAS, loadRegistryFile, migrateRegistryFileWithCAS } from "./registry-file.js";

function mergeEmbeddingThroughputOptima(
  existing: CollectionEntry["embeddingThroughputOptima"],
  incoming: CollectionEntry["embeddingThroughputOptima"],
): Pick<CollectionEntry, "embeddingThroughputOptima"> {
  if (existing === undefined && incoming === undefined) return {};
  return { embeddingThroughputOptima: { ...existing, ...incoming } };
}

function snapshotEntries(map: ReadonlyMap<string, CollectionEntry>): Map<string, CollectionEntry> {
  const snapshot = new Map<string, CollectionEntry>();
  for (const [k, v] of map) snapshot.set(k, structuredClone(v));
  return snapshot;
}

export interface CollectionRegistryOptions {
  /**
   * The current code defaults of the registry env snapshot, injected by the
   * composition root (bootstrap owns config parsing). When given, the first load
   * runs the one-time env-pin migration if the file on disk predates it
   * (`migrateRegistryEnvPins`, bd tea-rags-mcp-h4l6k). Without it the registry
   * loads the file as-is and leaves the migration to the next instance that has
   * it — never marking it done.
   */
  envCodeDefaults?: RegistryEnvCodeDefaultsProvider;
}

export class CollectionRegistry {
  private cache: Map<string, CollectionEntry> | null = null;
  /**
   * The entries exactly as this instance last synced them with disk — at load
   * and after every successful flush. The flush diffs `cache` against it so it
   * writes back only the fields THIS instance changed, leaving everything
   * another process wrote in the meantime alone. Null whenever `cache` is.
   */
  private loadedSnapshot: Map<string, CollectionEntry> | null = null;
  private readonly tombstones = new Set<string>();
  private watcher: FSWatcher | null = null;
  private stopHandle: (() => void) | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly options: CollectionRegistryOptions = {},
  ) {}

  private ensureLoaded(): Map<string, CollectionEntry> {
    if (this.cache !== null) return this.cache;
    try {
      const file = this.loadMigrated();
      const map = new Map<string, CollectionEntry>();
      if (file !== null) {
        for (const [k, v] of Object.entries(file.collections)) map.set(k, v);
      }
      this.cache = map;
      this.loadedSnapshot = snapshotEntries(map);
      return map;
    } catch (err) {
      process.stderr.write(`[tea-rags] registry corrupt, starting empty: ${(err as Error).message}\n`);
      this.cache = new Map();
      this.loadedSnapshot = new Map();
      return this.cache;
    }
  }

  /**
   * Load the registry file, first running the one-time env-pin migration on it
   * when defaults were injected and the file predates it. A migration that
   * cannot be written (contention, I/O) is reported and skipped: the file loads
   * unmigrated and the next open retries.
   */
  private loadMigrated(): RegistryFileV1 | null {
    const provider = this.options.envCodeDefaults;
    if (provider === undefined) return loadRegistryFile(this.dataDir);
    try {
      const { file, applied } = migrateRegistryFileWithCAS(this.dataDir, (disk) =>
        isRegistryEnvPinMigrationDue(disk) ? migrateRegistryEnvPins(disk, provider()) : null,
      );
      if (applied !== null) process.stderr.write(formatRegistryEnvPinDrops(applied.droppedPins));
      return file;
    } catch (err) {
      if (!(err instanceof RegistryConcurrencyError) && !(err instanceof RegistryWriteError)) throw err;
      process.stderr.write(`[tea-rags] registry env migration deferred: ${err.message}\n`);
      return loadRegistryFile(this.dataDir);
    }
  }

  private flush(): void {
    const map = this.ensureLoaded();
    const written = flushWithCAS(this.dataDir, map, this.tombstones, this.loadedSnapshot ?? undefined);
    // Adopt what actually landed for the entries we hold: fields disk won stay
    // won, so the NEXT flush does not re-report them as our local change. The
    // adopted entries are collected first and applied after the iteration ends,
    // so nothing is written to `map` while it is being walked.
    const adopted = new Map<string, CollectionEntry>();
    for (const [k, entry] of map) adopted.set(k, written.collections[k] ?? entry);
    const snapshot = new Map<string, CollectionEntry>();
    for (const [k, entry] of adopted) {
      map.set(k, entry);
      snapshot.set(k, structuredClone(entry));
    }
    this.loadedSnapshot = snapshot;
  }

  record(entry: RecordEntryInput): void {
    if (typeof entry.collectionName !== "string" || entry.collectionName.trim().length === 0) {
      throw new Error(`Invalid collectionName: ${JSON.stringify(entry.collectionName)}`);
    }
    if (typeof entry.embeddingDimensions !== "number" || entry.embeddingDimensions < 0) {
      throw new Error(`Invalid embeddingDimensions: ${entry.embeddingDimensions}`);
    }
    if (typeof entry.chunksCount !== "number" || entry.chunksCount < 0) {
      throw new Error(`Invalid chunksCount: ${entry.chunksCount}`);
    }
    const map = this.ensureLoaded();
    const existing = map.get(entry.collectionName);
    map.set(entry.collectionName, {
      ...entry,
      name: existing?.name ?? null,
      // autoUpdate is sticky like name — pipeline reruns must not wipe
      // CLI-set policy (managed via setAutoUpdate / recordAutoUpdateRun).
      ...(existing?.autoUpdate !== undefined ? { autoUpdate: existing.autoUpdate } : {}),
      // languageVersions is sticky for a sharper reason than the two above: the
      // stamp claims a language layer was rebuilt CORPUS-WIDE, and only the run
      // that rebuilt it may advance it (stampLanguageVersions). Every run calls
      // record(), incremental ones included, so letting record() carry the
      // stamp would have auto-update silently clearing the reindex hint
      // (bd tea-rags-mcp-frwka).
      ...(existing?.languageVersions !== undefined ? { languageVersions: existing.languageVersions } : {}),
      // Same claim, per enrichment provider: only a run that rebuilt the
      // provider for every point may advance it (stampTrajectoryVersions).
      ...(existing?.trajectoryVersions !== undefined ? { trajectoryVersions: existing.trajectoryVersions } : {}),
      // embeddingThroughputOptima MERGES rather than sticks: a run overwrites the
      // endpoints its throughput tuner settled on and keeps every other one, so a
      // run that lived on the primary does not erase what an earlier run learnt
      // about the fallback (bd tea-rags-mcp-7ju66).
      ...mergeEmbeddingThroughputOptima(existing?.embeddingThroughputOptima, entry.embeddingThroughputOptima),
      // Worktree provenance is written once, at clone time
      // (setWorktreeProvenance), and the pipeline never passes it — yet the
      // prescribed lifecycle indexes the clone right after `worktree create`.
      // Dropping it here hid every indexed clone from `worktree list` (the
      // teardown backstop's sweep) and made `worktree remove` refuse it
      // (bd tea-rags-mcp-ghk1f). Only an entry that already carries it keeps
      // it, so a re-record never turns an ordinary project into a clone.
      ...(entry.worktreeOf === undefined && existing?.worktreeOf !== undefined
        ? { worktreeOf: existing.worktreeOf, worktreeName: existing.worktreeName }
        : {}),
    });
    // Re-registering a previously-removed collection clears its tombstone.
    this.tombstones.delete(entry.collectionName);
    this.flush();
  }

  get(collectionName: string): CollectionEntry | null {
    return this.ensureLoaded().get(collectionName) ?? null;
  }

  /**
   * The freshest settled embedding throughput optimum any entry holds for this
   * endpoint + model (bd tea-rags-mcp-7ju66). How fast a server embeds at a
   * given batch size is a fact about the server, not about the project that
   * measured it, so every entry is consulted. A runtime hint only — the caller
   * clamps it to its configured bounds and keeps re-probing.
   */
  readEmbeddingThroughputOptimum(endpointUrl: string, model: string): EmbeddingThroughputOptimum | undefined {
    const key = embeddingThroughputOptimumKey(endpointUrl, model);
    let freshest: EmbeddingThroughputOptimum | undefined;
    for (const entry of this.ensureLoaded().values()) {
      const candidate = entry.embeddingThroughputOptima?.[key];
      if (candidate && (!freshest || candidate.settledAt > freshest.settledAt)) freshest = candidate;
    }
    return freshest;
  }

  findByName(name: string): CollectionEntry | null {
    const map = this.ensureLoaded();
    for (const entry of map.values()) {
      if (entry.name === name) return entry;
    }
    return null;
  }

  /**
   * Find a registry entry whose stored `path` exactly matches the input.
   * Used to honor alias-rename semantics: after `register_project` moves an
   * alias to a new path, the same physical Qdrant collection (and its
   * snapshot / codegraph DB, all keyed by `collectionName`) keeps serving
   * the project under the new path. Path-derived hash callers consult this
   * first so the move stays transparent.
   *
   * Path comparison is exact string equality — callers are expected to pass
   * an already-resolved absolute path (matching what `record()` stored).
   */
  findByPath(path: string): CollectionEntry | null {
    if (!path) return null;
    const map = this.ensureLoaded();
    for (const entry of map.values()) {
      if (entry.path === path) return entry;
    }
    return null;
  }

  /**
   * Atomically update the `path` field of an existing entry, preserving
   * every other field (collectionName, name, chunksCount, indexedAt, ...).
   * This is the persistence side of alias-rename: the project's identity
   * (collectionName, snapshot file, codegraph DB) stays untouched; only the
   * filesystem location it points at changes. No-op when the entry is
   * missing — callers should consult `get()` first if they want to fail
   * loud on a missing collection.
   */
  updatePath(collectionName: string, path: string): void {
    const map = this.ensureLoaded();
    const entry = map.get(collectionName);
    if (!entry) return;
    if (entry.path === path) return;
    map.set(collectionName, { ...entry, path });
    this.flush();
  }

  list(): CollectionEntry[] {
    return [...this.ensureLoaded().values()];
  }

  setName(collectionName: string, name: string | null): void {
    const map = this.ensureLoaded();
    const entry = map.get(collectionName);
    if (!entry) {
      throw new Error(`Collection '${collectionName}' not in registry`);
    }
    if (name !== null) {
      if (!PROJECT_NAME_RE.test(name)) {
        throw new Error(`Name '${name}' does not match ${PROJECT_NAME_RE.source}`);
      }
      for (const other of map.values()) {
        if (other.name === name && other.collectionName !== collectionName) {
          throw new RegistryNameConflictError(name, other.collectionName);
        }
      }
    }
    map.set(collectionName, { ...entry, name });
    this.flush();
  }

  /**
   * Set or clear the auto-update policy for a collection. `null` removes the
   * block entirely (disable-and-forget). Throws on unknown collection —
   * callers resolve the alias first and want a loud failure on typos.
   */
  setAutoUpdate(collectionName: string, config: RegistryAutoUpdateConfig | null): void {
    const map = this.ensureLoaded();
    const entry = map.get(collectionName);
    if (!entry) {
      throw new Error(`Collection '${collectionName}' not in registry`);
    }
    if (config === null) {
      const { autoUpdate: _dropped, ...rest } = entry;
      map.set(collectionName, rest);
    } else {
      map.set(collectionName, { ...entry, autoUpdate: config });
    }
    this.flush();
  }

  /**
   * Merge the outcome of one auto-update run into the entry's autoUpdate
   * block. No-op when the entry or block is missing — the project may have
   * been unregistered (or auto-update disabled) while the detached updater
   * ran; the updater must not fail on that race.
   */
  recordAutoUpdateRun(collectionName: string, lastRun: AutoUpdateRunRecord): void {
    const map = this.ensureLoaded();
    const entry = map.get(collectionName);
    if (!entry?.autoUpdate) return;
    map.set(collectionName, { ...entry, autoUpdate: { ...entry.autoUpdate, lastRun } });
    this.flush();
  }

  remove(collectionName: string): boolean {
    const map = this.ensureLoaded();
    const had = map.delete(collectionName);
    if (had) {
      this.tombstones.add(collectionName);
      this.flush();
    }
    return had;
  }

  listWorktrees(): CollectionEntry[] {
    return [...this.ensureLoaded().values()].filter((e) => typeof e.worktreeOf === "string");
  }

  findWorktree(name: string): CollectionEntry | null {
    const map = this.ensureLoaded();
    for (const entry of map.values()) {
      if (entry.worktreeOf !== undefined && entry.worktreeName === name) return entry;
    }
    return null;
  }

  /**
   * Advance the per-language code-version stamp (bd tea-rags-mcp-frwka).
   *
   * Merges per language AND per axis: a codegraph enrichment recompute passes
   * only `walker` / `codegraphSchema`, and the `grammar` / `chunking` values
   * from the last full reindex must survive it — a recompute leaves point ids
   * where they are, so claiming the chunk set was rebuilt would be false.
   *
   * Silently no-ops for an unregistered collection. The caller is a finished
   * indexing run; failing it after the data landed would report the whole run
   * as failed over a bookkeeping write.
   */
  stampLanguageVersions(collectionName: string, stamp: Record<string, Partial<LanguageCodeVersions>>): void {
    const map = this.ensureLoaded();
    const entry = map.get(collectionName);
    if (!entry) return;
    const merged: Record<string, Partial<LanguageCodeVersions>> = { ...entry.languageVersions };
    for (const [language, versions] of Object.entries(stamp)) {
      merged[language] = { ...merged[language], ...versions };
    }
    map.set(collectionName, { ...entry, languageVersions: merged });
    this.flush();
  }

  /**
   * Record the algorithm version of each enrichment provider a finished run
   * rebuilt for every point (bd tea-rags-mcp-xi2r9). Merges per provider: a git
   * recompute leaves another provider's stamp where it was. Silently no-ops for
   * an unregistered collection, as `stampLanguageVersions` does.
   */
  stampTrajectoryVersions(collectionName: string, stamp: Record<string, number>): void {
    const map = this.ensureLoaded();
    const entry = map.get(collectionName);
    if (!entry) return;
    map.set(collectionName, { ...entry, trajectoryVersions: { ...entry.trajectoryVersions, ...stamp } });
    this.flush();
  }

  /**
   * Record that this collection's enrichment layer includes the codegraph
   * trajectory (bd tea-rags-mcp-5m8g3).
   *
   * `resolveRegistryEnv` replays the dedicated `codegraphEnabled` field into
   * `CODEGRAPH_ENABLED`, and an entry written before the field existed carries
   * no value — it composes without the codegraph tools at call time even
   * though its index holds a full graph. A full pipeline run stamps the field
   * through `recordRegistryEntry`; the enrichment recompute rebuilds the same
   * graph without ever reaching that path, so it stamps here. Only a run that
   * actually rebuilt the layer may claim it — the same rule as
   * {@link stampLanguageVersions} — and an entry set to `false` explicitly is
   * overridden by that run, exactly as any set-env decision yields to the
   * ambient env of the run that follows it.
   *
   * Silently no-ops for an unregistered collection. The caller is a finished
   * run; failing it after the data landed would report the whole run as
   * failed over a bookkeeping write.
   */
  stampCodegraphEnabled(collectionName: string): void {
    const map = this.ensureLoaded();
    const entry = map.get(collectionName);
    if (!entry) return;
    map.set(collectionName, { ...entry, codegraphEnabled: true });
    this.flush();
  }

  setWorktreeProvenance(collectionName: string, worktreeOf: string, worktreeName: string): void {
    const map = this.ensureLoaded();
    const entry = map.get(collectionName);
    if (!entry) throw new Error(`Cannot set worktree provenance: ${collectionName} not registered`);
    map.set(collectionName, { ...entry, worktreeOf, worktreeName });
    this.flush();
  }

  /**
   * Subscribe to registry.json mtime changes and invalidate the in-process
   * cache on every event so the next read sees fresh data written by a
   * concurrent CLI or pipeline run. Returns a stop handle that closes the
   * watcher. Idempotent — repeated calls return the same handle. Audit #2.
   *
   * fs.watch fails synchronously if the path does not exist; we tolerate
   * by deferring the watch silently. Worst case: the very first external
   * mutation before our process records anything is missed — extremely
   * unlikely and recovered by the merge-on-write CAS in flush() anyway.
   */
  startWatching(): () => void {
    if (this.stopHandle !== null) return this.stopHandle;
    // Watch the data directory, not the file itself. macOS kqueue (and
    // similar platforms) binds file-level watchers to inodes; our atomic
    // rename in saveRegistryFile replaces the inode on every write, so a
    // file-level watcher detaches after the first rename. A directory
    // watcher survives the rename cycle and lets us filter by filename.
    // Audit #2 regression fix.
    try {
      this.watcher = watch(this.dataDir, { persistent: false }, (_eventType, filename) => {
        if (filename === "registry.json" || filename === null) {
          this.cache = null;
          this.loadedSnapshot = null;
        }
      });
    } catch {
      this.watcher = null;
    }
    this.stopHandle = () => {
      if (this.watcher !== null) {
        this.watcher.close();
        this.watcher = null;
      }
      this.stopHandle = null;
    };
    return this.stopHandle;
  }
}
