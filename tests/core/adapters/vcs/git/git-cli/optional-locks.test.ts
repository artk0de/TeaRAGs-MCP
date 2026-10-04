/**
 * Read-only git in the user's tree never writes the index (bd tea-rags-mcp-s5kpv).
 *
 * `git status` refreshes stale stat info OPPORTUNISTICALLY: when a tracked
 * file's stat no longer matches its index entry it takes `index.lock` and
 * rewrites `.git/index`. A child reaped mid-run (stall guard, CLI exit) leaves
 * that lock behind and blocks the user's next `git commit`; even a live one
 * races it. tea-rags runs every git child with `GIT_OPTIONAL_LOCKS=0`, so the
 * refresh is skipped. Real git: the index is made stat-dirty, which is exactly
 * the state in which an unguarded `git status` rewrites it — so an unchanged
 * index (bytes and mtime) after the read proves the lock was never taken.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../../__helpers__/git-working-tree-fixture.js";
import { readStatusPorcelain } from "../../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import { readWorkingTreeDirty, readWorkingTreeDirtyPaths } from "../../../../../../src/core/infra/repo-git-state.js";

interface IndexSnapshot {
  mtimeMs: number;
  sha: string;
}

const fixtures: GitWorkingTreeFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** A committed tree whose tracked file's stat no longer matches its index entry. */
function statDirtyRepo(): { root: string; indexPath: string; snapshot: () => IndexSnapshot } {
  const fixture = createGitWorkingTreeFixture();
  fixtures.push(fixture);
  const root = fixture.mainRoot;
  fixture.commit(root, { "tracked.ts": "export const t = 1;\n" });
  const indexPath = fixture.git(root, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();

  // Content unchanged, stat moved: git status would refresh this entry.
  const past = Date.now() / 1000 - 3600;
  utimesSync(join(root, "tracked.ts"), past, past);
  // Back-date the index so a rewrite is visible in its mtime, not only its bytes.
  utimesSync(indexPath, past - 3600, past - 3600);

  const snapshot = (): IndexSnapshot => ({
    mtimeMs: statSync(indexPath).mtimeMs,
    sha: createHash("sha1").update(readFileSync(indexPath)).digest("hex"),
  });
  return { root, indexPath, snapshot };
}

describe("status reads leave the user's index untouched", { timeout: 30_000 }, () => {
  it("readStatusPorcelain", async () => {
    const { root, indexPath, snapshot } = statDirtyRepo();
    const before = snapshot();

    await readStatusPorcelain(root);

    expect(snapshot()).toEqual(before);
    expect(existsSync(`${indexPath}.lock`)).toBe(false);
  });

  it("readWorkingTreeDirty", () => {
    const { root, indexPath, snapshot } = statDirtyRepo();
    const before = snapshot();

    expect(readWorkingTreeDirty(root)).toBe(false);

    expect(snapshot()).toEqual(before);
    expect(existsSync(`${indexPath}.lock`)).toBe(false);
  });

  it("readWorkingTreeDirtyPaths", () => {
    const { root, indexPath, snapshot } = statDirtyRepo();
    const before = snapshot();

    expect(readWorkingTreeDirtyPaths(root)).toEqual([]);

    expect(snapshot()).toEqual(before);
    expect(existsSync(`${indexPath}.lock`)).toBe(false);
  });
});
