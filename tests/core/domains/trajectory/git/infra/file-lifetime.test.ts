/**
 * `foldFileLifetimeStamps` — whole-history age stamps per HEAD path (bd
 * tea-rags-mcp-i6tkc): newest / oldest AUTHOR date across every name the file
 * had, a path re-created after a rename keeping its own history.
 */
import { describe, expect, it } from "vitest";

import type { CommitPathChanges } from "../../../../../../src/core/adapters/vcs/types.js";
import {
  addDormantFileChurn,
  foldFileLifetimeStamps,
} from "../../../../../../src/core/domains/trajectory/git/infra/file-lifetime.js";

// Newest → oldest log order; author dates need not follow it (a rebase).
const LOG: CommitPathChanges[] = [
  { sha: "s5", timestamp: 500, changedFiles: [{ path: "old.ts" }] }, // re-created after the rename
  { sha: "s4", timestamp: 300, changedFiles: [{ path: "new.ts", previousPath: "old.ts" }] },
  { sha: "s3", timestamp: 350, changedFiles: [{ path: "old.ts" }] }, // rebased: newer author date than the rename
  { sha: "s2", timestamp: 200, changedFiles: [{ path: "old.ts" }, { path: "other.ts" }] },
  { sha: "s1", timestamp: 100, changedFiles: [{ path: "old.ts" }] },
];

describe("foldFileLifetimeStamps", () => {
  it("follows a rename back to the first name, and keeps a re-created path apart", () => {
    const stamps = foldFileLifetimeStamps(LOG);

    expect(stamps.get("new.ts")).toEqual({ lastModifiedAt: 350, firstCreatedAt: 100, lastCommitHash: "s3" });
    expect(stamps.get("old.ts")).toEqual({ lastModifiedAt: 500, firstCreatedAt: 500, lastCommitHash: "s5" });
    expect(stamps.get("other.ts")).toEqual({ lastModifiedAt: 200, firstCreatedAt: 200, lastCommitHash: "s2" });
  });

  it("adds a zero-observation entry only for paths the window misses and the history has", () => {
    const windowed = new Map([["other.ts", { commits: [], linesAdded: 4, linesDeleted: 1 }]]);

    const filled = addDormantFileChurn(windowed, ["new.ts", "other.ts", "never.ts"], foldFileLifetimeStamps(LOG));

    expect([...filled.keys()].sort()).toEqual(["new.ts", "other.ts"]);
    expect(filled.get("other.ts")).toEqual({ commits: [], linesAdded: 4, linesDeleted: 1 });
    expect(filled.get("new.ts")).toEqual({
      commits: [],
      linesAdded: 0,
      linesDeleted: 0,
      lifetime: { lastModifiedAt: 350, firstCreatedAt: 100, lastCommitHash: "s3" },
    });
  });
});
