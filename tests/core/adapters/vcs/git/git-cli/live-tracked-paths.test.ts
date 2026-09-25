/**
 * The two reads the co-change sub-graph scopes its pairs by (bd
 * tea-rags-mcp-x4rpp): which paths a commit's tree tracks, and which HEAD paths
 * the working tree no longer has. A path is live when the first holds and the
 * second does not — never merely because a file of that name sits on disk (an
 * untracked or ignored build artifact reusing a once-committed path).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";

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

describe("GitCliAdapter — live tracked paths", { timeout: 30_000 }, () => {
  let root: string;
  let head: string;
  let adapter: GitCliAdapter;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "live-tracked-"));
    git(root, "init", "-q", "-b", "main");
    mkdirSync(join(root, "src"));
    for (const f of ["src/a.ts", "src/b.ts", "src/gone.ts", "src/staged-gone.ts", "src/moved.ts", "src/edited.ts"]) {
      writeFileSync(join(root, f), `// ${f}\n`);
    }
    writeFileSync(join(root, "ünï code.ts"), "x\n");
    writeFileSync(join(root, ".gitignore"), "build/\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    head = git(root, "rev-parse", "HEAD").trim();

    // Working-tree drift at the same HEAD.
    unlinkSync(join(root, "src/gone.ts"));
    git(root, "rm", "-q", "src/staged-gone.ts");
    git(root, "mv", "src/moved.ts", "src/renamed.ts");
    writeFileSync(join(root, "src/edited.ts"), "// changed\n");
    writeFileSync(join(root, "src/untracked.ts"), "x\n");
    mkdirSync(join(root, "build"));
    writeFileSync(join(root, "build/out.js"), "x\n");
    adapter = new GitCliAdapter(root);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lists every path the commit's tree tracks, and nothing untracked or ignored", async () => {
    const paths = await adapter.listTreePaths(head);

    expect([...paths].sort()).toEqual(
      [
        ".gitignore",
        "src/a.ts",
        "src/b.ts",
        "src/edited.ts",
        "src/gone.ts",
        "src/moved.ts",
        "src/staged-gone.ts",
        "ünï code.ts",
      ].sort(),
    );
  });

  it("lists HEAD paths the working tree lost — unstaged, staged and renamed away — and not edited ones", async () => {
    const deleted = await adapter.listWorktreeDeletions();

    expect([...deleted].sort()).toEqual(["src/gone.ts", "src/moved.ts", "src/staged-gone.ts"]);
  });
});
