import * as nodeFs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { blameFile } from "../../../../../src/core/adapters/git/client.js";
import { buildChunkChurnMap } from "../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import {
  buildFileSignalMap,
  buildFileSignalsForPaths,
} from "../../../../../src/core/domains/trajectory/git/infra/file-reader.js";
import { GitEnrichmentProvider } from "../../../../../src/core/domains/trajectory/git/provider.js";

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("../../../../../src/core/adapters/git/client.js", () => ({
  resolveRepoRoot: vi.fn((p: string) => p),
  blameFile: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../../../src/core/domains/trajectory/git/infra/file-reader.js", () => ({
  buildFileSignalMap: vi.fn().mockResolvedValue(new Map()),
  buildFileSignalsForPaths: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js", () => ({
  buildChunkChurnMap: vi.fn().mockResolvedValue(new Map()),
}));

describe("GitEnrichmentProvider", () => {
  let provider: GitEnrichmentProvider;

  beforeEach(() => {
    provider = new GitEnrichmentProvider();
    vi.mocked(nodeFs.existsSync).mockReturnValue(false);
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

      expect(buildFileSignalMap).toHaveBeenCalledWith("/repo", expect.anything(), 12, 60000);
      expect(result.size).toBe(1);
      expect(result.has("src/a.ts")).toBe(true);
    });

    it("calls buildFileSignalsForPaths when options.paths is provided", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      const fakeData = new Map([["src/b.ts", { commits: [], recentAuthors: [] }]]);
      vi.mocked(buildFileSignalsForPaths).mockResolvedValue(fakeData as any);

      const result = await provider.buildFileSignals("/repo", { paths: ["src/b.ts"] });

      expect(buildFileSignalsForPaths).toHaveBeenCalledWith("/repo", ["src/b.ts"], 60000);
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
        "/repo",
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
      );
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
});
