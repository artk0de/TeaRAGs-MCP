/**
 * Real-git tests for `readCommitPathChanges` — the whole-history,
 * line-count-free log the dormant-file age stamps are read from (bd
 * tea-rags-mcp-i6tkc). It names every path each commit changed, renames split
 * into the `{ path, previousPath }` pair the numstat parsers produce, and
 * carries the AUTHOR date — the clock every git signal value reads.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importGitHistory } from "../../../__helpers__/git-history-import.js";
import { GitCliAdapter } from "../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";

const TMP_BASE = realpathSync(tmpdir());

describe("readCommitPathChanges (real git)", () => {
  let tmp: string;
  let shas: Record<string, string>;

  beforeEach(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-path-changes-"));
    if (!resolve(tmp).startsWith(TMP_BASE + sep)) throw new Error(`refusing git in non-temp cwd: ${tmp}`);
    const who = { name: "Test", email: "t@example.com" };
    shas = importGitHistory(tmp, [
      {
        label: "c1",
        message: "c1",
        author: who,
        authorDate: "2024-01-01T00:00:00Z",
        writes: { "a.ts": "a\nb\nc\nd\n", "b.ts": "b\n" },
      },
      {
        label: "c2",
        message: "c2",
        author: who,
        authorDate: "2024-02-01T00:00:00Z",
        writes: { "a.ts": "a\nb\nc\nd2\n" },
      },
      {
        label: "c3",
        message: "c3",
        author: who,
        // Rebased: author date older than the committer date.
        authorDate: "2024-03-01T00:00:00Z",
        committerDate: "2024-06-01T00:00:00Z",
        renames: [["a.ts", "src/c.ts"]],
      },
      { label: "c4", message: "c4", author: who, authorDate: "2024-04-01T00:00:00Z", deletes: ["b.ts"] },
    ]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists every commit newest → oldest with its changed paths, renames paired, at the author date", async () => {
    const entries = await new GitCliAdapter(tmp).readCommitPathChanges();

    const epoch = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
    expect(entries).toEqual([
      { sha: shas.c4, timestamp: epoch("2024-04-01T00:00:00Z"), changedFiles: [{ path: "b.ts" }] },
      {
        sha: shas.c3,
        timestamp: epoch("2024-03-01T00:00:00Z"),
        changedFiles: [{ path: "src/c.ts", previousPath: "a.ts" }],
      },
      { sha: shas.c2, timestamp: epoch("2024-02-01T00:00:00Z"), changedFiles: [{ path: "a.ts" }] },
      { sha: shas.c1, timestamp: epoch("2024-01-01T00:00:00Z"), changedFiles: [{ path: "a.ts" }, { path: "b.ts" }] },
    ]);
  });
});
