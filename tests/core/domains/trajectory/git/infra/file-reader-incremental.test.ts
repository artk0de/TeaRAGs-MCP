/**
 * `file-reader.ts` consuming `FileChurnDiscovery` (bd tea-rags-mcp Task 3).
 *
 * `buildFileSignalMap` / `buildFileSignalDiscovery` accept an OPTIONAL
 * `discovery?: FileChurnDiscovery` as their last param. When supplied, the
 * function returns `discovery.fileChurn()`'s aggregate directly and never
 * spawns the adapter's own `readNumstatLog` git walk (the discovery's
 * incremental store IS the cache — the HEAD-keyed `enrichmentCache` round-trip
 * in `buildFileSignalMap` is skipped too). When absent, both functions keep
 * their EXISTING `readNumstatLog` body byte-for-byte (backward compat).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VcsGitAdapter } from "../../../../../../src/core/adapters/vcs/git/adapter.js";
import type { FileChurnData } from "../../../../../../src/core/adapters/vcs/types.js";
import { GitEnrichmentCache } from "../../../../../../src/core/domains/trajectory/git/infra/cache.js";
import { FileChurnDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery.js";
import {
  buildFileSignalDiscovery,
  buildFileSignalMap,
} from "../../../../../../src/core/domains/trajectory/git/infra/file-reader.js";

interface FakeAdapter {
  repoRoot: string;
  getHead: ReturnType<typeof vi.fn>;
  readNumstatLog: ReturnType<typeof vi.fn>;
}

function fakeFileReaderAdapter(readNumstatResult: Map<string, FileChurnData> = new Map()): FakeAdapter {
  return {
    repoRoot: "/repo",
    getHead: vi.fn().mockResolvedValue("h".repeat(40)),
    readNumstatLog: vi.fn().mockResolvedValue(readNumstatResult),
  };
}

function asAdapter(fake: FakeAdapter): VcsGitAdapter {
  return fake as unknown as VcsGitAdapter;
}

/** Minimal discovery-internal adapter — its own resolveEntries never runs
 *  because `fileChurn` is stubbed directly (only the shape needs to typecheck). */
function fakeDiscoveryAdapter(): VcsGitAdapter {
  return {
    repoRoot: "/repo",
    getHead: vi.fn().mockResolvedValue("h".repeat(40)),
    isAncestor: vi.fn().mockResolvedValue(false),
    readCommitFileNumstat: vi.fn().mockResolvedValue([]),
  } as unknown as VcsGitAdapter;
}

function stubbedDiscovery(result: Map<string, FileChurnData>): FileChurnDiscovery {
  const discovery = new FileChurnDiscovery(fakeDiscoveryAdapter(), { maxAgeMonths: 12, timeoutMs: 30000 });
  vi.spyOn(discovery, "fileChurn").mockResolvedValue(result);
  return discovery;
}

describe("buildFileSignalMap — discovery routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns discovery.fileChurn() and never calls adapter.readNumstatLog when discovery is supplied", async () => {
    const known = new Map<string, FileChurnData>([["a.ts", { commits: [], linesAdded: 3, linesDeleted: 1 }]]);
    const discovery = stubbedDiscovery(known);
    const adapter = fakeFileReaderAdapter();
    const cache = new GitEnrichmentCache();

    const result = await buildFileSignalMap(asAdapter(adapter), cache, 12, 60000, discovery);

    expect(result).toBe(known);
    expect(discovery.fileChurn).toHaveBeenCalledTimes(1);
    expect(adapter.readNumstatLog).not.toHaveBeenCalled();
  });

  it("still calls adapter.readNumstatLog when discovery is absent (unchanged path)", async () => {
    const legacy = new Map<string, FileChurnData>([["b.ts", { commits: [], linesAdded: 0, linesDeleted: 0 }]]);
    const adapter = fakeFileReaderAdapter(legacy);
    const cache = new GitEnrichmentCache();

    const result = await buildFileSignalMap(asAdapter(adapter), cache, 12, 60000);

    expect(adapter.readNumstatLog).toHaveBeenCalledTimes(1);
    expect(result).toBe(legacy);
  });
});

describe("buildFileSignalDiscovery — discovery routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns discovery.fileChurn() and never calls adapter.readNumstatLog when discovery is supplied", async () => {
    const known = new Map<string, FileChurnData>([["c.ts", { commits: [], linesAdded: 5, linesDeleted: 2 }]]);
    const discovery = stubbedDiscovery(known);
    const adapter = fakeFileReaderAdapter();

    const result = await buildFileSignalDiscovery(asAdapter(adapter), 60000, 0, discovery);

    expect(result).toBe(known);
    expect(discovery.fileChurn).toHaveBeenCalledTimes(1);
    expect(adapter.readNumstatLog).not.toHaveBeenCalled();
  });

  it("still calls adapter.readNumstatLog when discovery is absent (unchanged path)", async () => {
    const legacy = new Map<string, FileChurnData>([["d.ts", { commits: [], linesAdded: 1, linesDeleted: 1 }]]);
    const adapter = fakeFileReaderAdapter(legacy);

    const result = await buildFileSignalDiscovery(asAdapter(adapter), 60000, 0);

    expect(adapter.readNumstatLog).toHaveBeenCalledTimes(1);
    expect(result).toBe(legacy);
  });
});
