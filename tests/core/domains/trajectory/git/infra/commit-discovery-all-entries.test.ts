/**
 * `GitCommitDiscovery#allEntries` — the whole run-scoped matrix, unsliced, for a
 * consumer that reads history repo-wide rather than per file batch: the
 * temporal co-change extractor (bd tea-rags-mcp-x4rpp). Same matrix, same
 * single-flight build, same persistence — only no file-set slice.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import * as gitClient from "../../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import {
  GitCommitDiscovery,
  type GitCommitDiscoveryEntry,
} from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";

vi.mock("../../../../../../src/core/adapters/vcs/git/git-cli/client.js", async (importOriginal) => importOriginal());

function entry(sha: string, paths: string[]): GitCommitDiscoveryEntry {
  return {
    commit: { sha, author: "Alice", authorEmail: "a@x", timestamp: 1000, body: "feat: x", parents: [] },
    changedFiles: paths.map((path) => ({ path })),
  };
}

describe("GitCommitDiscovery#allEntries (bd tea-rags-mcp-x4rpp)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns every row in log order and shares the one build with commitsForFiles", async () => {
    vi.spyOn(gitClient, "getHead").mockResolvedValue("h".repeat(40));
    const log = vi
      .spyOn(gitClient, "getCommitsSince")
      .mockResolvedValue([entry("sha3", ["a.ts"]), entry("sha2", ["b.ts", "c.yml"]), entry("sha1", ["a.ts"])]);
    const discovery = new GitCommitDiscovery(new GitCliAdapter("/repo"), { maxAgeMonths: 6, timeoutMs: 1000 });

    const all = await discovery.allEntries();
    await discovery.commitsForFiles(["a.ts"]);

    expect(all.map((e) => e.commit.sha)).toEqual(["sha3", "sha2", "sha1"]);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
