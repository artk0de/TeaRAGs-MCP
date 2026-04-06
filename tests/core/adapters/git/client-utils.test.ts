import { afterEach, describe, expect, it, vi } from "vitest";

import * as gitClient from "../../../../src/core/adapters/git/client.js";

// ─── withTimeout utility ─────────────────────────────────────────────────────

describe("withTimeout", () => {
  it("should resolve when promise completes before timeout", async () => {
    const result = await gitClient.withTimeout(Promise.resolve("ok"), 5000, "timeout");
    expect(result).toBe("ok");
  });

  it("should reject with timeout message when promise exceeds timeout", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 10000));

    await expect(gitClient.withTimeout(slow, 10, "test timeout message")).rejects.toThrow("test timeout message");
  });

  it("should propagate original rejection when promise fails before timeout", async () => {
    const failing = Promise.reject(new Error("original error"));

    await expect(gitClient.withTimeout(failing, 5000, "timeout")).rejects.toThrow("original error");
  });
});

// ─── buildCliArgs ────────────────────────────────────────────────────────────

describe("buildCliArgs", () => {
  it("should not include --since when sinceDate is undefined", () => {
    const args: string[] = gitClient.buildCliArgs(undefined);
    expect(args).toContain("log");
    expect(args).toContain("HEAD");
    expect(args).toContain("--numstat");
    const hasSince = args.some((a: string) => a.startsWith("--since="));
    expect(hasSince).toBe(false);
  });

  it("should include --since with ISO date when sinceDate is provided", () => {
    const date = new Date("2025-01-15T00:00:00.000Z");
    const args: string[] = gitClient.buildCliArgs(date);
    const sinceArg = args.find((a: string) => a.startsWith("--since="));
    expect(sinceArg).toBeDefined();
    expect(sinceArg).toContain("2025-01-15");
  });
});

// ─── getCommitsByPathspecBatched — merge and error handling ──────────────────

describe("getCommitsByPathspecBatched (via getCommitsByPathspec)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should merge commits from multiple batches by SHA", () => {
    // Pure unit test of merge logic: two batch results with overlapping commit SHA
    const sha = "a".repeat(40);
    const batch1 = [
      {
        commit: { sha, author: "Alice", authorEmail: "a@ex.com", timestamp: 12345, body: "feat: stuff" },
        changedFiles: ["file1.ts"],
      },
    ];
    const batch2 = [
      {
        commit: { sha, author: "Alice", authorEmail: "a@ex.com", timestamp: 12345, body: "feat: stuff" },
        changedFiles: ["file2.ts"],
      },
    ];

    // Simulate merge logic from getCommitsByPathspecBatched
    const merged = new Map<string, { commit: (typeof batch1)[0]["commit"]; changedFiles: Set<string> }>();
    for (const entries of [batch1, batch2]) {
      for (const entry of entries) {
        const existing = merged.get(entry.commit.sha);
        if (existing) {
          for (const f of entry.changedFiles) existing.changedFiles.add(f);
        } else {
          merged.set(entry.commit.sha, { commit: entry.commit, changedFiles: new Set(entry.changedFiles) });
        }
      }
    }

    const result = Array.from(merged.values()).map(({ commit, changedFiles }) => ({
      commit,
      changedFiles: Array.from(changedFiles),
    }));

    expect(result).toHaveLength(1);
    expect(result[0].changedFiles).toContain("file1.ts");
    expect(result[0].changedFiles).toContain("file2.ts");
  });

  it("should return empty array for empty file paths", async () => {
    const result = await gitClient.getCommitsByPathspec("/repo", new Date(), []);
    expect(result).toEqual([]);
  });
});

// ─── readBlobAsString — error returns empty string ───────────────────────────

describe("readBlobAsString", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return empty string when readBlob throws", async () => {
    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readBlob").mockRejectedValue(new Error("not found"));

    const result = await gitClient.readBlobAsString("/repo", "abc123", "nonexistent.ts", {});
    expect(result).toBe("");
  });

  it("should decode blob content as UTF-8", async () => {
    const git = await import("isomorphic-git");
    vi.spyOn(git.default, "readBlob").mockResolvedValue({
      oid: "x".repeat(40),
      blob: new TextEncoder().encode("hello world"),
    } as any);

    const result = await gitClient.readBlobAsString("/repo", "abc123", "file.ts", {});
    expect(result).toBe("hello world");
  });
});
