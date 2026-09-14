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
        const reconciled = this.reconcileWithInstalledVersion(cached);
        if (reconciled !== null) return reconciled;
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

  /**
   * A TTL-valid entry was written by whichever tea-rags was installed at fetch
   * time; an upgrade or relink inside the TTL makes its `current` stale.
   * Returns the status to serve, or null when the entry cannot answer for the
   * installed version and must be treated as a cache miss.
   *
   * - `unavailable` carries no version — served as-is.
   * - `current` matches the install — served as-is.
   * - `available` for another install — re-derived offline from the cached
   *   `latest`, persisted under the ORIGINAL fetchedAt/ttlMs so a re-derivation
   *   never extends the registry answer's lifetime.
   * - `up-to-date` for another install — holds no `latest` to re-derive from.
   */
  private reconcileWithInstalledVersion(cached: CacheEntry): UpdateStatus | null {
    const { status } = cached;
    if (status.kind === "unavailable") return status;

    const installed = this.versionSource.getCurrent();
    if (status.current === installed) return status;
    if (status.kind === "up-to-date") return null;

    const rederived = this.deriveStatus(installed, status.latest);
    this.cache.write({ status: rederived, fetchedAt: cached.fetchedAt, ttlMs: cached.ttlMs });
    return rederived;
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
