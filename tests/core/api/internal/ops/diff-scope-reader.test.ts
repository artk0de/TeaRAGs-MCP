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
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { importGitHistory } from "../../../__helpers__/git-history-import.js";
import { copyGitRepoTemplate } from "../../../__helpers__/git-repo-template.js";
import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import { resolveWorkingTree } from "../../../../../src/core/api/internal/collection-resolver.js";
import { readDiffScope, readTreeLag } from "../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import { InvalidParameterError } from "../../../../../src/core/api/public/errors.js";
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

/** `<root>/repo`: `CHANGED` committed as `ORIGINAL`, then edited to `CHANGED_TEXT` and left uncommitted. */
function buildChangedRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src/git"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, CHANGED), ORIGINAL);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(join(repo, CHANGED), CHANGED_TEXT);
  return repo;
}

/** `<root>/repo`: one commit holding `file` with `content`. */
function buildOneCommitRepo(root: string, dirs: string, file: string, content: string): void {
  const repo = join(root, "repo");
  mkdirSync(join(repo, dirs), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, file), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
}

describe("readDiffScope", { timeout: 60_000 }, () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = copyGitRepoTemplate(
      "diff-scope-reader:changed",
      (root) => {
        buildChangedRepo(root);
      },
      { prefix: "diff-scope-reader-" },
    ).root;
    repo = join(dir, "repo");
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

  // bd tea-rags-mcp-89k7k.1.9: files past the cap used to be whatever sorts
  // last in git's order — a production change was dropped while non-production
  // notes survived it. The cap now drops by a stated relevance order instead.
  it("over the cap drops non-production files first — the production change is never what sorts last", async () => {
    mkdirSync(join(repo, "spikes"));
    for (let i = 0; i < 200; i++) writeFileSync(join(repo, `spikes/s${String(i).padStart(3, "0")}.md`), "x\n");
    // 200 masked spike files + the modified production file = 201 changed; the
    // production file sorts AFTER every spikes/ path.
    const read = await readDiffScope(repo, {});
    expect(read.skipped).toBe(1);
    expect(read.files).toHaveLength(200);
    expect(read.files).toContain(CHANGED);
    // All spikes tie at one added line; the tie breaks by path ascending, so
    // the LAST spike path is the one dropped.
    expect(read.files).not.toContain("spikes/s199.md");
  });

  it("over the cap drops the production files with the fewest added lines — ties by path, deterministic", async () => {
    // A clean base, then a 201-file working-tree change where every z file
    // gains one line and `aaa-deletion.ts` only loses one: zero added lines.
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(repo, `src/git/z${String(i).padStart(3, "0")}.ts`), "export const Z = 1;\n");
    }
    writeFileSync(join(repo, "src/git/aaa-deletion.ts"), "export const A = 1;\nexport const B = 2;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "files");
    for (let i = 0; i < 200; i++) {
      writeFileSync(
        join(repo, `src/git/z${String(i).padStart(3, "0")}.ts`),
        "export const Z = 1;\nexport const MORE = 2;\n",
      );
    }
    writeFileSync(join(repo, "src/git/aaa-deletion.ts"), "export const A = 1;\n");

    const read = await readDiffScope(repo, {});
    expect(read.skipped).toBe(1);
    // Zero added lines = the least review surface: dropped first, however
    // early the path sorts.
    expect(read.files).not.toContain("src/git/aaa-deletion.ts");
    expect(read.files).toContain("src/git/z000.ts");
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
      // The outer repository taken further, built once and copied in its place.
      rmSync(dir, { recursive: true, force: true });
      const copy = copyGitRepoTemplate(
        "diff-scope-reader:moved-base",
        (root) => {
          const built = join(root, "repo");
          mkdirSync(built);
          // The fork point carries `shared.ts`; the branch commits its change; main then rewrites `shared.ts`.
          // ONE fast-import instead of ~17 init/add/commit/checkout spawns (bd tea-rags-mcp-1r3e5).
          const t = { name: "t", email: "t@x" };
          const now = new Date();
          return importGitHistory(
            built,
            [
              { message: "init", author: t, authorDate: now, writes: { [CHANGED]: ORIGINAL } },
              {
                label: "fork",
                message: "shared",
                author: t,
                authorDate: now,
                writes: { [SHARED]: "export class Commit {}\n" },
              },
              { branch: "feat", message: "feat", author: t, authorDate: now, writes: { [CHANGED]: CHANGED_TEXT } },
              {
                message: "main moves on",
                author: t,
                authorDate: now,
                writes: { [SHARED]: "export class Kommit {}\n" },
              },
            ],
            { checkout: "feat" },
          ).fork;
        },
        { prefix: "diff-scope-reader-" },
      );
      dir = copy.root;
      repo = join(dir, "repo");
      forkPoint = copy.meta;
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

describe("resolveWorkingTree — the tree a review reads", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = copyGitRepoTemplate(
      "diff-scope-reader:tree",
      (root) => {
        buildOneCommitRepo(root, "src/git", "src/git/base.ts", "export const base = 1;\n");
      },
      { prefix: "diff-scope-reader-tree-" },
    ).root;
    repo = join(dir, "repo");
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

  /** Project `p` and collection `c` both name the index registered at `repo`, the main checkout. */
  const registryOfRepo = (): CollectionRegistry =>
    ({
      findByName: (name: string) => (name === "p" ? { name: "p", collectionName: "c", path: repo } : null),
      get: (collectionName: string) => (collectionName === "c" ? { name: "p", collectionName: "c", path: repo } : null),
      list: () => [{ name: "p", collectionName: "c", path: repo }],
    }) as unknown as CollectionRegistry;

  it("an alias with a path reviews that linked worktree against the project's evidence", () => {
    const tree = addWorkTree();
    expect(resolveWorkingTree(registryOfRepo(), { project: "p", path: tree }).root).toBe(tree);
  });

  it("refuses a tree of another repository: its change is no diff of this project", () => {
    const other = join(dir, "other");
    mkdirSync(other);
    git(other, "init", "-q", "-b", "main");
    expect(() => resolveWorkingTree(registryOfRepo(), { project: "p", path: other }).root).toThrow(
      InvalidParameterError,
    );
  });

  it("a collection with a path reviews the path's tree: the collection addresses only the index", () => {
    const tree = addWorkTree();
    expect(resolveWorkingTree(registryOfRepo(), { collection: "c", path: tree }).root).toBe(tree);
  });
});

describe("readTreeLag", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = copyGitRepoTemplate(
      "diff-scope-reader:lag",
      (root) => {
        buildOneCommitRepo(root, ".", "x.ts", "export const x = 1;\n");
      },
      { prefix: "diff-scope-reader-lag-" },
    ).root;
    repo = join(dir, "repo");
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

// Live P2-2 (bd tea-rags-mcp-xi2r9): a project registered at a SUBDIRECTORY of
// its repository. Git answers from the toplevel in toplevel-relative paths; the
// review names files relative to the project root, as the index does, and a
// sibling directory's change is not part of this project's change.
describe("readDiffScope / readTreeLag — a project registered at a repository subdirectory", { timeout: 60_000 }, () => {
  let fixture: GitWorkingTreeFixture;
  let sub: string;

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture([
      {
        commit: {
          "sub/a.ts": "export const a = 1;\n",
          "sub/c.ts": "export const c = 1;\n",
          "sibling/b.ts": "export const b = 1;\n",
        },
      },
    ]);
    sub = join(fixture.mainRoot, "sub");
    writeFileSync(join(sub, "a.ts"), "export const a = 1;\nexport const a2 = 2;\n");
    writeFileSync(join(sub, "new.ts"), "export const n = 1;\nexport const m = 2;\n");
    writeFileSync(join(fixture.mainRoot, "sibling/b.ts"), "export const b = 2;\n");
    writeFileSync(join(fixture.mainRoot, "sibling/new.ts"), "export const s = 1;\n");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("reviews the project's changed files, root-relative, and excludes a sibling directory's change", async () => {
    const read = await readDiffScope(sub, {});
    expect(read.files).toEqual(["a.ts", "new.ts"]);
    expect(read.changedFiles).toBe(2);
    expect(read.notices).toEqual([]);
    expect(read.addedRanges.get("a.ts")).toEqual([{ start: 2, end: 2 }]);
    expect(read.addedRanges.get("new.ts")).toEqual([{ start: 1, end: 2 }]);
  });

  it("listed root-relative files read their added lines, and an unchanged one is read whole", async () => {
    const read = await readDiffScope(sub, { files: ["a.ts", "c.ts"] });
    expect(read.changedFiles).toBe(1);
    expect(read.wholeFiles).toBe(1);
    expect(read.addedRanges.get("a.ts")).toEqual([{ start: 2, end: 2 }]);
    expect(read.addedRanges.get("c.ts")).toEqual([{ start: 1, end: Number.MAX_SAFE_INTEGER }]);
  });

  it("reads the tree's HEAD at the git toplevel for the lag", () => {
    const registry = { get: () => ({ git: { indexedCommit: "0".repeat(40) } }) } as unknown as CollectionRegistry;
    expect(readTreeLag(registry, "c", sub)).toEqual({
      indexedCommit: "0".repeat(40),
      treeCommit: fixture.git(fixture.mainRoot, "rev-parse", "HEAD").trim(),
    });
  });
});
