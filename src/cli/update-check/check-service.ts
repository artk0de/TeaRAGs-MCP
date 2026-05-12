import type { CacheStore } from "./cache-store.js";
import type { RegistryClient } from "./registry-client.js";
import { compareSemver } from "./semver.js";
import { available, unavailable, upToDate, type CacheEntry, type CheckOptions, type UpdateStatus } from "./types.js";
import type { VersionSource } from "./version-source.js";

const PACKAGE_NAME = "tea-rags";
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;

/**
 * Orchestrates the update check. Depends only on three interfaces so the
 * whole class is testable with plain object literals (see check-service.test.ts).
 */
export class UpdateCheckService {
  constructor(
    private readonly versionSource: VersionSource,
    private readonly registry: RegistryClient,
    private readonly cache: CacheStore,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async checkForUpdate(opts: CheckOptions): Promise<UpdateStatus> {
    const now = this.clock();

    if (opts.preferCache) {
      const cached = this.cache.read();
      if (cached !== null && now - cached.fetchedAt < cached.ttlMs) {
        return cached.status;
      }
    }

    if (!opts.allowNetwork) {
      return unavailable("cache-miss");
    }

    const current = this.versionSource.getCurrent();
    const latest = await this.registry.fetchLatestVersion(
      PACKAGE_NAME,
      opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : undefined,
    );

    const status = this.deriveStatus(current, latest);
    this.persist(status, now);
    return status;
  }

  private deriveStatus(current: string, latest: string | null): UpdateStatus {
    if (latest === null) return unavailable("network");
    const cmp = compareSemver(current, latest);
    if (cmp < 0) return available(current, latest);
    return upToDate(current);
  }

  private persist(status: UpdateStatus, now: number): void {
    const ttlMs = status.kind === "unavailable" ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS;
    const entry: CacheEntry = { status, fetchedAt: now, ttlMs };
    this.cache.write(entry);
  }
}
