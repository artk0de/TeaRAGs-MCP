import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

import { PROJECT_NAME_RE } from "./constants.js";
import { RegistryNameConflictError } from "./errors.js";
import { flushWithCAS, loadRegistryFile } from "./registry-file.js";
import type { CollectionEntry, RecordEntryInput } from "./types.js";

export class CollectionRegistry {
  private cache: Map<string, CollectionEntry> | null = null;
  private readonly tombstones = new Set<string>();
  private watcher: FSWatcher | null = null;
  private stopHandle: (() => void) | null = null;

  constructor(private readonly dataDir: string) {}

  private ensureLoaded(): Map<string, CollectionEntry> {
    if (this.cache !== null) return this.cache;
    try {
      const file = loadRegistryFile(this.dataDir);
      const map = new Map<string, CollectionEntry>();
      if (file !== null) {
        for (const [k, v] of Object.entries(file.collections)) map.set(k, v);
      }
      this.cache = map;
      return map;
    } catch (err) {
      process.stderr.write(`[tea-rags] registry corrupt, starting empty: ${(err as Error).message}\n`);
      this.cache = new Map();
      return this.cache;
    }
  }

  private flush(): void {
    const map = this.ensureLoaded();
    flushWithCAS(this.dataDir, map, this.tombstones);
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
    });
    // Re-registering a previously-removed collection clears its tombstone.
    this.tombstones.delete(entry.collectionName);
    this.flush();
  }

  get(collectionName: string): CollectionEntry | null {
    return this.ensureLoaded().get(collectionName) ?? null;
  }

  findByName(name: string): CollectionEntry | null {
    const map = this.ensureLoaded();
    for (const entry of map.values()) {
      if (entry.name === name) return entry;
    }
    return null;
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

  remove(collectionName: string): boolean {
    const map = this.ensureLoaded();
    const had = map.delete(collectionName);
    if (had) {
      this.tombstones.add(collectionName);
      this.flush();
    }
    return had;
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
    const path = join(this.dataDir, "registry.json");
    try {
      this.watcher = watch(path, { persistent: false }, () => {
        this.cache = null;
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
