/**
 * bd tea-rags-mcp-aikfk — FILE-level git churn follows renames.
 *
 * z8w16 taught the chunk walk to credit pre-rename commits to the HEAD path;
 * the file side still aggregated each commit under the path it recorded, so a
 * directory rename reset every moved file to `commitCount: 1` (the rename
 * commit alone) while its chunks kept 20-30 commits. This suite pins the file
 * side against a real repo:
 *
 * - the repo-wide discovery (`FileChurnDiscovery#fileChurn`, cold AND warm
 *   top-up) and the per-path backfill (`buildFileSignalsForPaths`) attribute
 *   every commit to the file's HEAD path — N pre-rename commits + the rename
 *   commit + M post-rename commits, which is what `git log --follow` lists;
 * - an old path RE-CREATED after the rename keeps only its own history;
 * - the backfill, whose pathspec hides the rename's source side, widens to the
 *   predecessor path and returns the same answer as the discovery;
 * - authorship, firstCreatedAt, bugFixRate and the squash-aware session count
 *   span the whole history.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyGitRepoTemplate } from "../../../../__helpers__/git-repo-template.js";
import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { CommitFileNumstat, FileChurnData } from "../../../../../../src/core/adapters/vcs/types.js";
import {
  FileChurnDiscovery,
  type FileChurnDiscoveryPersistence,
  type PersistedFileChurnDiscovery,
} from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery.js";
import { buildFileSignalsForPaths } from "../../../../../../src/core/domains/trajectory/git/infra/file-reader.js";
import { assembleFileSignals } from "../../../../../../src/core/domains/trajectory/git/infra/metrics/file-assembler.js";

const TMP_BASE = realpathSync(tmpdir());
const TIMEOUT_MS = 30000;
const WINDOW_MONTHS = 12;

function daysAgoIso(days: number, minutes = 0): string {
  return new Date(Date.now() - days * 86400 * 1000 + minutes * 60 * 1000).toISOString();
}

function gitIn(cwd: string, args: string[], isoDate: string, author = "Alice"): string {
  const r = resolve(cwd);
  if (!r.startsWith(TMP_BASE + sep)) {
    throw new Error(`file-churn-rename-following.test: refusing git "${args[0]}" in non-temp cwd: ${cwd}`);
  }
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.com`,
    },
  }).trim();
}

/** In-memory persistence tier — the real store's contract without the disk. */
function memoryStore(): FileChurnDiscoveryPersistence {
  const snapshots: PersistedFileChurnDiscovery[] = [];
  return {
    load: (repoRoot, head) => snapshots.find((s) => s.repoRoot === repoRoot && s.head === head) ?? null,
    loadLatest: (repoRoot) => snapshots.filter((s) => s.repoRoot === repoRoot).at(-1) ?? null,
    save: (repoRoot, head, sinceIso, entries: CommitFileNumstat[]) => {
      snapshots.push({ version: 2, repoRoot, head, sinceIso, entries });
    },
  };
}

const shasOf = (churn: FileChurnData | undefined): string[] => (churn?.commits ?? []).map((c) => c.sha);

describe("file-level git churn follows renames (bd tea-rags-mcp-aikfk)", () => {
  let tmp: string;
  let adapter: GitCliAdapter;
  const sha: Record<string, string> = {};

  const commitIn = (
    repo: string,
    shas: Record<string, string>,
    label: string,
    message: string,
    days: number,
    author: string,
    minutes = 0,
  ): void => {
    const date = daysAgoIso(days, minutes);
    gitIn(repo, ["add", "-A"], date, author);
    gitIn(repo, ["commit", "-q", "-m", message], date, author);
    shas[label] = gitIn(repo, ["rev-parse", "HEAD"], date, author);
  };

  /** c1-c3 under Old/ — the template recipe; returns the shas it committed. */
  const buildPreRenameIn = (repo: string): Record<string, string> => {
    const shas: Record<string, string> = {};
    const commit = (label: string, message: string, days: number, author: string, minutes = 0): void => {
      commitIn(repo, shas, label, message, days, author, minutes);
    };
    const g = (args: string[]): string => gitIn(repo, args, daysAgoIso(60));
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "Test"]);
    g(["config", "commit.gpgsign", "false"]);
    g(["config", "diff.algorithm", "myers"]);

    mkdirSync(join(repo, "Old"));
    writeFileSync(join(repo, "Old/f.txt"), "a\nb\nc\n");
    commit("c1", "feat: add f", 60, "Alice");
    writeFileSync(join(repo, "Old/f.txt"), "a\nB\nc\n");
    commit("c2", "fix: correct b", 50, "Alice");
    // Five minutes after c2, same author — one squash-aware session with c2.
    writeFileSync(join(repo, "Old/f.txt"), "a\nB\nc\nd\n");
    commit("c3", "feat: add d", 50, "Alice", 5);
    return shas;
  };

  /** The directory rename, then M=2 commits under New/ and a re-creation of
   *  Old/f.txt between them. */
  const buildRenameAndAfterIn = (repo: string, shas: Record<string, string>): void => {
    const commit = (label: string, message: string, days: number, author: string): void => {
      commitIn(repo, shas, label, message, days, author);
    };
    gitIn(repo, ["mv", "Old", "New"], daysAgoIso(30), "Bob");
    commit("mv", "refactor: rename Old to New", 30, "Bob");
    writeFileSync(join(repo, "New/f.txt"), "a\nB\nc\nd\ne\n");
    commit("c5", "feat: add e", 20, "Carol");
    mkdirSync(join(repo, "Old"));
    writeFileSync(join(repo, "Old/f.txt"), "fresh\n");
    commit("c6", "feat: unrelated file reusing the old name", 10, "Carol");
    writeFileSync(join(repo, "New/f.txt"), "a\nB\nc\nd\ne\nf\n");
    commit("c7", "feat: add f line", 5, "Carol");
  };

  /**
   * Points `tmp`, `adapter` and `sha` at a fresh copy of a template repository
   * (bd tea-rags-mcp-2z4sa): every test reads the same history, so it is built
   * once per process instead of once per test.
   */
  const useTemplate = (key: string, build: (repo: string) => Record<string, string>): void => {
    const copy = copyGitRepoTemplate(key, build, { prefix: "git-filechurn-rename-" });
    // `gitIn` guards the symlink-free `TMP_BASE`; the copy root is named under `tmpdir()`.
    tmp = realpathSync(copy.root);
    adapter = new GitCliAdapter(tmp);
    for (const label of Object.keys(sha)) delete sha[label];
    Object.assign(sha, copy.meta);
  };

  /** The repository at c3, before the rename. */
  const buildPreRename = (): void => {
    useTemplate("aikfk-pre-rename", buildPreRenameIn);
  };

  /** Continues the current copy past the rename. */
  const buildRenameAndAfter = (): void => {
    buildRenameAndAfterIn(tmp, sha);
  };

  /** The full history: c1-c3, the rename, c5-c7. */
  const buildRenamedHistory = (): void => {
    useTemplate("aikfk-full", (repo) => {
      const shas = buildPreRenameIn(repo);
      buildRenameAndAfterIn(repo, shas);
      return shas;
    });
  };

  const expectedNewShas = (): string[] => [sha.c7, sha.c5, sha.mv, sha.c3, sha.c2, sha.c1];

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("discovery credits every pre-rename commit to the HEAD path and keeps a re-created old path apart", async () => {
    buildRenamedHistory();

    const churn = await new FileChurnDiscovery(adapter, {
      maxAgeMonths: WINDOW_MONTHS,
      timeoutMs: TIMEOUT_MS,
    }).fileChurn();

    const renamed = churn.get("New/f.txt");
    // N=3 pre-rename + the rename commit + M=2 post-rename = `git log --follow`.
    expect(shasOf(renamed)).toEqual(expectedNewShas());
    expect(renamed?.linesAdded).toBe(3 + 1 + 1 + 0 + 1 + 1);
    expect(renamed?.linesDeleted).toBe(1);
    // The re-created Old/f.txt is a different file: only its own commit.
    expect(shasOf(churn.get("Old/f.txt"))).toEqual([sha.c6]);
    expect(churn.get("Old/f.txt")?.linesAdded).toBe(1);
  });

  it("file signals span the whole history, including the squash-aware session count", async () => {
    buildRenamedHistory();

    const churn = await new FileChurnDiscovery(adapter, {
      maxAgeMonths: WINDOW_MONTHS,
      timeoutMs: TIMEOUT_MS,
    }).fileChurn();
    const renamed = churn.get("New/f.txt")!;

    const perCommit = assembleFileSignals(renamed, 6);
    expect(perCommit.commitCount).toBe(6);
    expect(new Set(perCommit.recentAuthors)).toEqual(new Set(["Alice", "Bob", "Carol"]));
    expect(perCommit.firstCreatedAt).toBe(renamed.commits.at(-1)?.timestamp);
    expect(renamed.commits.at(-1)?.sha).toBe(sha.c1);
    expect(perCommit.bugFixRate).toBe(Math.round((1 / 6) * 100));

    // c2 + c3 (Alice, 5 minutes apart) collapse into one session.
    const sessions = assembleFileSignals(renamed, 6, { squashAwareSessions: true, sessionGapMinutes: 30 });
    expect(sessions.commitCount).toBe(5);
  });

  it("a warm top-up whose prior snapshot holds the pre-rename commits merges them into the HEAD path", async () => {
    buildPreRename();
    const store = memoryStore();
    // Cold run at c3: the persisted entries name the file Old/f.txt.
    const before = await new FileChurnDiscovery(adapter, {
      maxAgeMonths: WINDOW_MONTHS,
      timeoutMs: TIMEOUT_MS,
      store,
    }).fileChurn();
    expect(shasOf(before.get("Old/f.txt"))).toEqual([sha.c3, sha.c2, sha.c1]);

    buildRenameAndAfter();
    const warm = await new FileChurnDiscovery(adapter, {
      maxAgeMonths: WINDOW_MONTHS,
      timeoutMs: TIMEOUT_MS,
      store,
    }).fileChurn();
    const cold = await new FileChurnDiscovery(adapter, {
      maxAgeMonths: WINDOW_MONTHS,
      timeoutMs: TIMEOUT_MS,
    }).fileChurn();

    expect(shasOf(warm.get("New/f.txt"))).toEqual(expectedNewShas());
    expect(shasOf(warm.get("Old/f.txt"))).toEqual([sha.c6]);
    expect(warm).toEqual(cold);
  });

  it("the per-path backfill widens to the predecessor path and matches the discovery", async () => {
    buildRenamedHistory();

    const discovery = await new FileChurnDiscovery(adapter, {
      maxAgeMonths: WINDOW_MONTHS,
      timeoutMs: TIMEOUT_MS,
    }).fileChurn();

    // HEAD path alone: the pathspec reports the rename as a plain add, so the
    // backfill must recover the predecessor itself.
    const newOnly = await buildFileSignalsForPaths(adapter, ["New/f.txt"], TIMEOUT_MS);
    expect([...newOnly.keys()]).toEqual(["New/f.txt"]);
    expect(newOnly.get("New/f.txt")).toEqual(discovery.get("New/f.txt"));

    // The re-created old path alone: its pathspec shows the rename as a
    // deletion; the renamed file's history must not leak into it.
    const oldOnly = await buildFileSignalsForPaths(adapter, ["Old/f.txt"], TIMEOUT_MS);
    expect([...oldOnly.keys()]).toEqual(["Old/f.txt"]);
    expect(oldOnly.get("Old/f.txt")).toEqual(discovery.get("Old/f.txt"));

    const both = await buildFileSignalsForPaths(adapter, ["New/f.txt", "Old/f.txt"], TIMEOUT_MS);
    expect(both.get("New/f.txt")).toEqual(discovery.get("New/f.txt"));
    expect(both.get("Old/f.txt")).toEqual(discovery.get("Old/f.txt"));
  });
});
