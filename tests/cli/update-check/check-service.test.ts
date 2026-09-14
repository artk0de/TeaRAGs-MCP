import { describe, expect, it, vi } from "vitest";

import type { CacheStore } from "../../../src/cli/update-check/cache-store.js";
import { UpdateCheckService } from "../../../src/cli/update-check/check-service.js";
import type { RegistryClient } from "../../../src/cli/update-check/registry-client.js";
import type { CacheEntry, UpdateStatus } from "../../../src/cli/update-check/types.js";
import type { VersionSource } from "../../../src/cli/update-check/version-source.js";

const NOW = 1_700_000_000_000;

function mockSource(current: string): VersionSource {
  return { getCurrent: () => current };
}
function mockRegistry(latest: string | null): RegistryClient {
  return { fetchLatestVersion: vi.fn().mockResolvedValue(latest) };
}
function mockCache(initial: CacheEntry | null = null): CacheStore & { reads: number; writes: CacheEntry[] } {
  const state = { entry: initial, reads: 0, writes: [] as CacheEntry[] };
  return {
    read: () => {
      state.reads++;
      return state.entry;
    },
    write: (e) => {
      state.writes.push(e);
      state.entry = e;
    },
    get reads() {
      return state.reads;
    },
    get writes() {
      return state.writes;
    },
  };
}

describe("UpdateCheckService.checkForUpdate", () => {
  it("returns available when current < latest (live HTTP, preferCache=false)", async () => {
    const cache = mockCache();
    const registry = mockRegistry("1.24.0");
    const svc = new UpdateCheckService(mockSource("1.23.1"), registry, cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: false });
    expect(status).toEqual<UpdateStatus>({
      kind: "available",
      current: "1.23.1",
      latest: "1.24.0",
      changelogUrl: "https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0",
    });
    expect(registry.fetchLatestVersion).toHaveBeenCalled();
    expect(cache.writes).toHaveLength(1);
    expect(cache.writes[0].ttlMs).toBe(86_400_000);
  });

  it("returns up-to-date when current == latest", async () => {
    const svc = new UpdateCheckService(mockSource("1.23.1"), mockRegistry("1.23.1"), mockCache(), () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: false });
    expect(status).toEqual<UpdateStatus>({ kind: "up-to-date", current: "1.23.1" });
  });

  it("returns up-to-date when current > latest (downgrade edge: treat as up-to-date)", async () => {
    const svc = new UpdateCheckService(mockSource("2.0.0"), mockRegistry("1.99.99"), mockCache(), () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: false });
    expect(status.kind).toBe("up-to-date");
  });

  it("returns unavailable('network') and writes negative cache on registry null", async () => {
    const cache = mockCache();
    const svc = new UpdateCheckService(mockSource("1.0.0"), mockRegistry(null), cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: false });
    expect(status).toEqual<UpdateStatus>({ kind: "unavailable", reason: "network" });
    expect(cache.writes[0].ttlMs).toBe(300_000);
  });

  it("returns cached value when fresh and preferCache=true (no HTTP)", async () => {
    const fresh: CacheEntry = {
      status: {
        kind: "available",
        current: "1.0.0",
        latest: "1.1.0",
        changelogUrl: "https://x",
      },
      fetchedAt: NOW - 1000,
      ttlMs: 86_400_000,
    };
    const registry = mockRegistry("1.2.0");
    const cache = mockCache(fresh);
    const svc = new UpdateCheckService(mockSource("1.0.0"), registry, cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: true });
    expect(status).toEqual(fresh.status);
    expect(registry.fetchLatestVersion).not.toHaveBeenCalled();
  });

  it("bypasses fresh cache when preferCache=false (always live HTTP)", async () => {
    const fresh: CacheEntry = {
      status: { kind: "up-to-date", current: "1.0.0" },
      fetchedAt: NOW - 1000,
      ttlMs: 86_400_000,
    };
    const registry = mockRegistry("1.5.0");
    const svc = new UpdateCheckService(mockSource("1.0.0"), registry, mockCache(fresh), () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: false });
    expect(status.kind).toBe("available");
    expect(registry.fetchLatestVersion).toHaveBeenCalled();
  });

  it("re-fetches when cache is stale (past TTL)", async () => {
    const stale: CacheEntry = {
      status: { kind: "up-to-date", current: "1.0.0" },
      fetchedAt: NOW - 100_000_000,
      ttlMs: 86_400_000,
    };
    const registry = mockRegistry("1.5.0");
    const svc = new UpdateCheckService(mockSource("1.0.0"), registry, mockCache(stale), () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: true });
    expect(status.kind).toBe("available");
    expect(registry.fetchLatestVersion).toHaveBeenCalled();
  });

  it("returns unavailable('cache-miss') when allowNetwork=false and no fresh cache", async () => {
    const svc = new UpdateCheckService(mockSource("1.0.0"), mockRegistry("1.1.0"), mockCache(), () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: false, preferCache: true });
    expect(status).toEqual<UpdateStatus>({ kind: "unavailable", reason: "cache-miss" });
  });

  it("passes timeoutMs to the registry client", async () => {
    const registry = mockRegistry("1.0.0");
    const svc = new UpdateCheckService(mockSource("1.0.0"), registry, mockCache(), () => NOW);
    await svc.checkForUpdate({ allowNetwork: true, preferCache: false, timeoutMs: 1500 });
    expect(registry.fetchLatestVersion).toHaveBeenCalledWith("tea-rags", { timeoutMs: 1500 });
  });
});

describe("UpdateCheckService.checkForUpdate — fresh cache vs installed version", () => {
  const CACHED_AT = NOW - 60_000;
  // Deliberately not the 24h default: a re-derivation that rebuilt the entry
  // through the network path's TTL policy would be caught by this value.
  const CACHED_TTL = 3_600_000;

  it("returns a fresh unavailable status as-is (it carries no current version)", async () => {
    const entry: CacheEntry = {
      status: { kind: "unavailable", reason: "network" },
      fetchedAt: CACHED_AT,
      ttlMs: CACHED_TTL,
    };
    const registry = mockRegistry("1.41.0");
    const cache = mockCache(entry);
    const svc = new UpdateCheckService(mockSource("1.41.0"), registry, cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: true });
    expect(status).toEqual<UpdateStatus>({ kind: "unavailable", reason: "network" });
    expect(registry.fetchLatestVersion).not.toHaveBeenCalled();
    expect(cache.writes).toHaveLength(0);
  });

  it("returns the cached status untouched when its current matches the installed version", async () => {
    const entry: CacheEntry = {
      status: { kind: "up-to-date", current: "1.41.0" },
      fetchedAt: CACHED_AT,
      ttlMs: CACHED_TTL,
    };
    const registry = mockRegistry("1.42.0");
    const cache = mockCache(entry);
    const svc = new UpdateCheckService(mockSource("1.41.0"), registry, cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: true });
    expect(status).toEqual(entry.status);
    expect(registry.fetchLatestVersion).not.toHaveBeenCalled();
    expect(cache.writes).toHaveLength(0);
  });

  it("re-derives up-to-date without network when the install caught up with the cached latest", async () => {
    const entry: CacheEntry = {
      status: {
        kind: "available",
        current: "1.40.0",
        latest: "1.41.0",
        changelogUrl: "https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.41.0",
      },
      fetchedAt: CACHED_AT,
      ttlMs: CACHED_TTL,
    };
    const registry = mockRegistry("9.9.9");
    const cache = mockCache(entry);
    const svc = new UpdateCheckService(mockSource("1.41.0"), registry, cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: true });
    expect(status).toEqual<UpdateStatus>({ kind: "up-to-date", current: "1.41.0" });
    expect(registry.fetchLatestVersion).not.toHaveBeenCalled();
    expect(cache.writes).toEqual<CacheEntry[]>([
      { status: { kind: "up-to-date", current: "1.41.0" }, fetchedAt: CACHED_AT, ttlMs: CACHED_TTL },
    ]);
  });

  it("re-derives available against the installed version, keeping the cached latest, even offline", async () => {
    const entry: CacheEntry = {
      status: {
        kind: "available",
        current: "1.40.0",
        latest: "1.41.0",
        changelogUrl: "https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.41.0",
      },
      fetchedAt: CACHED_AT,
      ttlMs: CACHED_TTL,
    };
    const registry = mockRegistry("9.9.9");
    const cache = mockCache(entry);
    const svc = new UpdateCheckService(mockSource("1.40.5"), registry, cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: false, preferCache: true });
    const rederived: UpdateStatus = {
      kind: "available",
      current: "1.40.5",
      latest: "1.41.0",
      changelogUrl: "https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.41.0",
    };
    expect(status).toEqual(rederived);
    expect(registry.fetchLatestVersion).not.toHaveBeenCalled();
    expect(cache.writes).toEqual<CacheEntry[]>([{ status: rederived, fetchedAt: CACHED_AT, ttlMs: CACHED_TTL }]);
  });

  it("treats a fresh up-to-date entry for another version as a cache miss when offline", async () => {
    const entry: CacheEntry = {
      status: { kind: "up-to-date", current: "1.40.0" },
      fetchedAt: CACHED_AT,
      ttlMs: CACHED_TTL,
    };
    const registry = mockRegistry("1.42.0");
    const cache = mockCache(entry);
    const svc = new UpdateCheckService(mockSource("1.41.0"), registry, cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: false, preferCache: true });
    expect(status).toEqual<UpdateStatus>({ kind: "unavailable", reason: "cache-miss" });
    expect(registry.fetchLatestVersion).not.toHaveBeenCalled();
    expect(cache.writes).toHaveLength(0);
  });

  it("treats a fresh up-to-date entry for another version as a cache miss and fetches when online", async () => {
    const entry: CacheEntry = {
      status: { kind: "up-to-date", current: "1.40.0" },
      fetchedAt: CACHED_AT,
      ttlMs: CACHED_TTL,
    };
    const registry = mockRegistry("1.42.0");
    const cache = mockCache(entry);
    const svc = new UpdateCheckService(mockSource("1.41.0"), registry, cache, () => NOW);
    const status = await svc.checkForUpdate({ allowNetwork: true, preferCache: true });
    const fetched: UpdateStatus = {
      kind: "available",
      current: "1.41.0",
      latest: "1.42.0",
      changelogUrl: "https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.42.0",
    };
    expect(status).toEqual(fetched);
    expect(registry.fetchLatestVersion).toHaveBeenCalled();
    expect(cache.writes).toEqual<CacheEntry[]>([{ status: fetched, fetchedAt: NOW, ttlMs: 86_400_000 }]);
  });
});
