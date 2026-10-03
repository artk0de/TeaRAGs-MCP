/**
 * A real git repository with linked worktrees, in a temp dir (bd
 * tea-rags-mcp-xi2r9). Working-tree tests read the tree the way production
 * does — through git's own on-disk layout and the git CLI — so the fixture is
 * real git, never a mock.
 *
 * Every git call is refused outside the fixture's temp root: a fixture that ran
 * against a broken cwd would commit onto the developer's own HEAD (see
 * `tests/worktree-head-guard.ts`, the run-level backstop). The GIT_* variables a
 * pre-commit hook exports are scrubbed by `tests/vitest.setup.ts`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export interface GitWorkingTreeFixture {
  /** realpath of the main checkout */
  mainRoot: string;
  /** `git worktree add -b wt-<name>` beside the main checkout; returns its realpath */
  addWorktree: (name: string) => string;
  /** Writes `files` (repo-relative) under `root`, commits them, returns the commit sha */
  commit: (root: string, files: Record<string, string>, message?: string) => string;
  git: (root: string, ...args: string[]) => string;
  cleanup: () => void;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@x",
};

/** A repository whose main checkout holds one commit with `src/index.ts`. */
export function createGitWorkingTreeFixture(): GitWorkingTreeFixture {
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "git-working-tree-")));
  const mainRoot = join(tempRoot, "main");

  const git = (root: string, ...args: string[]): string => {
    const cwd = resolve(root);
    if (!cwd.startsWith(tempRoot + sep)) {
      throw new Error(`git-working-tree-fixture: refusing git "${args[0]}" outside the fixture: ${root}`);
    }
    return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY } });
  };

  const commit = (root: string, files: Record<string, string>, message = "change"): string => {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(root, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", message);
    return git(root, "rev-parse", "HEAD").trim();
  };

  mkdirSync(mainRoot);
  git(mainRoot, "init", "-q", "-b", "main");
  commit(mainRoot, { "src/index.ts": "export const base = 1;\n" }, "init");

  return {
    mainRoot,
    addWorktree: (name) => {
      const tree = join(tempRoot, `wt-${name}`);
      git(mainRoot, "worktree", "add", "-q", "-b", `wt-${name}`, tree);
      return realpathSync(tree);
    },
    commit,
    git,
    cleanup: () => {
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}
