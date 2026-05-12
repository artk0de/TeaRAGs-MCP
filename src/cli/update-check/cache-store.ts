import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CacheEntry, UpdateStatus } from "./types.js";

export interface CacheStore {
  /** Returns the cached entry or null if missing/corrupt. Never throws. */
  read: () => CacheEntry | null;
  /** Atomically replaces the cache contents. Silent on EACCES / disk full. */
  write: (entry: CacheEntry) => void;
}

/** Default cache file location: `~/.tea-rags/update-check.json`. */
export function defaultCachePath(): string {
  return join(homedir(), ".tea-rags", "update-check.json");
}

export class FileCacheStore implements CacheStore {
  constructor(private readonly path: string = defaultCachePath()) {}

  read(): CacheEntry | null {
    if (!existsSync(this.path)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.tryDelete();
      return null;
    }

    if (!isCacheEntry(parsed)) {
      this.tryDelete();
      return null;
    }
    return parsed;
  }

  write(entry: CacheEntry): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(entry), "utf-8");
      renameSync(tmp, this.path);
    } catch {
      // Silent fail per design — caller does not need to know.
    }
  }

  private tryDelete(): void {
    try {
      rmSync(this.path, { force: true });
    } catch {
      // Ignore.
    }
  }
}

function isCacheEntry(v: unknown): v is CacheEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return isUpdateStatus(o.status) && typeof o.fetchedAt === "number" && typeof o.ttlMs === "number";
}

function isUpdateStatus(v: unknown): v is UpdateStatus {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind === "available") {
    return typeof o.current === "string" && typeof o.latest === "string" && typeof o.changelogUrl === "string";
  }
  if (o.kind === "up-to-date") return typeof o.current === "string";
  if (o.kind === "unavailable") {
    return o.reason === "network" || o.reason === "timeout" || o.reason === "malformed" || o.reason === "cache-miss";
  }
  return false;
}
