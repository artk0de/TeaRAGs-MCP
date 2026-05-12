import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RegistryFileCorruptedError, RegistryWriteError } from "./errors.js";
import type { RegistryFileV1 } from "./types.js";

const FILE_NAME = "registry.json";

function filePath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

export function loadRegistryFile(dataDir: string): RegistryFileV1 | null {
  const path = filePath(dataDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RegistryFileCorruptedError(path, `JSON parse failed: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new RegistryFileCorruptedError(path, "root is not an object");
  }
  const obj = parsed as { version?: unknown; collections?: unknown };
  if (obj.version !== 1) {
    throw new RegistryFileCorruptedError(path, `unsupported version ${String(obj.version)}`);
  }
  if (typeof obj.collections !== "object" || obj.collections === null) {
    throw new RegistryFileCorruptedError(path, "collections is not an object");
  }
  return obj as RegistryFileV1;
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
