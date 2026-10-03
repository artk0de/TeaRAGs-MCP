/**
 * bd tea-rags-mcp-xi2r9 (round-4 P2/P3) — the chunk walk maps each commit's
 * hunks onto ranges carried back through every NEWER commit, so it must visit a
 * file's commits in HISTORY order (newest → oldest as `git log` lists them),
 * never by author timestamp.
 *
 * A commit's author date says nothing about where it sits in history: a rebased
 * or backdated commit on top of HEAD carries a date older than the commits
 * below it, and commits made within one second tie. Sorted by author date, the
 * walk applied an OLDER commit's offsets before a newer commit's hunks were
 * mapped: a function a backdated commit appended got `commitCount: 0`, and ties
 * credited a neighbour with a commit `git log -L` never lists for it.
 *
 * Oracle: `git log -L<start>,<end>:<file>` per HEAD range. Production path end
 * to end: real `GitCliAdapter`, real `GitCommitDiscovery`, real cat-file.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { copyGitRepoTemplate } from "../../../../__helpers__/git-repo-template.js";
import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import { buildChunkChurnMapUncached } from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import { GitCommitDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";

vi.setConfig({ testTimeout: 30000 });

const TMP_BASE = realpathSync(tmpdir());
const FILE = "src/user.ts";

const isoDaysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

describe("chunk walk visits commits in history order", () => {
  let repo: string;

  const git = (args: string[], dates: { author: string; committer: string }): string => {
    if (!resolve(repo).startsWith(TMP_BASE + sep)) throw new Error(`refusing git outside the temp root: ${repo}`);
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@x",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@x",
        GIT_AUTHOR_DATE: dates.author,
        GIT_COMMITTER_DATE: dates.committer,
      },
    }).trim();
  };
  /** Commits `content` as {@link FILE}; the sha is read only by callers that need it. */
  const commitFile = (content: string, message: string, dates: { author: string; committer: string }): void => {
    writeFileSync(join(repo, FILE), content);
    git(["add", "-A"], dates);
    git(["commit", "-q", "-m", message], dates);
  };
  const commit = (content: string, message: string, dates: { author: string; committer: string }): string => {
    commitFile(content, message, dates);
    return git(["rev-parse", "HEAD"], dates);
  };
  const oracle = (start: number, end: number): string[] =>
    git(["log", "--format=%H", `-L${start},${end}:${FILE}`], { author: isoDaysAgo(0), committer: isoDaysAgo(0) })
      .split("\n")
      .filter((line) => /^[0-9a-f]{40}$/.test(line));

  const walk = async (ranges: Record<string, [number, number]>) => {
    const adapter = new GitCliAdapter(repo);
    const chunkMap = new Map([
      [
        join(repo, FILE),
        Object.entries(ranges).map(([chunkId, [startLine, endLine]]) => ({ chunkId, startLine, endLine })),
      ],
    ]);
    const discovery = new GitCommitDiscovery(adapter, { maxAgeMonths: 12, timeoutMs: 30000 });
    const overlays = await buildChunkChurnMapUncached(
      adapter,
      chunkMap,
      {},
      4,
      12,
      undefined,
      undefined,
      30000,
      5000,
      undefined,
      undefined,
      undefined,
      undefined,
      discovery,
    );
    return overlays.get(FILE);
  };

  /** An empty repository with `src/` laid out at `root`. */
  const initRepo = (root: string): void => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    mkdirSync(join(root, "src"));
  };

  /** A fresh empty repository of this test's own. */
  const freshRepo = (): void => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "walk-log-order-")));
    initRepo(repo);
  };

  // Five rows, then a function appended at rows 7-10 — the r4t `user.ts` shape.
  const BASE = 'import { x } from "./x";\n\nexport function a(): number {\n  return x + 1;\n}\n';
  const EDITED = BASE.replace("x + 1", "x + 10");
  const APPENDED = `${EDITED}\nexport function appended(): number {\n  // appended last\n  return 2;\n}\n`;

  /**
   * `init` (BASE) then `edit a` (EDITED), both dated a day ago — the history the
   * backdated and the rebased cases append to. Built once per process and copied
   * per test (bd tea-rags-mcp-2z4sa).
   */
  const recentBaseThenEdited = (): void => {
    const copy = copyGitRepoTemplate(
      "walk-log-order-recent-base-edited",
      (root) => {
        repo = root;
        initRepo(root);
        const recent = { author: isoDaysAgo(1), committer: isoDaysAgo(1) };
        commitFile(BASE, "init", recent);
        commitFile(EDITED, "edit a", recent);
      },
      { prefix: "walk-log-order-" },
    );
    repo = realpathSync(copy.root);
  };

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("credits a function to the backdated commit on top of HEAD that appended it", async () => {
    recentBaseThenEdited();
    // Committed last, dated before everything below it.
    const backdated = commit(APPENDED, "append", { author: isoDaysAgo(9), committer: isoDaysAgo(9) });

    const overlays = await walk({ a: [3, 5], appended: [7, 10] });

    expect(oracle(7, 10)).toEqual([backdated]);
    expect(overlays?.get("appended")).toMatchObject({ commitCount: 1 });
    expect(overlays?.get("a")).toMatchObject({ commitCount: oracle(3, 5).length });
  });

  it("credits a rebased commit (old author date, new committer date) the way git log -L does", async () => {
    recentBaseThenEdited();
    const rebased = commit(APPENDED, "append", { author: isoDaysAgo(9), committer: isoDaysAgo(0) });

    const overlays = await walk({ a: [3, 5], appended: [7, 10] });

    expect(oracle(7, 10)).toEqual([rebased]);
    expect(overlays?.get("appended")).toMatchObject({ commitCount: 1 });
    expect(overlays?.get("a")).toMatchObject({ commitCount: oracle(3, 5).length });
  });

  it("keeps commits made within one second in history order", async () => {
    // One timestamp for every commit: only history order separates them.
    freshRepo();
    const same = { author: isoDaysAgo(2), committer: isoDaysAgo(2) };
    commitFile(BASE, "init", same);
    for (let i = 2; i <= 6; i++) commitFile(BASE.replace("x + 1", `x + ${i}`), `edit a ${i}`, same);
    const inserted = BASE.replace("x + 1", "x + 6").replace(
      "export function a",
      "export function zebra(): number {\n  // inserted above a\n  return 42;\n}\n\nexport function a",
    );
    commitFile(inserted, "insert zebra", same);

    const overlays = await walk({ zebra: [3, 6], a: [8, 10] });

    expect(oracle(3, 6)).toHaveLength(1);
    expect(overlays?.get("zebra")).toMatchObject({ commitCount: 1 });
    expect(overlays?.get("a")).toMatchObject({ commitCount: oracle(8, 10).length });
  });
});
