/**
 * Where a working-tree diff finds the index it copies to its scratch file (bd
 * tea-rags-mcp-0qaht.63): from the repository's own files — `<gitdir>/index`,
 * the per-worktree gitdir a linked worktree's `.git` file names — instead of a
 * `git rev-parse --git-path index` child per diff, which an endpoint-security
 * agent makes cost hundreds of milliseconds. An environment that redirects git
 * (`GIT_INDEX_FILE`, `GIT_DIR`, … — a hook's environment) still asks git, which
 * honours those overrides. The diffs' answers are `working-tree.test.ts`'s.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type * as StallGuardModule from "../../../../../../src/core/adapters/vcs/git/git-cli/stall-guard-exec.js";
import { readWorkingTreeChanges } from "../../../../../../src/core/adapters/vcs/git/git-cli/working-tree.js";

vi.mock("../../../../../../src/core/adapters/vcs/git/git-cli/stall-guard-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof StallGuardModule>();
  return { ...actual, execWithStallGuard: vi.fn(actual.execWithStallGuard) };
});

const stallGuard = await import("../../../../../../src/core/adapters/vcs/git/git-cli/stall-guard-exec.js");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });
}

function gitPathReads(): number {
  return vi.mocked(stallGuard.execWithStallGuard).mock.calls.filter(([, args]) => args.includes("--git-path")).length;
}

describe("git CLI client — the scratch diff's index path", { timeout: 30_000 }, () => {
  let root: string;
  let main: string;
  let linked: string;
  let base: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "scratch-index-path-")));
    main = join(root, "main");
    linked = join(root, "linked");
    mkdirSync(join(main, "src"), { recursive: true });
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "src/a.ts"), "a\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "init");
    base = git(main, "rev-parse", "HEAD").trim();
    git(main, "worktree", "add", "-q", "-b", "feature", linked);
    // Staged in the linked worktree only: its OWN index must be the one copied.
    writeFileSync(join(linked, "src/staged.ts"), "s\n");
    git(linked, "add", "src/staged.ts");
    writeFileSync(join(main, "src/a.ts"), "a\nb\n");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.mocked(stallGuard.execWithStallGuard).mockClear();
    vi.unstubAllEnvs();
  });

  it("a main checkout's index is read from its .git directory, without asking git", async () => {
    const changes = await readWorkingTreeChanges(main, base);

    expect(changes.changed).toEqual(["src/a.ts"]);
    expect(gitPathReads()).toBe(0);
  });

  it("a linked worktree's index is its own gitdir's, without asking git", async () => {
    const changes = await readWorkingTreeChanges(linked, base);

    expect(changes.changed).toEqual(["src/staged.ts"]);
    expect(gitPathReads()).toBe(0);
  });

  it("an environment that redirects git's index still asks git for the path", async () => {
    vi.stubEnv("GIT_INDEX_FILE", join(main, ".git", "index"));

    await readWorkingTreeChanges(main, base);

    expect(gitPathReads()).toBe(1);
  });
});
