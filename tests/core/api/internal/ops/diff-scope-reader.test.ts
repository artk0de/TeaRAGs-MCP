/**
 * `readDiffScope` — the shared diff-scope reader (bd tea-rags-mcp-89k7k.1.1):
 * which files a working-tree change touches, their added line ranges, the
 * merge-base the change is read against, and the notices an empty read carries.
 *
 * The reader-level cases of the naming review's diff mode moved here from
 * `naming-lexicon-diff.test.ts` — merge-base semantics, the cap, whole-file
 * reads, non-production classification — so every future diff-scoped report
 * inherits their gate. A temp git repo holds the change; no index is involved.
 * `readTreeLag`, the registry-vs-tree comparison the lexicon marks its answers
 * with, is unit-tested here too.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InvalidParameterError } from "../../../../../src/core/api/errors.js";
import {
  readDiffScope,
  readTreeLag,
  resolveWorkTree,
} from "../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import type { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/index.js";

const CHANGED = "src/git/file-reader.ts";

const ORIGINAL = `export function load(): void {
  const other: GitFileSignals = read();
  use(other);
}
`;

const CHANGED_TEXT = `export function load(): void {
  const other: GitFileSignals = read();
  use(other);
}

export function scan(): void {
  const meta: GitFileSignals = read();
  const fileSignals: GitFileSignals = read();
  const result: RunReport = run();
  use(meta, fileSignals, result);
}

export class Commit {}
`;

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

describe("readDiffScope", { timeout: 60_000 }, () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diff-scope-reader-"));
    repo = join(dir, "repo");
    mkdirSync(join(repo, "src/git"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, CHANGED), ORIGINAL);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(join(repo, CHANGED), CHANGED_TEXT);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("caps the changed files at 200 per call", async () => {
    mkdirSync(join(repo, "notes"));
    for (let i = 0; i < 201; i++) writeFileSync(join(repo, `notes/n${String(i).padStart(3, "0")}.md`), "x\n");
    const read = await readDiffScope(repo, {});
    expect(read.files).toHaveLength(200);
    expect(read.skipped).toBe(2);
  });

  it("a non-production changed file is not judged, and counts as not judged", async () => {
    writeFileSync(
      join(repo, "src/git/reader.test.ts"),
      "export function t(): void {\n  const meta: GitFileSignals = read();\n  use(meta);\n}\n",
    );
    const read = await readDiffScope(repo, { files: ["src/git/reader.test.ts"] });
    expect(read.files).toContainEqual("src/git/reader.test.ts");
    expect(read.nonProduction.has("src/git/reader.test.ts")).toBe(true);
  });

  it("an untracked file is reviewed whole", async () => {
    writeFileSync(join(repo, "src/git/fresh.ts"), "// one\n// two\nexport class Commit {}\n");
    const read = await readDiffScope(repo, { files: ["src/git/fresh.ts"] });
    expect(read.files).toContainEqual("src/git/fresh.ts");
    // The untracked file is in the changed set, so its "whole" is its added-line ranges: every line.
    expect(read.wholeFiles).toBe(0);
    expect(read.addedRanges.get("src/git/fresh.ts")).toEqual([{ start: 1, end: 3 }]);
  });

  it("`files` with no diff against the base reviews every declaration they hold, and says so", async () => {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "committed");
    const read = await readDiffScope(repo, { files: [CHANGED] });
    expect(read.wholeFiles).toBe(1);
    expect(read.changedFiles).toBe(0);
    expect(read.addedRanges.get(CHANGED)).toEqual([{ start: 1, end: Number.MAX_SAFE_INTEGER }]);
  });

  it("diff mode needs the project's working tree", async () => {
    await expect(readDiffScope(undefined, {})).rejects.toBeInstanceOf(InvalidParameterError);
  });

  // bd tea-rags-mcp-y33ee: a base branch that moved on flooded the review with files only the base changed.
  describe("a base branch that moved on since the branch left it", () => {
    const SHARED = "src/git/shared.ts";
    let forkPoint: string;

    beforeEach(() => {
      // The fork point carries `shared.ts`; the branch commits its change; main then rewrites `shared.ts`.
      writeFileSync(join(repo, CHANGED), ORIGINAL);
      writeFileSync(join(repo, SHARED), "export class Commit {}\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "shared");
      forkPoint = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "-q", "-b", "feat");
      writeFileSync(join(repo, CHANGED), CHANGED_TEXT);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "feat");
      git(repo, "checkout", "-q", "main");
      writeFileSync(join(repo, SHARED), "export class Kommit {}\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "main moves on");
      git(repo, "checkout", "-q", "feat");
    });

    it("reviews what the branch changed since its merge-base with the base, and reports that commit", async () => {
      const read = await readDiffScope(repo, { base: "main" });
      expect(read.base).toBe("main");
      expect(read.mergeBase).toBe(forkPoint);
      expect(read.changedFiles).toBe(1);
      expect(new Set(read.files)).toEqual(new Set([CHANGED]));
    });

    it("a base HEAD descends from is compared as given", async () => {
      const read = await readDiffScope(repo, { base: forkPoint });
      expect(read.mergeBase).toBe(forkPoint);
      expect(read.changedFiles).toBe(1);
    });

    it("a base HEAD shares no history with is a parameter error saying there is no merge-base", async () => {
      const emptyTree = git(repo, "hash-object", "-t", "tree", "/dev/null").trim();
      const orphan = git(repo, "commit-tree", emptyTree, "-m", "orphan").trim();
      const call = readDiffScope(repo, { base: orphan });
      await expect(call).rejects.toBeInstanceOf(InvalidParameterError);
      await expect(call).rejects.toThrow(/no merge-base/);
    });

    it("an unknown base is a parameter error", async () => {
      await expect(readDiffScope(repo, { base: "no-such-branch" })).rejects.toBeInstanceOf(InvalidParameterError);
    });
  });

  it("the default base is HEAD itself: its merge-base is HEAD's commit", async () => {
    const read = await readDiffScope(repo, {});
    expect(read.mergeBase).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(read.changedFiles).toBe(1);
    expect(read.wholeFiles).toBe(0);
  });

  // Lexicon friction F1: a project alias resolves to the MAIN checkout, so a change made in a
  // linked worktree was reviewed as `changedFiles: 0` — success-shaped and blind.
  it("an empty diff says what it could not see — never a bare changedFiles: 0", async () => {
    git(repo, "commit", "-q", "-am", "change");
    const tree = join(dir, "wt");
    git(repo, "worktree", "add", "-q", "-b", "feature", tree);
    writeFileSync(
      join(tree, "src/git/extra.ts"),
      "export function more(): void {\n  const blob: GitFileSignals = read();\n  use(blob);\n}\n",
    );
    const read = await readDiffScope(realpathSync(repo), {});
    expect(read.changedFiles).toBe(0);
    const notice = read.notices.find((n) => n.startsWith("no changes"));
    expect(notice).toBeDefined();
    expect(notice).toContain("changes.base");
    expect(notice).toContain("path");
    expect(notice).toContain(realpathSync(tree));
  });
});

describe("resolveWorkTree", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diff-scope-reader-tree-"));
    repo = join(dir, "repo");
    mkdirSync(join(repo, "src/git"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "src/git/base.ts"), "export const base = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A linked worktree of `repo` carrying an uncommitted change, at its realpath. */
  function addWorkTree(): string {
    const tree = join(dir, "wt");
    git(repo, "worktree", "add", "-q", "-b", "feature", tree);
    writeFileSync(
      join(tree, "src/git/extra.ts"),
      "export function more(): void {\n  const blob: GitFileSignals = read();\n  use(blob);\n}\n",
    );
    return realpathSync(tree);
  }

  it("an alias with a path reviews that linked worktree against the project's evidence", () => {
    const tree = addWorkTree();
    expect(resolveWorkTree({ project: "p", path: tree }, repo)).toBe(tree);
  });

  it("refuses a tree of another repository: its change is no diff of this project", () => {
    const other = join(dir, "other");
    mkdirSync(other);
    git(other, "init", "-q", "-b", "main");
    expect(() => resolveWorkTree({ project: "p", path: other }, repo)).toThrow(InvalidParameterError);
  });

  it("a collection wins over the path: the tree stays the resolved root", () => {
    const tree = addWorkTree();
    expect(resolveWorkTree({ collection: "c", path: tree }, repo)).toBe(repo);
  });
});

describe("readTreeLag", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diff-scope-reader-lag-"));
    repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "x.ts"), "export const x = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const registryAt = (entry: unknown): CollectionRegistry => ({ get: () => entry }) as unknown as CollectionRegistry;
  const headCommit = () => git(repo, "rev-parse", "HEAD").trim();

  it("an entry with no indexed commit is no lag", () => {
    expect(readTreeLag(registryAt({}), "c", repo)).toBeUndefined();
  });

  it("an index at the tree's HEAD is no lag", () => {
    expect(readTreeLag(registryAt({ git: { indexedCommit: headCommit() } }), "c", repo)).toBeUndefined();
  });

  it("an index built at another commit than the tree's HEAD is the lagging pair", () => {
    expect(readTreeLag(registryAt({ git: { indexedCommit: "0".repeat(40) } }), "c", repo)).toEqual({
      indexedCommit: "0".repeat(40),
      treeCommit: headCommit(),
    });
  });
});
