import * as nodeFs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { VcsAdapterFactory } from "../../../../../src/core/adapters/vcs/factory.js";
import {
  blameFile,
  createCatFileBatchCheck,
  getHead,
} from "../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import { buildChunkChurnMap } from "../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import { ChunkChurnWalkPool } from "../../../../../src/core/domains/trajectory/git/infra/churn-walk/walk-pool.js";
import { GitCommitDiscovery } from "../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";
import {
  buildFileSignalDiscovery,
  buildFileSignalMap,
  buildFileSignalsForPaths,
} from "../../../../../src/core/domains/trajectory/git/infra/file-reader.js";
import { GitEnrichmentProvider } from "../../../../../src/core/domains/trajectory/git/provider.js";

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("../../../../../src/core/adapters/vcs/git/git-cli/client.js", () => ({
  resolveRepoRoot: vi.fn((p: string) => p),
  blameFile: vi.fn().mockResolvedValue([]),
  writeCommitGraph: vi.fn().mockResolvedValue(undefined),
  getHead: vi.fn().mockResolvedValue("headsha"),
  // Default: a fresh working reader so the resolveHeadOids success path runs
  // (existing tests only care that blame still runs for every file — see
  // populateBlameMap's oid-miss fallback). Individual tests below override
  // per-call behavior via mockReturnValueOnce for the OID-reader lifecycle.
  createCatFileBatchCheck: vi.fn(() => ({
    check: vi.fn().mockResolvedValue(null),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../../../../../src/core/domains/trajectory/git/infra/file-reader.js", () => ({
  buildFileSignalMap: vi.fn().mockResolvedValue(new Map()),
  buildFileSignalsForPaths: vi.fn().mockResolvedValue(new Map()),
  buildFileSignalDiscovery: vi.fn().mockResolvedValue(new Map()),
  // Real slicing so streamFileBatch tests exercise the actual pick-by-path
  // behavior (the pure function is separately unit-tested in file-discovery.test.ts).
  sliceFileSignalsByPaths: vi.fn((discovery: Map<string, unknown>, paths: string[]) => {
    const out = new Map<string, unknown>();
    for (const p of paths) {
      const e = discovery.get(p);
      if (e) out.set(p, e);
    }
    return out;
  }),
}));

vi.mock("../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js", () => ({
  buildChunkChurnMap: vi.fn().mockResolvedValue(new Map()),
}));

// The FILE-phase blame pool (bd tea-rags-mcp-dog1v). Mocked so unit tests never
// spawn worker_threads: the spy DELEGATES to the same git-cli `blameFile` mock
// the inline path used, so every existing blame assertion holds unchanged — the
// pool is just the new transport for shallow-history files.
const { blamePoolBlame } = vi.hoisted(() => ({ blamePoolBlame: vi.fn() }));
vi.mock("../../../../../src/core/domains/trajectory/git/infra/churn-walk/blame-pool.js", () => ({
  // Regular function (not arrow) so `new BlameWorkerPool(size)` works — the
  // returned object is the instance; `blame` is the shared, delegating spy.
  BlameWorkerPool: vi.fn(function () {
    return { blame: blamePoolBlame, close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

describe("GitEnrichmentProvider", () => {
  let provider: GitEnrichmentProvider;

  beforeEach(() => {
    provider = new GitEnrichmentProvider();
    vi.mocked(nodeFs.existsSync).mockReturnValue(false);
    // Delegate the pool to the git-cli `blameFile` mock (root, relPath, timeoutMs)
    // so shallow-file blame is driven by each test's blameFile mock, exactly as
    // the inline path was — existing assertions on blameFile stay valid.
    blamePoolBlame.mockReset();
    blamePoolBlame.mockImplementation(
      async (root: string, _kind: string, files: { relPath: string }[], timeoutMs: number) => {
        const map = new Map<string, unknown>();
        for (const { relPath } of files) map.set(relPath, await blameFile(root, relPath, timeoutMs));
        return map;
      },
    );
  });

  it("has key 'git'", () => {
    expect(provider.key).toBe("git");
  });

  it("implements EnrichmentProvider interface", () => {
    expect(typeof provider.buildFileSignals).toBe("function");
    expect(typeof provider.buildChunkSignals).toBe("function");
    expect(typeof provider.resolveRoot).toBe("function");
  });

  it("has fileSignalTransform that calls computeFileSignals", () => {
    expect(typeof provider.fileSignalTransform).toBe("function");
    // Call with minimal FileChurnData shape to exercise the arrow function
    const result = provider.fileSignalTransform({ commits: [], recentAuthors: [] } as any, 10);
    expect(result).toBeDefined();
  });

  describe("buildFileSignals", () => {
    it("returns empty map when .git directory does not exist", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(false);
      const result = await provider.buildFileSignals("/no-git-repo");
      expect(result).toEqual(new Map());
      expect(buildFileSignalMap).not.toHaveBeenCalled();
    });

    it("calls buildFileSignalMap when .git exists (no options.paths)", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      const fakeData = new Map([["src/a.ts", { commits: [], recentAuthors: [] }]]);
      vi.mocked(buildFileSignalMap).mockResolvedValue(fakeData as any);

      const result = await provider.buildFileSignals("/repo");

      expect(buildFileSignalMap).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: "/repo" }),
        expect.anything(),
        12,
        60000,
      );
      expect(result.size).toBe(1);
      expect(result.has("src/a.ts")).toBe(true);
    });

    it("calls buildFileSignalsForPaths when options.paths is provided", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      const fakeData = new Map([["src/b.ts", { commits: [], recentAuthors: [] }]]);
      vi.mocked(buildFileSignalsForPaths).mockResolvedValue(fakeData as any);

      const result = await provider.buildFileSignals("/repo", { paths: ["src/b.ts"] });

      expect(buildFileSignalsForPaths).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: "/repo" }),
        ["src/b.ts"],
        60000,
      );
      expect(result.size).toBe(1);
      expect(result.has("src/b.ts")).toBe(true);
    });

    it("accumulates blameByRelPath across batched buildFileSignals calls", async () => {
      // Regression: the initial pass populates blame for files A,B; a later
      // backfill pass for file C must NOT erase blame for A,B — chunk-level
      // signals are produced AFTER all blame passes via buildChunkChurnMap,
      // and a missing entry in blameByRelPath produces "unknown" ownership.
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      const blameLineA = { lineNumber: 1, sha: "shaA", author: "Alice", authorEmail: "a@x", timestamp: 0 };
      const blameLineB = { lineNumber: 1, sha: "shaB", author: "Bob", authorEmail: "b@x", timestamp: 0 };
      const blameLineC = { lineNumber: 1, sha: "shaC", author: "Carol", authorEmail: "c@x", timestamp: 0 };
      vi.mocked(blameFile).mockImplementation(async (_root, relPath) => {
        if (relPath === "src/a.ts") return [blameLineA];
        if (relPath === "src/b.ts") return [blameLineB];
        if (relPath === "src/c.ts") return [blameLineC];
        return [];
      });

      const dataAB = new Map([
        ["src/a.ts", { commits: [], recentAuthors: [] }],
        ["src/b.ts", { commits: [], recentAuthors: [] }],
      ]);
      vi.mocked(buildFileSignalsForPaths).mockResolvedValueOnce(dataAB as any);
      await provider.buildFileSignals("/repo", { paths: ["src/a.ts", "src/b.ts"] });

      const dataC = new Map([["src/c.ts", { commits: [], recentAuthors: [] }]]);
      vi.mocked(buildFileSignalsForPaths).mockResolvedValueOnce(dataC as any);
      await provider.buildFileSignals("/repo", { paths: ["src/c.ts"] });

      const chunkMap = new Map([
        ["src/a.ts", [{ chunkId: "ca", startLine: 1, endLine: 5 }]],
        ["src/b.ts", [{ chunkId: "cb", startLine: 1, endLine: 5 }]],
        ["src/c.ts", [{ chunkId: "cc", startLine: 1, endLine: 5 }]],
      ]);
      await provider.buildChunkSignals("/repo", chunkMap as any);

      const lastCall = vi.mocked(buildChunkChurnMap).mock.calls.at(-1);
      const blameByPathArg = lastCall?.[12] as Map<string, unknown>;
      expect(blameByPathArg).toBeInstanceOf(Map);
      expect(blameByPathArg.get("src/a.ts")).toEqual([blameLineA]);
      expect(blameByPathArg.get("src/b.ts")).toEqual([blameLineB]);
      expect(blameByPathArg.get("src/c.ts")).toEqual([blameLineC]);
    });

    it("routes ALL cache-miss files to the off-main-thread blame pool", async () => {
      // bd tea-rags-mcp-dog1v: blame is now native `git blame` (async child
      // process) for every file — the depth partition was dropped (es-git
      // in-process blame was a 60x loss). All misses fan out across the pool.
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      const shallow = { commits: Array.from({ length: 3 }, (_, i) => ({ hash: `s${i}` })), recentAuthors: [] };
      const deep = { commits: Array.from({ length: 40 }, (_, i) => ({ hash: `d${i}` })), recentAuthors: [] };
      vi.mocked(buildFileSignalMap).mockResolvedValue(
        new Map([
          ["shallow.ts", shallow],
          ["deep.ts", deep],
        ]) as any,
      );

      await provider.buildFileSignals("/repo");

      expect(blamePoolBlame).toHaveBeenCalledTimes(1);
      const poolFiles = blamePoolBlame.mock.calls[0][2] as { relPath: string }[];
      expect(poolFiles.map((f) => f.relPath).sort()).toEqual(["deep.ts", "shallow.ts"]);
    });

    it("releases blameByRelPath after chunk enrichment (bounded retention)", async () => {
      // blameByRelPath must persist ACROSS file passes (test above) so chunk
      // enrichment sees every file's blame. But once buildChunkSignals (the last
      // reader) has run, holding every file's BlameLine[] for the daemon's
      // lifetime is a leak — it must be released. Repopulated by the next run's
      // file passes.
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      vi.mocked(blameFile).mockResolvedValue([
        { lineNumber: 1, sha: "shaA", author: "Alice", authorEmail: "a@x", timestamp: 0 },
      ]);
      vi.mocked(buildFileSignalsForPaths).mockResolvedValueOnce(
        new Map([["src/a.ts", { commits: [], recentAuthors: [] }]]) as never,
      );
      await provider.buildFileSignals("/repo", { paths: ["src/a.ts"] });

      const read = (): Map<string, unknown> =>
        (provider as unknown as { blameByRelPath: Map<string, unknown> }).blameByRelPath;
      expect(read().size).toBeGreaterThan(0); // populated by the file pass

      vi.mocked(buildChunkChurnMap).mockResolvedValue(new Map());
      await provider.buildChunkSignals(
        "/repo",
        new Map([["src/a.ts", [{ chunkId: "ca", startLine: 1, endLine: 5 }]]]) as never,
      );

      // Re-read: buildChunkSignals swaps in a fresh empty map (the consumed one
      // is released for GC), so the live field holds nothing afterwards.
      expect(read().size).toBe(0);
    });

    it("stores raw data for later chunk enrichment correlation", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      const fakeData = new Map([["src/a.ts", { commits: [{ hash: "abc" }], recentAuthors: ["dev"] }]]);
      vi.mocked(buildFileSignalMap).mockResolvedValue(fakeData as any);

      await provider.buildFileSignals("/repo");
      // After buildFileSignals, lastFileResult is cached internally
      // — confirmed by the fact that buildChunkSignals uses it
      const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
      await provider.buildChunkSignals("/repo", chunkMap as any);

      expect(buildChunkChurnMap).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: "/repo" }),
        chunkMap,
        expect.anything(), // enrichmentCache
        expect.anything(), // isoGitCache
        10, // concurrency (default)
        6, // maxAgeMonths (default)
        fakeData, // lastFileResult passed through
        undefined, // squashOpts
        120000, // chunkTimeoutMs (default)
        10000, // chunkMaxFileLines (default)
        undefined, // externalSemaphore (not passed when no options)
        undefined, // skipCache (not passed when no options)
        expect.any(Map), // blameByPath populated by populateBlameMap
        undefined, // blobReader (kc93 — not passed when no options.blobReader)
        undefined, // diffMemo (7gnre — not passed when no options.diffMemo)
        undefined, // commitDiscovery (82va1 — not passed when no options.commitDiscovery)
        undefined, // onWalkStats (iqpuu — not passed when no options.onWalkStats)
      );
    });
  });

  describe("streamFileBatch + finalizeSignals", () => {
    it("streamFileBatch slices the run-scoped discovery for the batch (not a per-path log)", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      // This file has no per-test mock reset; scope call history to this test.
      vi.mocked(buildFileSignalDiscovery).mockClear();
      vi.mocked(buildFileSignalsForPaths).mockClear();
      const discovery = new Map([
        ["src/b.ts", { commits: [], recentAuthors: [] }],
        ["src/other.ts", { commits: [], recentAuthors: [] }],
      ]);
      vi.mocked(buildFileSignalDiscovery).mockResolvedValue(discovery as never);

      const result = await provider.streamFileBatch("/repo", ["src/b.ts"]);

      // ONE repo-wide discovery, sliced in memory — the per-path pathspec log is
      // no longer spawned on the streaming path (bd tea-rags-mcp-j4lm9).
      expect(buildFileSignalDiscovery).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: "/repo" }), 60000, 12);
      expect(buildFileSignalsForPaths).not.toHaveBeenCalled();
      expect(result.has("src/b.ts")).toBe(true);
      expect(result.has("src/other.ts")).toBe(false);
    });

    it("builds the discovery ONCE across batches within a run (run-scoped, HEAD-keyed)", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      vi.mocked(buildFileSignalDiscovery).mockClear();
      vi.mocked(buildFileSignalDiscovery).mockResolvedValue(
        new Map([
          ["src/a.ts", { commits: [], recentAuthors: [] }],
          ["src/b.ts", { commits: [], recentAuthors: [] }],
        ]) as never,
      );

      await provider.streamFileBatch("/repo", ["src/a.ts"]);
      await provider.streamFileBatch("/repo", ["src/b.ts"]);

      expect(buildFileSignalDiscovery).toHaveBeenCalledTimes(1);
    });

    it("finalizeSignals drops the run discovery so the next run rebuilds it", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      vi.mocked(buildFileSignalDiscovery).mockClear();
      vi.mocked(buildFileSignalDiscovery).mockResolvedValue(
        new Map([["src/a.ts", { commits: [], recentAuthors: [] }]]) as never,
      );

      await provider.streamFileBatch("/repo", ["src/a.ts"]);
      await provider.finalizeSignals("/repo");
      await provider.streamFileBatch("/repo", ["src/a.ts"]);

      // Dropped at finalize ⇒ the second run rebuilds (no cross-run leak).
      expect(buildFileSignalDiscovery).toHaveBeenCalledTimes(2);
    });

    it("finalizeSignals returns an empty file map (git streams everything)", async () => {
      const f = await provider.finalizeSignals("/repo");
      expect(f).toBeInstanceOf(Map);
      expect(f.size).toBe(0);
    });
  });

  describe("buildChunkSignals", () => {
    it("maps chunk churn result to the expected nested Map structure", async () => {
      const fakeOverlay = new Map([["c1", { commitCount: 5 }]]);
      const fakeResult = new Map([["src/a.ts", fakeOverlay]]);
      vi.mocked(buildChunkChurnMap).mockResolvedValue(fakeResult as any);

      const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
      const result = await provider.buildChunkSignals("/repo", chunkMap as any);

      expect(result.size).toBe(1);
      expect(result.has("src/a.ts")).toBe(true);
      const innerMap = result.get("src/a.ts")!;
      expect(innerMap.size).toBe(1);
      expect(innerMap.get("c1")).toEqual({ commitCount: 5 });
    });

    it("returns empty map when no chunks have churn data", async () => {
      vi.mocked(buildChunkChurnMap).mockResolvedValue(new Map());

      const result = await provider.buildChunkSignals("/repo", new Map() as any);
      expect(result.size).toBe(0);
    });
  });

  describe("resolveRoot", () => {
    it("delegates to resolveRepoRoot", () => {
      const root = provider.resolveRoot("/some/path");
      expect(root).toBe("/some/path");
    });
  });

  describe("shouldEnrich", () => {
    const base = { isSource: true, isGenerated: false, isDocumentation: false, isTest: false };

    it("skips everything for generated files", () => {
      expect(
        provider.shouldEnrich({
          relPath: "db/schema.rb",
          classification: { ...base, isSource: false, isGenerated: true },
        }),
      ).toBe("none");
    });

    it("keeps file-level but skips chunk-churn for documentation", () => {
      expect(
        provider.shouldEnrich({
          relPath: "README.md",
          classification: { ...base, isSource: false, isDocumentation: true },
        }),
      ).toBe("file-only");
    });

    it("fully enriches ordinary source, including tests", () => {
      expect(provider.shouldEnrich({ relPath: "app/models/user.rb", classification: base })).toBe("full");
      expect(provider.shouldEnrich({ relPath: "spec/user_spec.rb", classification: { ...base, isTest: true } })).toBe(
        "full",
      );
    });
  });

  describe("streamFileBatch — no-git guard", () => {
    it("returns an empty map without touching the run-scoped discovery when .git is absent", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(false);
      vi.mocked(buildFileSignalDiscovery).mockClear();

      const result = await provider.streamFileBatch("/no-git-repo", ["src/a.ts"]);

      expect(result).toEqual(new Map());
      expect(buildFileSignalDiscovery).not.toHaveBeenCalled();
    });
  });

  describe("streamFileBatch — HEAD resolution failure", () => {
    it("falls back to an empty HEAD sha when getHead rejects, still slicing the batch", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      vi.mocked(buildFileSignalDiscovery).mockClear();
      vi.mocked(getHead).mockRejectedValueOnce(new Error("no HEAD (empty repo)"));
      vi.mocked(buildFileSignalDiscovery).mockResolvedValueOnce(
        new Map([["src/a.ts", { commits: [], recentAuthors: [] }]]) as never,
      );

      const result = await provider.streamFileBatch("/repo", ["src/a.ts"]);

      // HEAD lookup failure degrades to "" as the cache key — the batch still
      // resolves normally instead of throwing (getRunDiscovery's catch fallback).
      expect(buildFileSignalDiscovery).toHaveBeenCalledTimes(1);
      expect(result.has("src/a.ts")).toBe(true);
    });
  });

  describe("OID reader lifecycle (resolveHeadOids / finalizeSignals)", () => {
    it("closes the stale cat-file reader when the repo root changes, and again at finalizeSignals", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      const readerA = {
        check: vi.fn().mockResolvedValue(null),
        close: vi.fn().mockRejectedValue(new Error("closeA failed")),
      };
      const readerB = {
        check: vi.fn().mockResolvedValue(null),
        close: vi.fn().mockRejectedValue(new Error("closeB failed")),
      };
      vi.mocked(createCatFileBatchCheck)
        .mockReturnValueOnce(readerA as any)
        .mockReturnValueOnce(readerB as any);

      vi.mocked(buildFileSignalsForPaths).mockResolvedValueOnce(
        new Map([["src/a.ts", { commits: [], recentAuthors: [] }]]) as never,
      );
      await provider.buildFileSignals("/repo-1", { paths: ["src/a.ts"] });
      // First root: no prior reader exists yet, so there is nothing to close.
      expect(readerA.close).not.toHaveBeenCalled();

      vi.mocked(buildFileSignalsForPaths).mockResolvedValueOnce(
        new Map([["src/b.ts", { commits: [], recentAuthors: [] }]]) as never,
      );
      await provider.buildFileSignals("/repo-2", { paths: ["src/b.ts"] });
      // Root switch closes the stale reader bound to the old root — the
      // rejection is swallowed, never propagates.
      expect(readerA.close).toHaveBeenCalledTimes(1);

      await expect(provider.finalizeSignals("/repo-2")).resolves.toBeInstanceOf(Map);
      expect(readerB.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("run-scoped chunk-churn infra factories", () => {
    it("createCommitDiscovery builds a GitCommitDiscovery bound to the provider's chunk-window config", () => {
      const discovery = provider.createCommitDiscovery("/repo");
      expect(discovery).toBeInstanceOf(GitCommitDiscovery);
    });

    it("createChunkChurnWalkThread builds a fresh worker-pool host per call", () => {
      const threadA = provider.createChunkChurnWalkThread();
      const threadB = provider.createChunkChurnWalkThread();
      expect(threadA).toBeInstanceOf(ChunkChurnWalkPool);
      expect(threadB).toBeInstanceOf(ChunkChurnWalkPool);
      expect(threadA).not.toBe(threadB);
    });
  });

  describe("vcs adapter DI — lazy per-root creation (w2dlu T6)", () => {
    it("creates the vcs adapter lazily via the factory, once per root (cached for the run)", async () => {
      const createSpy = vi.spyOn(VcsAdapterFactory, "create");
      try {
        vi.mocked(nodeFs.existsSync).mockReturnValue(true);
        vi.mocked(buildFileSignalsForPaths).mockResolvedValue(new Map() as never);

        await provider.buildFileSignals("/repo", { paths: ["src/a.ts"] });
        await provider.buildFileSignals("/repo", { paths: ["src/b.ts"] });
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(createSpy).toHaveBeenCalledWith("git", "/repo");

        await provider.buildFileSignals("/repo-2", { paths: ["src/c.ts"] });
        expect(createSpy).toHaveBeenCalledTimes(2);
        expect(createSpy).toHaveBeenLastCalledWith("git", "/repo-2");
      } finally {
        createSpy.mockRestore();
      }
    });

    it("passes the configured adapter kind through to the factory", async () => {
      const createSpy = vi.spyOn(VcsAdapterFactory, "create");
      try {
        vi.mocked(nodeFs.existsSync).mockReturnValue(true);
        vi.mocked(buildFileSignalsForPaths).mockResolvedValue(new Map() as never);
        const esProvider = new GitEnrichmentProvider({ vcsAdapter: "es-git" });
        // The es-git branch fail-louds until T9 — resolve with a stub so the
        // kind-threading assertion is observable without the real binding.
        createSpy.mockResolvedValue({ repoRoot: "/repo" } as never);

        await esProvider.buildFileSignals("/repo", { paths: [] });

        expect(createSpy).toHaveBeenCalledWith("es-git", "/repo");
      } finally {
        createSpy.mockRestore();
      }
    });

    it("finalizeSignals drops the per-root adapter cache (next run re-creates)", async () => {
      const createSpy = vi.spyOn(VcsAdapterFactory, "create");
      try {
        vi.mocked(nodeFs.existsSync).mockReturnValue(true);
        vi.mocked(buildFileSignalsForPaths).mockResolvedValue(new Map() as never);

        await provider.buildFileSignals("/repo", { paths: [] });
        await provider.finalizeSignals();
        await provider.buildFileSignals("/repo", { paths: [] });

        expect(createSpy).toHaveBeenCalledTimes(2);
      } finally {
        createSpy.mockRestore();
      }
    });

    it("ships the vcs adapter kind in the off-thread walk job (structured-clone-safe literal)", async () => {
      const discovery = {
        commitsForFiles: vi.fn().mockResolvedValue([]),
        getBugFixShas: vi.fn().mockResolvedValue(new Set<string>()),
      };
      const walkThread = { walk: vi.fn().mockResolvedValue({ overlays: new Map(), stats: {} }) };
      const chunkMap = new Map([["/repo/src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 5 }]]]);

      await provider.buildChunkSignals(
        "/repo",
        chunkMap as never,
        {
          churnWalkThread: walkThread,
          commitDiscovery: discovery,
          skipCache: true,
        } as never,
      );

      expect(walkThread.walk).toHaveBeenCalledWith(expect.objectContaining({ gitAdapter: "git" }));
    });
  });

  describe("populateBlameMap — empty batch", () => {
    it("skips the blame pass entirely when the batch's raw file-churn data is empty", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      vi.mocked(blameFile).mockClear();
      vi.mocked(buildFileSignalsForPaths).mockResolvedValueOnce(new Map());

      const result = await provider.buildFileSignals("/repo", { paths: [] });

      expect(result.size).toBe(0);
      expect(blameFile).not.toHaveBeenCalled();
    });
  });

  describe("resolveHeadOids — reader failure", () => {
    it("degrades to blame-everything when the persistent cat-file reader throws", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      const brokenReader = {
        check: vi.fn().mockRejectedValue(new Error("cat-file batch-check crashed")),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.mocked(createCatFileBatchCheck).mockReturnValueOnce(brokenReader as any);
      vi.mocked(buildFileSignalsForPaths).mockResolvedValueOnce(
        new Map([["src/a.ts", { commits: [], recentAuthors: [] }]]) as never,
      );

      // resolveHeadOids' outer catch must degrade to an empty OID map (every
      // file becomes a cache miss) rather than throwing out of buildFileSignals.
      const result = await provider.buildFileSignals("/repo-oid-fail", { paths: ["src/a.ts"] });

      expect(result.has("src/a.ts")).toBe(true);
      expect(blameFile).toHaveBeenCalledWith("/repo-oid-fail", "src/a.ts", expect.anything());
    });
  });

  describe("buildChunkSignals — off-thread walk (bd tea-rags-mcp-iqpuu)", () => {
    it("returns an empty map immediately when the batch has no relativizable chunk paths", async () => {
      const discovery = { commitsForFiles: vi.fn(), getBugFixShas: vi.fn() };
      const walkThread = { walk: vi.fn() };

      const result = await provider.buildChunkSignals("/repo", new Map(), {
        churnWalkThread: walkThread,
        commitDiscovery: discovery,
        skipCache: true,
      } as any);

      expect(result.size).toBe(0);
      expect(discovery.commitsForFiles).not.toHaveBeenCalled();
      expect(walkThread.walk).not.toHaveBeenCalled();
    });

    it("degrades to zero churn for the batch when the discovery slice fails, without throwing", async () => {
      const discovery = {
        commitsForFiles: vi.fn().mockRejectedValue(new Error("discovery slice failed")),
        getBugFixShas: vi.fn().mockRejectedValue(new Error("bugfix set unavailable")),
      };
      const walkThread = {
        walk: vi.fn().mockResolvedValue({ overlays: new Map(), stats: {} }),
      };
      const chunkMap = new Map([["/repo/src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 5 }]]]);

      const result = await provider.buildChunkSignals(
        "/repo",
        chunkMap as any,
        {
          churnWalkThread: walkThread,
          commitDiscovery: discovery,
          skipCache: true,
        } as any,
      );

      // Both the commit-discovery slice AND the bug-fix-sha lookup fail — the
      // walk must still run (with empty commitEntries/bugFixShas) instead of
      // the batch throwing an enrichment error.
      expect(result).toBeInstanceOf(Map);
      expect(walkThread.walk).toHaveBeenCalledWith(
        expect.objectContaining({ commitEntries: [], bugFixShas: new Set() }),
      );
    });
  });
});
