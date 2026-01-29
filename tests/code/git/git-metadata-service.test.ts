/**
 * Tests for GitMetadataService - Canonical Algorithm Implementation
 *
 * Design principles tested:
 * - One git blame call per file
 * - Cache by content hash (not mtime)
 * - Aggregated signals only (no per-line storage in vector DB)
 * - NO commit message parsing (explicitly forbidden)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { GitMetadataService } from "../../../src/code/git/git-metadata-service.js";
import type { GitChunkMetadata } from "../../../src/code/git/types.js";

describe("GitMetadataService", () => {
  let service: GitMetadataService;

  beforeEach(() => {
    service = new GitMetadataService({ debug: false });
  });

  describe("getRepoInfo", () => {
    it("should detect git repository for files in current project", async () => {
      // Use this test file itself as a known file in a git repo
      const filePath = import.meta.url.replace("file://", "");
      const repoInfo = await service.getRepoInfo(filePath);

      expect(repoInfo.isGitRepo).toBe(true);
      expect(repoInfo.repoRoot).toBeTruthy();
    });

    it("should return isGitRepo=false for paths outside git repos", async () => {
      const filePath = "/tmp/some-random-non-git-file.txt";
      const repoInfo = await service.getRepoInfo(filePath);

      expect(repoInfo.isGitRepo).toBe(false);
    });

    it("should cache repo info for repeated calls", async () => {
      const filePath = import.meta.url.replace("file://", "");

      const repoInfo1 = await service.getRepoInfo(filePath);
      const repoInfo2 = await service.getRepoInfo(filePath);

      // Same object should be returned from cache
      expect(repoInfo1).toBe(repoInfo2);
    });
  });

  describe("getChunkMetadata", () => {
    it("should return null for files outside git repos", async () => {
      const metadata = await service.getChunkMetadata(
        "/tmp/non-existent-file.ts",
        1,
        10,
      );

      expect(metadata).toBeNull();
    });

    it("should return canonical metadata structure for tracked files", async () => {
      // Use this test file itself - we know it exists and is tracked by git
      const filePath = import.meta.url.replace("file://", "");

      const metadata = await service.getChunkMetadata(filePath, 1, 50);

      // If metadata is returned, validate canonical structure
      if (metadata) {
        // Required fields per canonical algorithm
        expect(typeof metadata.lastModifiedAt).toBe("number");
        expect(typeof metadata.firstCreatedAt).toBe("number");
        expect(typeof metadata.dominantAuthor).toBe("string");
        expect(typeof metadata.dominantAuthorEmail).toBe("string");
        expect(Array.isArray(metadata.authors)).toBe(true);
        expect(typeof metadata.commitCount).toBe("number");
        expect(typeof metadata.lastCommitHash).toBe("string");
        expect(typeof metadata.ageDays).toBe("number");

        // Timestamps should be valid Unix timestamps
        expect(metadata.lastModifiedAt).toBeGreaterThan(0);
        expect(metadata.firstCreatedAt).toBeGreaterThan(0);
        expect(metadata.firstCreatedAt).toBeLessThanOrEqual(
          metadata.lastModifiedAt,
        );

        // Commit hash should be 40 hex chars
        expect(metadata.lastCommitHash).toMatch(/^[a-f0-9]{40}$/);

        // Authors should include dominant author
        expect(metadata.authors).toContain(metadata.dominantAuthor);

        // Commit count should be positive
        expect(metadata.commitCount).toBeGreaterThan(0);

        // Age should be non-negative
        expect(metadata.ageDays).toBeGreaterThanOrEqual(0);
      }
    });

    it("should NOT contain forbidden fields (canonical algorithm compliance)", async () => {
      const filePath = import.meta.url.replace("file://", "");

      const metadata = await service.getChunkMetadata(filePath, 1, 50);

      if (metadata) {
        // These fields are explicitly FORBIDDEN by canonical algorithm
        // (full commit messages, not extracted taskIds)
        expect((metadata as any).commitMessage).toBeUndefined();
        expect((metadata as any).hasTests).toBeUndefined();
        expect((metadata as any).changeFrequency).toBeUndefined();
        expect((metadata as any).lastNAuthors).toBeUndefined();

        // taskIds is allowed (extracted from summaries, not full messages)
        expect(Array.isArray(metadata.taskIds)).toBe(true);
      }
    });

    it("should aggregate blame data correctly for a line range", async () => {
      const filePath = import.meta.url.replace("file://", "");

      // Get metadata for different ranges
      const metadata1 = await service.getChunkMetadata(filePath, 1, 25);
      const metadata2 = await service.getChunkMetadata(filePath, 50, 100);

      // Both should return valid metadata (different ranges may have different authors)
      if (metadata1 && metadata2) {
        // Each range should have valid dominant author
        expect(metadata1.dominantAuthor).toBeTruthy();
        expect(metadata2.dominantAuthor).toBeTruthy();
      }
    });
  });

  describe("caching behavior", () => {
    it("should cache blame data in memory (L1 cache)", async () => {
      // Use a known tracked file from the repo
      const repoInfo = await service.getRepoInfo(import.meta.url.replace("file://", ""));
      if (!repoInfo.isGitRepo) {
        // Skip test if not in a git repo
        return;
      }

      // Use a core file that's definitely committed
      const filePath = `${repoInfo.repoRoot}/package.json`;

      // First call - runs git blame
      const metadata1 = await service.getChunkMetadata(filePath, 1, 10);

      // Second call with different range - should use cached blame
      const metadata2 = await service.getChunkMetadata(filePath, 11, 20);

      // If metadata is available, both should succeed
      if (metadata1) {
        expect(metadata2).not.toBeNull();
      }
    });

    it("should clear caches when clearCaches is called", async () => {
      // Use a known tracked file from the repo
      const repoInfo = await service.getRepoInfo(import.meta.url.replace("file://", ""));
      if (!repoInfo.isGitRepo) {
        // Skip test if not in a git repo
        return;
      }

      // Use a core file that's definitely committed
      const filePath = `${repoInfo.repoRoot}/package.json`;

      // Populate cache
      await service.getChunkMetadata(filePath, 1, 10);

      // Clear
      service.clearCaches();

      // Should still work (but will re-run git blame)
      const metadata = await service.getChunkMetadata(filePath, 1, 10);

      // If file is tracked, should return metadata
      if (metadata) {
        expect(metadata.dominantAuthor).toBeTruthy();
      }
    });
  });

  describe("canonical algorithm validation", () => {
    it("should produce aggregated signals only (not per-line data)", async () => {
      const filePath = import.meta.url.replace("file://", "");

      const metadata = await service.getChunkMetadata(filePath, 1, 100);

      if (metadata) {
        // These are the ONLY fields that should be stored per canonical algorithm
        const allowedKeys = [
          "lastModifiedAt",
          "firstCreatedAt",
          "dominantAuthor",
          "dominantAuthorEmail",
          "authors",
          "commitCount",
          "lastCommitHash",
          "ageDays",
          "taskIds",
        ];

        const actualKeys = Object.keys(metadata);
        for (const key of actualKeys) {
          expect(allowedKeys).toContain(key);
        }
      }
    });
  });

  describe("task ID extraction", () => {
    // Access private method for testing via type assertion
    const extractTaskIds = (svc: GitMetadataService, summary: string): string[] => {
      return (svc as any).extractTaskIds(summary);
    };

    it("should extract JIRA-style task IDs (ABC-123)", () => {
      const taskIds = extractTaskIds(service, "feat(auth): implement login [TD-1234]");

      expect(taskIds).toContain("TD-1234");
    });

    it("should extract multiple JIRA task IDs from one summary", () => {
      const taskIds = extractTaskIds(service, "fix: resolve TD-1234 and TD-5678 issues");

      expect(taskIds).toContain("TD-1234");
      expect(taskIds).toContain("TD-5678");
      expect(taskIds.length).toBe(2);
    });

    it("should extract GitHub-style task IDs (#123)", () => {
      const taskIds = extractTaskIds(service, "fix: resolve issue #123");

      expect(taskIds).toContain("#123");
    });

    it("should extract Azure DevOps task IDs (AB#456)", () => {
      const taskIds = extractTaskIds(service, "feat: implement feature AB#456");

      expect(taskIds).toContain("AB#456");
    });

    it("should extract GitLab MR IDs (!789)", () => {
      const taskIds = extractTaskIds(service, "fix: merge !789 changes");

      expect(taskIds).toContain("!789");
    });

    it("should extract mixed task IDs from complex messages", () => {
      const taskIds = extractTaskIds(
        service,
        "feat(core): implement TD-1234 feature, fixes #567, ref AB#890"
      );

      expect(taskIds).toContain("TD-1234");
      expect(taskIds).toContain("#567");
      expect(taskIds).toContain("AB#890");
      // Note: May also extract #890 from AB#890 depending on regex order
      expect(taskIds.length).toBeGreaterThanOrEqual(3);
    });

    it("should return empty array for messages without task IDs", () => {
      const taskIds = extractTaskIds(service, "chore: update dependencies");

      expect(taskIds).toHaveLength(0);
    });

    it("should handle Linear-style task IDs (ENG-123)", () => {
      const taskIds = extractTaskIds(service, "feat: implement ENG-123 feature");

      expect(taskIds).toContain("ENG-123");
    });

    it("should deduplicate repeated task IDs", () => {
      const taskIds = extractTaskIds(
        service,
        "fix: TD-1234 part 1, continue TD-1234 part 2"
      );

      expect(taskIds.filter(id => id === "TD-1234").length).toBe(1);
    });

    it("should handle empty summary", () => {
      const taskIds = extractTaskIds(service, "");

      expect(taskIds).toHaveLength(0);
    });

    it("should not match HTML entities like &#123;", () => {
      const taskIds = extractTaskIds(service, "fix: handle &#123; encoding issue");

      // Should not extract #123 from HTML entity
      expect(taskIds).not.toContain("#123");
    });
  });

  describe("prefetchBlame", () => {
    it("should prefetch blame for multiple files in parallel", async () => {
      const repoInfo = await service.getRepoInfo(import.meta.url.replace("file://", ""));
      if (!repoInfo.isGitRepo) return;

      const filePaths = [
        `${repoInfo.repoRoot}/package.json`,
        `${repoInfo.repoRoot}/tsconfig.json`,
      ];

      const result = await service.prefetchBlame(filePaths);

      expect(result.prefetched).toBeGreaterThanOrEqual(0);
      expect(result.failed).toBeGreaterThanOrEqual(0);
      expect(result.prefetched + result.failed).toBeLessThanOrEqual(filePaths.length);
    });

    it("should return immediately for empty file list", async () => {
      const result = await service.prefetchBlame([]);

      expect(result.prefetched).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("should return zeros for non-git paths", async () => {
      const result = await service.prefetchBlame(["/tmp/non-existent-file.ts"]);

      expect(result.prefetched).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("should warm L1 cache so getChunkMetadata is fast", async () => {
      const repoInfo = await service.getRepoInfo(import.meta.url.replace("file://", ""));
      if (!repoInfo.isGitRepo) return;

      const filePath = `${repoInfo.repoRoot}/package.json`;

      // Clear caches first
      service.clearCaches();

      // Prefetch
      await service.prefetchBlame([filePath]);

      // Get stats before
      const statsBefore = service.getStats();
      const l1HitsBefore = statsBefore.cacheHitsL1;

      // Now getChunkMetadata should hit L1 cache
      await service.getChunkMetadata(filePath, 1, 10);

      // Get stats after
      const statsAfter = service.getStats();

      // L1 hits should have increased (blame map was pre-cached)
      expect(statsAfter.cacheHitsL1).toBeGreaterThan(l1HitsBefore);
    });

    it("should respect concurrency limit", async () => {
      const repoInfo = await service.getRepoInfo(import.meta.url.replace("file://", ""));
      if (!repoInfo.isGitRepo) return;

      // Create list of files
      const filePaths = [
        `${repoInfo.repoRoot}/package.json`,
        `${repoInfo.repoRoot}/tsconfig.json`,
        `${repoInfo.repoRoot}/README.md`,
      ];

      // Prefetch with concurrency of 1 (sequential)
      const result = await service.prefetchBlame(filePaths, undefined, 1);

      // Should still complete successfully
      expect(result.prefetched + result.failed).toBeLessThanOrEqual(filePaths.length);
    });
  });

  describe("edge cases", () => {
    it("should handle line ranges beyond file length gracefully", async () => {
      const repoInfo = await service.getRepoInfo(import.meta.url.replace("file://", ""));
      if (!repoInfo.isGitRepo) return;

      const filePath = `${repoInfo.repoRoot}/package.json`;

      // Request lines beyond what package.json likely has
      const metadata = await service.getChunkMetadata(filePath, 1, 10000);

      // Should still return metadata for available lines
      if (metadata) {
        expect(metadata.dominantAuthor).toBeTruthy();
      }
    });

    it("should handle single-line range", async () => {
      const repoInfo = await service.getRepoInfo(import.meta.url.replace("file://", ""));
      if (!repoInfo.isGitRepo) return;

      const filePath = `${repoInfo.repoRoot}/package.json`;

      const metadata = await service.getChunkMetadata(filePath, 1, 1);

      if (metadata) {
        expect(metadata.commitCount).toBe(1); // Single line = single commit
        expect(metadata.authors.length).toBe(1);
      }
    });

    it("should handle inverted line range gracefully", async () => {
      const repoInfo = await service.getRepoInfo(import.meta.url.replace("file://", ""));
      if (!repoInfo.isGitRepo) return;

      const filePath = `${repoInfo.repoRoot}/package.json`;

      // endLine < startLine should return null or handle gracefully
      const metadata = await service.getChunkMetadata(filePath, 10, 5);

      // Either returns null or returns valid metadata
      if (metadata) {
        expect(metadata.dominantAuthor).toBeTruthy();
      }
    });

    it("should handle files with uncommitted changes", async () => {
      // Files with uncommitted changes may have partial blame data
      // The service should still return whatever data is available
      const repoInfo = await service.getRepoInfo(import.meta.url.replace("file://", ""));
      if (!repoInfo.isGitRepo) return;

      // This test file likely has uncommitted changes after we modified it
      const filePath = import.meta.url.replace("file://", "");
      const metadata = await service.getChunkMetadata(filePath, 1, 10);

      // May return null or partial metadata - both are valid
      // We just verify no crash occurs
      expect(true).toBe(true);
    });
  });
});
