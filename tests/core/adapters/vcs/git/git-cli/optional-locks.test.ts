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
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../../__helpers__/git-working-tree-fixture.js";
import {
  listChangedFiles,
  listWorktreeDeletions,
  listWorktreeModifications,
  readAddedLineRanges,
  readAddedLineRangesOfFiles,
  readStatusPorcelain,
  readWorkingTreeChanges,
  readWorkingTreeRenames,
} from "../../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import { readWorkingTreeDirty, readWorkingTreeDirtyPaths } from "../../../../../../src/core/infra/repo-git-state.js";

interface IndexSnapshot {
  mtimeMs: number;
  sha: string;
}

const fixtures: GitWorkingTreeFixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/**
 * A committed tree whose tracked file's stat no longer matches its index entry.
 * `edit` also commits `edited.ts` and then really changes its content, so a
 * worktree diff has one true change to report beside the stat-only one.
 */
function statDirtyRepo(options: { edit?: boolean; move?: boolean } = {}): {
  root: string;
  indexPath: string;
  snapshot: () => IndexSnapshot;
} {
  const fixture = createGitWorkingTreeFixture();
  fixtures.push(fixture);
  const root = fixture.mainRoot;
  fixture.commit(root, {
    "tracked.ts": "export const t = 1;\n",
    ...(options.edit ? { "edited.ts": "export const e = 1;\n" } : {}),
    ...(options.move ? { "moving.ts": "export const moving = 'a fairly long body so similarity is high';\n" } : {}),
  });
  const indexPath = fixture.git(root, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
  if (options.edit) writeFileSync(join(root, "edited.ts"), "export const e = 1;\nexport const added = 2;\n");
  if (options.move) {
    rmSync(join(root, "moving.ts"));
    writeFileSync(join(root, "moved.ts"), "export const moving = 'a fairly long body so similarity is high';\n");
  }

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

/**
 * Porcelain `git diff <commit>` against the working tree ignores
 * `GIT_OPTIONAL_LOCKS=0` (git 2.50) and still writes refreshed stat info back
 * to the index. tea-rags therefore runs every worktree diff on a throwaway copy
 * of the index (`GIT_INDEX_FILE`). Each case also pins the answer: the
 * stat-only-dirty `tracked.ts` is never reported, the really edited
 * `edited.ts` is.
 */
describe("worktree diffs leave the user's index untouched", { timeout: 30_000 }, () => {
  async function expectIndexUntouched<T>(
    repo: { indexPath: string; snapshot: () => IndexSnapshot },
    read: () => Promise<T>,
  ): Promise<T> {
    const before = repo.snapshot();
    const result = await read();
    expect(repo.snapshot()).toEqual(before);
    expect(existsSync(`${repo.indexPath}.lock`)).toBe(false);
    return result;
  }

  it("listWorktreeDeletions", async () => {
    const repo = statDirtyRepo({ edit: true });
    expect(await expectIndexUntouched(repo, async () => listWorktreeDeletions(repo.root))).toEqual([]);
  });

  it("listWorktreeModifications", async () => {
    const repo = statDirtyRepo({ edit: true });
    expect(
      await expectIndexUntouched(repo, async () => listWorktreeModifications(repo.root, ["tracked.ts", "edited.ts"])),
    ).toEqual(["edited.ts"]);
  });

  it("listChangedFiles", async () => {
    const repo = statDirtyRepo({ edit: true });
    expect(await expectIndexUntouched(repo, async () => listChangedFiles(repo.root, "HEAD"))).toEqual(["edited.ts"]);
  });

  it("readWorkingTreeChanges", async () => {
    const repo = statDirtyRepo({ edit: true });
    expect(await expectIndexUntouched(repo, async () => readWorkingTreeChanges(repo.root, "HEAD"))).toEqual({
      changed: ["edited.ts"],
      deleted: [],
      untracked: [],
    });
  });

  it("readWorkingTreeRenames without untracked candidates", async () => {
    const repo = statDirtyRepo({ edit: true });
    expect(await expectIndexUntouched(repo, async () => readWorkingTreeRenames(repo.root, "HEAD", []))).toEqual([]);
  });

  it("readWorkingTreeRenames with an unstaged move", async () => {
    const repo = statDirtyRepo({ move: true });
    expect(
      await expectIndexUntouched(repo, async () => readWorkingTreeRenames(repo.root, "HEAD", ["moved.ts"])),
    ).toEqual([{ from: "moving.ts", to: "moved.ts" }]);
  });

  it("readAddedLineRanges", async () => {
    const repo = statDirtyRepo({ edit: true });
    expect(await expectIndexUntouched(repo, async () => readAddedLineRanges(repo.root, "HEAD", "edited.ts"))).toEqual([
      { start: 2, end: 2 },
    ]);
    expect(await expectIndexUntouched(repo, async () => readAddedLineRanges(repo.root, "HEAD", "tracked.ts"))).toEqual(
      [],
    );
  });

  it("readAddedLineRangesOfFiles", async () => {
    const repo = statDirtyRepo({ edit: true });
    const ranges = await expectIndexUntouched(repo, async () =>
      readAddedLineRangesOfFiles(repo.root, "HEAD", ["tracked.ts", "edited.ts"]),
    );
    expect(Object.fromEntries(ranges)).toEqual({ "tracked.ts": [], "edited.ts": [{ start: 2, end: 2 }] });
  });
});

/**
 * Racy-git (bd tea-rags-mcp-s5kpv): git trusts an entry whose stat matches the
 * file UNLESS the file is not older than the index file itself — then it
 * compares content. A same-size edit inside the index's own timestamp is caught
 * only by that rule, so the scratch copy must keep the original index's mtime;
 * a copy stamped "now" turns the racy entry into a trusted one and the edit is
 * silently dropped. `core.checkStat=minimal` + `core.trustctime=false` make the
 * stat match depend on mtime and size alone, so the case is deterministic.
 */
describe("worktree diffs keep racy-git detection on the scratch index", { timeout: 30_000 }, () => {
  it("reports a same-size edit whose mtime equals the index's", async () => {
    const fixture = createGitWorkingTreeFixture();
    fixtures.push(fixture);
    const root = fixture.mainRoot;
    fixture.git(root, "config", "core.checkStat", "minimal");
    fixture.git(root, "config", "core.trustctime", "false");
    fixture.commit(root, { "racy.ts": "export const v = 1;\n" });
    const indexPath = fixture.git(root, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();

    const debug = fixture.git(root, "ls-files", "--debug", "--", "racy.ts");
    const match = /mtime:\s*(\d+):(\d+)/.exec(debug);
    expect(match).not.toBeNull();
    const entryMtime = Number(match?.[1]) + Number(match?.[2]) / 1e9;

    // Same size, different content, stat identical to the index entry.
    writeFileSync(join(root, "racy.ts"), "export const v = 2;\n");
    utimesSync(join(root, "racy.ts"), entryMtime, entryMtime);
    utimesSync(indexPath, entryMtime, entryMtime);

    expect(await listChangedFiles(root, "HEAD")).toEqual(["racy.ts"]);
  });
});

/** The throwaway index copy is removed whether the diff succeeds or fails. */
describe("worktree diff scratch index lifecycle", { timeout: 30_000 }, () => {
  const savedTmpdir = process.env.TMPDIR;
  let scratchParent: string | undefined;

  /** Points `os.tmpdir()` at an empty dir AFTER the fixture repo exists, so only scratch copies land there. */
  function isolateScratchParent(): string {
    const dir = mkdtempSync(join(tmpdir(), "s5kpv-scratch-parent-"));
    scratchParent = dir;
    process.env.TMPDIR = dir;
    return dir;
  }

  afterEach(() => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    if (scratchParent !== undefined) rmSync(scratchParent, { recursive: true, force: true });
    scratchParent = undefined;
  });

  it("leaves no scratch copy after a successful diff", async () => {
    const repo = statDirtyRepo({ edit: true });
    const parent = isolateScratchParent();
    expect(await listChangedFiles(repo.root, "HEAD")).toEqual(["edited.ts"]);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("leaves no scratch copy when the diff fails", async () => {
    const repo = statDirtyRepo({ edit: true });
    const parent = isolateScratchParent();
    await expect(readWorkingTreeChanges(repo.root, "0000000000000000000000000000000000000000")).rejects.toThrow();
    expect(readdirSync(parent)).toEqual([]);
  });
});
