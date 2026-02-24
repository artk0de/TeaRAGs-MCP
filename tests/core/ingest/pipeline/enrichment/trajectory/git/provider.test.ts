import * as nodeFs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildChunkChurnMap } from "../../../../../../../src/core/ingest/pipeline/enrichment/trajectory/git/chunk-reader.js";
import {
  buildFileMetadataForPaths,
  buildFileMetadataMap,
} from "../../../../../../../src/core/ingest/pipeline/enrichment/trajectory/git/file-reader.js";
import { GitEnrichmentProvider } from "../../../../../../../src/core/ingest/pipeline/enrichment/trajectory/git/provider.js";

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return { ...actual, existsSync: vi.fn() };
});

vi.mock("../../../../../../../src/core/adapters/git/client.js", () => ({
  resolveRepoRoot: vi.fn((p: string) => p),
}));

vi.mock("../../../../../../../src/core/ingest/pipeline/enrichment/trajectory/git/file-reader.js", () => ({
  buildFileMetadataMap: vi.fn().mockResolvedValue(new Map()),
  buildFileMetadataForPaths: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../../../../../../src/core/ingest/pipeline/enrichment/trajectory/git/chunk-reader.js", () => ({
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
    expect(typeof provider.buildFileMetadata).toBe("function");
    expect(typeof provider.buildChunkMetadata).toBe("function");
    expect(typeof provider.resolveRoot).toBe("function");
  });

  it("has fileTransform that calls computeFileMetadata", () => {
    expect(typeof provider.fileTransform).toBe("function");
    // Call with minimal FileChurnData shape to exercise the arrow function
    const result = provider.fileTransform({ commits: [], authors: [] } as any, 10);
    expect(result).toBeDefined();
  });

  describe("buildFileMetadata", () => {
    it("returns empty map when .git directory does not exist", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(false);
      const result = await provider.buildFileMetadata("/no-git-repo");
      expect(result).toEqual(new Map());
      expect(buildFileMetadataMap).not.toHaveBeenCalled();
    });

    it("calls buildFileMetadataMap when .git exists (no options.paths)", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      const fakeData = new Map([["src/a.ts", { commits: [], authors: [] }]]);
      vi.mocked(buildFileMetadataMap).mockResolvedValue(fakeData as any);

      const result = await provider.buildFileMetadata("/repo");

      expect(buildFileMetadataMap).toHaveBeenCalledWith("/repo", expect.anything());
      expect(result.size).toBe(1);
      expect(result.has("src/a.ts")).toBe(true);
    });

    it("calls buildFileMetadataForPaths when options.paths is provided", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      const fakeData = new Map([["src/b.ts", { commits: [], authors: [] }]]);
      vi.mocked(buildFileMetadataForPaths).mockResolvedValue(fakeData as any);

      const result = await provider.buildFileMetadata("/repo", { paths: ["src/b.ts"] });

      expect(buildFileMetadataForPaths).toHaveBeenCalledWith("/repo", ["src/b.ts"]);
      expect(result.size).toBe(1);
      expect(result.has("src/b.ts")).toBe(true);
    });

    it("stores raw data for later chunk enrichment correlation", async () => {
      vi.mocked(nodeFs.existsSync).mockReturnValue(true);
      const fakeData = new Map([["src/a.ts", { commits: [{ hash: "abc" }], authors: ["dev"] }]]);
      vi.mocked(buildFileMetadataMap).mockResolvedValue(fakeData as any);

      await provider.buildFileMetadata("/repo");
      // After buildFileMetadata, lastFileResult is cached internally
      // — confirmed by the fact that buildChunkMetadata uses it
      const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
      await provider.buildChunkMetadata("/repo", chunkMap as any);

      expect(buildChunkChurnMap).toHaveBeenCalledWith(
        "/repo",
        chunkMap,
        expect.anything(), // enrichmentCache
        expect.anything(), // isoGitCache
        expect.any(Number), // concurrency
        expect.any(Number), // maxAgeMonths
        fakeData, // lastFileResult passed through
      );
    });
  });

  describe("buildChunkMetadata", () => {
    it("maps chunk churn result to the expected nested Map structure", async () => {
      const fakeOverlay = new Map([["c1", { commitCount: 5 }]]);
      const fakeResult = new Map([["src/a.ts", fakeOverlay]]);
      vi.mocked(buildChunkChurnMap).mockResolvedValue(fakeResult as any);

      const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
      const result = await provider.buildChunkMetadata("/repo", chunkMap as any);

      expect(result.size).toBe(1);
      expect(result.has("src/a.ts")).toBe(true);
      const innerMap = result.get("src/a.ts")!;
      expect(innerMap.size).toBe(1);
      expect(innerMap.get("c1")).toEqual({ commitCount: 5 });
    });

    it("returns empty map when no chunks have churn data", async () => {
      vi.mocked(buildChunkChurnMap).mockResolvedValue(new Map());

      const result = await provider.buildChunkMetadata("/repo", new Map() as any);
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
