import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RegistryFileCorruptedError, RegistryWriteError } from "./errors.js";
import type { RegistryFileV1 } from "./types.js";

const FILE_NAME = "registry.json";
const CURRENT_VERSION = 1 as const;

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
