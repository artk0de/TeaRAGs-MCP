import { loadRegistryFile, saveRegistryFile } from "./registry-file.js";
import type { CollectionEntry, RecordEntryInput, RegistryFileV1 } from "./types.js";

export class ProjectNameNotUniqueError extends Error {
  constructor(name: string, existingCollectionName: string) {
    super(`Project name '${name}' is not unique — already used by '${existingCollectionName}'`);
    this.name = "ProjectNameNotUniqueError";
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class CollectionRegistry {
  private cache: Map<string, CollectionEntry> | null = null;

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
    const file: RegistryFileV1 = {
      version: 1,
      collections: Object.fromEntries(map.entries()),
    };
    saveRegistryFile(this.dataDir, file);
  }

  record(entry: RecordEntryInput): void {
    const map = this.ensureLoaded();
    const existing = map.get(entry.collectionName);
    map.set(entry.collectionName, {
      ...entry,
      name: existing?.name ?? null,
    });
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
      if (!NAME_RE.test(name)) {
        throw new Error(`Name '${name}' does not match ${NAME_RE.source}`);
      }
      for (const other of map.values()) {
        if (other.name === name && other.collectionName !== collectionName) {
          throw new ProjectNameNotUniqueError(name, other.collectionName);
        }
      }
    }
    map.set(collectionName, { ...entry, name });
    this.flush();
  }

  remove(collectionName: string): boolean {
    const map = this.ensureLoaded();
    const had = map.delete(collectionName);
    if (had) this.flush();
    return had;
  }
}
