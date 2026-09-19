/**
 * The pre-commit NUL-byte check over the STAGED blobs (bd tea-rags-mcp-k8gac).
 *
 * `tests/source-nul-bytes.test.ts` scans the tracked tree, but pre-commit runs
 * `vitest related <staged files>`, which selects a test by its imports — and
 * that guard imports nothing a commit stages, so a new raw NUL passed
 * pre-commit and surfaced only in the full suite. The hook now runs
 * `scripts/check-staged-nul-bytes.ts` on every commit. It reads the blobs the
 * commit will record, not the working tree: a file fixed on disk but not
 * re-staged still commits its NUL, and a NUL typed after `git add` does not.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findStagedNulBytes, isNulGuardedPath } from "../../scripts/lib/nul-bytes.js";

const ROOT = resolve(import.meta.dirname, "../..");
const ENTRY = join(ROOT, "scripts/check-staged-nul-bytes.ts");
const TSX = join(ROOT, "node_modules/.bin/tsx");
const TMP_BASE = realpathSync(tmpdir());
const NUL = String.fromCharCode(0);

// Real `git init` / `git add`, so refuse loudly if the cwd ever escapes the temp tree.
function gitIn(cwd: string, args: string[]): string {
  if (!resolve(cwd).startsWith(TMP_BASE + sep)) {
    throw new Error(`staged-nul-bytes.test: refusing git "${args[0]}" in non-temp cwd: ${cwd}`);
  }
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

const repos: string[] = [];

function freshRepo(): string {
  const dir = mkdtempSync(join(TMP_BASE, "staged-nul-bytes-"));
  repos.push(dir);
  gitIn(dir, ["init", "-q"]);
  return dir;
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function stage(repo: string, path: string, content: string): void {
  write(repo, path, content);
  gitIn(repo, ["add", "--", path]);
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isNulGuardedPath", () => {
  it.each([
    "src/core/a.ts",
    "docs/superpowers/plans/2026-09-18-plan.md",
    "scripts/x.mjs",
    "src/ui/view.tsx",
    ".husky/pre-commit",
    ".claude-plugin/tea-rags/scripts/inject-rules.sh",
    "package.json",
    "website/static/img/logo.svg",
    "Makefile",
  ])("guards %s", (path) => {
    expect(isNulGuardedPath(path)).toBe(true);
  });

  it.each(["public/logo.png", "website/static/img/favicon.ico", "fonts/Inter.WOFF2", "a/b.jpeg", "docs/paper.pdf"])(
    "leaves the binary %s alone",
    (path) => {
      expect(isNulGuardedPath(path)).toBe(false);
    },
  );
});

describe("findStagedNulBytes", () => {
  it("reports a raw NUL in a staged text file by path, line and byte", () => {
    const repo = freshRepo();
    stage(repo, "src/key.ts", `const a = 1;\nconst key = a + '${NUL}' + b;\n`);

    expect(findStagedNulBytes(repo)).toEqual([{ path: "src/key.ts", line: 2, column: 18 }]);
  });

  it("reads the staged blob, not the working tree", () => {
    const repo = freshRepo();
    stage(repo, "committed.md", `plan${NUL}\n`);
    write(repo, "committed.md", "plan fixed on disk, never re-staged\n");
    stage(repo, "clean.md", "clean when staged\n");
    write(repo, "clean.md", `dirtied after git add${NUL}\n`);

    expect(findStagedNulBytes(repo)).toEqual([{ path: "committed.md", line: 1, column: 5 }]);
  });

  it("covers every text kind the incident class reaches, not only TypeScript", () => {
    const repo = freshRepo();
    for (const path of ["docs/plan.md", "scripts/a.mjs", "hooks/run.sh", "config.json", ".claude-plugin/x/SKILL.md"]) {
      stage(repo, path, `x${NUL}`);
    }

    expect(findStagedNulBytes(repo).map((offense) => offense.path)).toEqual([
      ".claude-plugin/x/SKILL.md",
      "config.json",
      "docs/plan.md",
      "hooks/run.sh",
      "scripts/a.mjs",
    ]);
  });

  it("skips binary files, whose NUL bytes are content", () => {
    const repo = freshRepo();
    stage(repo, "public/logo.png", `\x89PNG${NUL}${NUL}`);

    expect(findStagedNulBytes(repo)).toEqual([]);
  });

  it("keeps a path with spaces and non-ASCII characters verbatim", () => {
    const repo = freshRepo();
    stage(repo, "docs/план и notes.md", `${NUL}`);

    expect(findStagedNulBytes(repo)).toEqual([{ path: "docs/план и notes.md", line: 1, column: 1 }]);
  });

  it("checks only what the commit adds or changes — not deletions, not files already committed", () => {
    const repo = freshRepo();
    stage(repo, "old.ts", `legacy${NUL}\n`);
    stage(repo, "doomed.ts", "bye\n");
    gitIn(repo, ["commit", "-q", "-m", "seed"]);
    gitIn(repo, ["rm", "-q", "doomed.ts"]);
    stage(repo, "new.ts", "fine\n");

    expect(findStagedNulBytes(repo)).toEqual([]);
  });

  it("checks the destination of a staged rename", () => {
    const repo = freshRepo();
    stage(repo, "a.ts", "fine\n");
    gitIn(repo, ["commit", "-q", "-m", "seed"]);
    gitIn(repo, ["mv", "a.ts", "b.ts"]);
    stage(repo, "b.ts", `fine${NUL}\n`);

    expect(findStagedNulBytes(repo)).toEqual([{ path: "b.ts", line: 1, column: 5 }]);
  });

  it("answers nothing when nothing is staged", () => {
    expect(findStagedNulBytes(freshRepo())).toEqual([]);
  });
});

describe("scripts/check-staged-nul-bytes.ts — what the hook runs", () => {
  it("fails the commit, naming each offending place and the fix", () => {
    const repo = freshRepo();
    stage(repo, "docs/plan.md", `a${NUL}b\n`);

    const result = spawnSync(TSX, [ENTRY], { cwd: repo, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/plan.md line 1, byte 2");
    expect(result.stderr).toContain(String.raw`"\0"`);
  });

  it("lets a clean commit through silently", () => {
    const repo = freshRepo();
    stage(repo, "docs/plan.md", "clean\n");

    const result = spawnSync(TSX, [ENTRY], { cwd: repo, encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
