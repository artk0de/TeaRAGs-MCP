/**
 * A real git repository with linked worktrees, in a temp dir (bd
 * tea-rags-mcp-xi2r9). Working-tree tests read the tree the way production
 * does — through git's own on-disk layout and the git CLI — so the fixture is
 * real git, never a mock.
 *
 * The repository a test starts from — the initial commit plus any `seed` steps
 * — is built once per process and copied per test (`copyGitRepoTemplate`, bd
 * tea-rags-mcp-2z4sa): every git spawn costs 100–250 ms here and over a second
 * under parallel load, so a per-test build ran into the hook budget. What a test
 * does to its copy afterwards (`commit`, `addWorktree`, `git`) is live git.
 *
 * Every git call is refused outside the fixture's temp root: a fixture that ran
 * against a broken cwd would commit onto the developer's own HEAD (see
 * `tests/worktree-head-guard.ts`, the run-level backstop). The GIT_* variables a
 * pre-commit hook exports are scrubbed by `tests/vitest.setup.ts`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { importGitHistory, type GitHistoryCommit } from "./git-history-import.js";
import { copyGitRepoTemplate } from "./git-repo-template.js";

/**
 * One step of the repository a fixture starts from, applied in order on top of
 * the initial commit and then copied per test:
 *  - `commit` writes the files and commits them in the main checkout, or in the
 *    linked worktree `in` names (one an earlier step added);
 *  - `addWorktree` adds the linked worktree `wt-<name>`, as `addWorktree` does.
 */
export type GitWorkingTreeSeedStep =
  | { commit: Record<string, string>; message?: string; in?: string }
  | { addWorktree: string };

export interface GitWorkingTreeFixture {
  /** realpath of the main checkout */
  mainRoot: string;
  /** `git worktree add -b wt-<name>` beside the main checkout; returns its realpath */
  addWorktree: (name: string) => string;
  /** Writes `files` (repo-relative) under `root`, commits them, returns the commit sha */
  commit: (root: string, files: Record<string, string>, message?: string) => string;
  git: (root: string, ...args: string[]) => string;
  /** What the seed steps produced: each `commit` step's sha in order, each added worktree's realpath by name */
  seeded: { commits: string[]; worktrees: Record<string, string> };
  cleanup: () => void;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@x",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@x",
};

const IDENTITY_PERSON = { name: IDENTITY.GIT_AUTHOR_NAME, email: IDENTITY.GIT_AUTHOR_EMAIL };
const BASE = "export const base = 1;\n";

const MAIN = "main";
const worktreeDir = (name: string): string => `wt-${name}`;

interface GitOps {
  git: (root: string, ...args: string[]) => string;
  commit: (root: string, files: Record<string, string>, message?: string) => string;
  addWorktree: (name: string) => string;
}

/** The commit a checkout's HEAD names, read off disk; `undefined` when it is not a plain loose ref. */
function headFromDisk(checkout: string): string | undefined {
  const dotGit = join(checkout, ".git");
  if (!existsSync(dotGit)) return undefined;
  const gitdir = statSync(dotGit).isFile()
    ? resolve(
        checkout,
        readFileSync(dotGit, "utf8")
          .replace(/^gitdir:\s*/, "")
          .trim(),
      )
    : dotGit;
  const commonRel = existsSync(join(gitdir, "commondir")) ? readFileSync(join(gitdir, "commondir"), "utf8").trim() : "";
  const commondir = commonRel.length > 0 ? resolve(gitdir, commonRel) : gitdir;
  const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
  const sha = head.startsWith("ref: ")
    ? (() => {
        const ref = join(commondir, head.slice("ref: ".length));
        return existsSync(ref) ? readFileSync(ref, "utf8").trim() : undefined;
      })()
    : head;
  return sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

function gitOps(tempRoot: string): GitOps {
  const mainRoot = join(tempRoot, MAIN);

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
    return headFromDisk(resolve(root)) ?? git(root, "rev-parse", "HEAD").trim();
  };

  const addWorktree = (name: string): string => {
    const tree = join(tempRoot, worktreeDir(name));
    git(mainRoot, "worktree", "add", "-q", "-b", `wt-${name}`, tree);
    return realpathSync(tree);
  };

  return { git, commit, addWorktree };
}

/** A repository whose main checkout holds one commit with `src/index.ts`, then the `seed` steps. */
export function createGitWorkingTreeFixture(seed: readonly GitWorkingTreeSeedStep[] = []): GitWorkingTreeFixture {
  const copy = copyGitRepoTemplate(
    `git-working-tree-fixture:${JSON.stringify(seed)}`,
    (templateRoot) => {
      const ops = gitOps(templateRoot);
      const templateMain = join(templateRoot, MAIN);
      mkdirSync(templateMain);
      // Every seed commit goes in through ONE fast-import (bd
      // tea-rags-mcp-1r3e5): a commit made in a linked worktree lands on its
      // `wt-<name>` branch, forked from the main tip the worktree was added at.
      // Only the worktrees themselves are added live, after the import.
      const now = new Date();
      const history: GitHistoryCommit[] = [
        { label: "init", message: "init", author: IDENTITY_PERSON, authorDate: now, writes: { "src/index.ts": BASE } },
      ];
      const commitLabels: string[] = [];
      const forkedAt = new Map<string, string>();
      const branchesWithCommits = new Set<string>();
      let mainTip = "init";
      seed.forEach((step, i) => {
        if ("addWorktree" in step) {
          forkedAt.set(step.addWorktree, mainTip);
          return;
        }
        const label = `seed-${i}`;
        const onWorktree = step.in;
        const fork = onWorktree !== undefined && !branchesWithCommits.has(onWorktree);
        history.push({
          label,
          ...(onWorktree === undefined ? {} : { branch: worktreeDir(onWorktree) }),
          ...(fork ? { from: forkedAt.get(onWorktree) } : {}),
          message: step.message ?? "change",
          author: IDENTITY_PERSON,
          authorDate: now,
          writes: step.commit,
        });
        if (onWorktree === undefined) mainTip = label;
        else branchesWithCommits.add(onWorktree);
        commitLabels.push(label);
      });
      const shas = importGitHistory(templateMain, history);

      const worktrees: string[] = [];
      for (const [name, base] of forkedAt) {
        const tree = join(templateRoot, worktreeDir(name));
        if (branchesWithCommits.has(name)) ops.git(templateMain, "worktree", "add", "-q", tree, worktreeDir(name));
        else ops.git(templateMain, "worktree", "add", "-q", "-b", worktreeDir(name), tree, shas[base]);
        worktrees.push(name);
      }
      return { commits: commitLabels.map((label) => shas[label]), worktrees };
    },
    { prefix: "git-working-tree-", env: { ...process.env, ...IDENTITY } },
  );

  const tempRoot = realpathSync(copy.root);
  const ops = gitOps(tempRoot);
  const worktrees = Object.fromEntries(
    copy.meta.worktrees.map((name) => [name, realpathSync(join(tempRoot, worktreeDir(name)))]),
  );

  return {
    mainRoot: join(tempRoot, MAIN),
    addWorktree: ops.addWorktree,
    commit: ops.commit,
    git: ops.git,
    seeded: { commits: [...copy.meta.commits], worktrees },
    cleanup: () => {
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}
