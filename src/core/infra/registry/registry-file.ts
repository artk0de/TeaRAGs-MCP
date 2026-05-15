import fs, { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  RegistryConcurrencyError,
  RegistryFileCorruptedError,
  RegistryWriteError,
} from "../../adapters/registry/errors.js";
import type { CollectionEntry, RegistryFileV1 } from "./types.js";

const FILE_NAME = "registry.json";
const CURRENT_VERSION = 1 as const;
const CAS_MAX_ATTEMPTS = 5;
const CAS_BACKOFF_MS_BASE = 10;

/**
 * Registered migrations transform an older on-disk shape into the current
 * RegistryFileV1. Empty in this PR — framework only. When a V2 lands, add
 * `1: (raw) => transformV1toV2(raw)` here in the same PR as the schema bump.
 */
const KNOWN_MIGRATIONS: Record<number, (raw: unknown) => RegistryFileV1> = {};

function filePath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

/**
 * Rename a corrupt registry.json to registry.json.corrupt-<ISO>.bak so the
 * user can recover entries by hand or via `tea-rags doctor --recover-registry`
 * (PR2). Best-effort: if the rename itself fails, log to stderr and re-throw
 * the caller's corruption error — never silently overwrite.
 */
function backupCorruptFile(path: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.corrupt-${stamp}.bak`;
  try {
    renameSync(path, backupPath);
    process.stderr.write(`[tea-rags] corrupt registry preserved at ${backupPath}\n`);
  } catch (err) {
    process.stderr.write(`[tea-rags] failed to back up corrupt registry: ${(err as Error).message}\n`);
  }
}

export function loadRegistryFile(dataDir: string): RegistryFileV1 | null {
  const path = filePath(dataDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    backupCorruptFile(path);
    throw new RegistryFileCorruptedError(path, `JSON parse failed: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    backupCorruptFile(path);
    throw new RegistryFileCorruptedError(path, "root is not an object");
  }
  const obj = parsed as { version?: unknown; collections?: unknown };
  if (obj.version === CURRENT_VERSION) {
    if (typeof obj.collections !== "object" || obj.collections === null) {
      backupCorruptFile(path);
      throw new RegistryFileCorruptedError(path, "collections is not an object");
    }
    return obj as RegistryFileV1;
  }
  if (typeof obj.version === "number" && KNOWN_MIGRATIONS[obj.version]) {
    const migrated = KNOWN_MIGRATIONS[obj.version](parsed);
    saveRegistryFile(dataDir, migrated);
    return migrated;
  }
  backupCorruptFile(path);
  throw new RegistryFileCorruptedError(path, `unsupported version ${String(obj.version)}`);
}

export function saveRegistryFile(dataDir: string, file: RegistryFileV1): void {
  mkdirSync(dataDir, { recursive: true });
  const path = filePath(dataDir);
  const tmp = `${path}.tmp.${process.pid}`;
  const json = JSON.stringify(file, null, 2);
  try {
    writeFileSync(tmp, json, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    throw new RegistryWriteError(path, err);
  }
}

/**
 * Per-collection last-writer-wins with a directional bias on the sticky
 * `name` field:
 *
 *   - in-memory non-null wins (explicit user action via setName)
 *   - in-memory null + disk non-null → disk wins (don't erase concurrent rename)
 *
 * All other fields take the in-memory value (the local process is the
 * authoritative source for chunksCount / indexedAt / etc.).
 */
export function mergeRegistryEntries(disk: CollectionEntry, mem: CollectionEntry): CollectionEntry {
  const name = mem.name !== null ? mem.name : disk.name;
  return { ...mem, name };
}

/**
 * Merge an in-memory delta (Map<collectionName, CollectionEntry>) into the
 * on-disk RegistryFileV1. Disk-only entries are preserved; delta-only
 * entries are inserted; overlapping entries go through mergeRegistryEntries.
 *
 * Optional `tombstones` carry intentional removes: any collection name in
 * the set is dropped from the merged result even if it is still on disk.
 */
export function mergeRegistryDelta(
  disk: RegistryFileV1 | null,
  delta: Map<string, CollectionEntry>,
  tombstones?: ReadonlySet<string>,
): RegistryFileV1 {
  const out: Record<string, CollectionEntry> = {};
  if (disk) {
    for (const [k, v] of Object.entries(disk.collections)) out[k] = v;
  }
  for (const [k, v] of delta.entries()) {
    const onDisk = out[k];
    out[k] = onDisk ? mergeRegistryEntries(onDisk, v) : v;
  }
  if (tombstones) {
    for (const k of tombstones) delete out[k];
  }
  return { version: CURRENT_VERSION, collections: out };
}

function sleepSync(ms: number): void {
  // flush() is sync today; this matches the existing API. Busy-wait bounded:
  // max single sleep 80 ms (10 · 2^3), 4 sleeps total before the final
  // attempt → ~150 ms cumulative wait worst case.
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

function statOrNull(path: string): { ino: number; mtimeMs: number } | null {
  try {
    // Use the default fs namespace so vi.spyOn(fs, "statSync") can intercept
    // in tests (named ESM imports are read-only bindings).
    const s = fs.statSync(path);
    return { ino: Number(s.ino), mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Flush an in-memory delta to disk under cross-process CAS. Retries up to
 * CAS_MAX_ATTEMPTS times with exponential backoff if another writer mutates
 * the file between our read and our rename. Closes audit #1.
 *
 * Optional `tombstones` carry intentional remove() requests so the merge
 * can drop those keys instead of resurrecting them from disk.
 *
 * @throws RegistryConcurrencyError when the retry budget is exhausted
 *   because the on-disk file keeps changing between our stat-before and
 *   stat-after.
 */
export function flushWithCAS(
  dataDir: string,
  delta: Map<string, CollectionEntry>,
  tombstones?: ReadonlySet<string>,
): void {
  const path = filePath(dataDir);
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const before = statOrNull(path);
    const disk = loadRegistryFile(dataDir);
    const merged = mergeRegistryDelta(disk, delta, tombstones);
    const after = statOrNull(path);
    const stable =
      (before === null && after === null) ||
      (before !== null && after !== null && before.ino === after.ino && before.mtimeMs === after.mtimeMs);
    if (stable) {
      saveRegistryFile(dataDir, merged);
      return;
    }
    if (attempt < CAS_MAX_ATTEMPTS - 1) {
      sleepSync(CAS_BACKOFF_MS_BASE * 2 ** attempt);
    }
  }
  throw new RegistryConcurrencyError(path, CAS_MAX_ATTEMPTS);
}
