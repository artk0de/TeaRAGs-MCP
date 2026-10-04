/**
 * bd tea-rags-mcp-i6tkc — every `git.file` counter is a WINDOW figure, for
 * every file and on every path that computes it.
 *
 * The file phase reads the `logMaxAgeMonths` window. A file no commit touched
 * inside it (a DORMANT file) used to get no overlay there; the backfill then
 * walked its WHOLE history, so on a live index files untouched for years read
 * lifetime commitCount / churn / bugFixRate beside the window figures every
 * active file carries, and inflated every churn percentile. The invariant now:
 *
 * - the live file phase stamps a dormant file itself — window counters are a
 *   zero observation, the age stamps (lastModifiedAt, firstCreatedAt,
 *   lastCommitHash, ageDays) are exact and follow renames;
 * - bugFixRate of a zero-commit file is ABSENT, never a "healthy" 0;
 * - recovery / backfill (`buildFileSignals({ paths })`) answers with the same
 *   window semantics, never a lifetime walk.
 *
 * Production path end to end: real `GitCliAdapter`, real discovery store.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importGitHistory } from "../../../__helpers__/git-history-import.js";
import { GitCliAdapter } from "../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { BlameLine } from "../../../../../src/core/adapters/vcs/types.js";
import { GitEnrichmentProvider } from "../../../../../src/core/domains/trajectory/git/provider.js";
import type { GitFileSignals } from "../../../../../src/core/domains/trajectory/git/types.js";

// The file phase blames on a worker-thread pool whose worker runs
// `adapter.blameFile` — run in-thread here so the test needs no compiled worker.
vi.mock("../../../../../src/core/domains/trajectory/git/infra/churn-walk/blame-pool.js", () => ({
  BlameWorkerPool: vi.fn(function () {
    return {
      blame: async (root: string, _kind: string, files: { relPath: string }[], timeoutMs: number) => {
        const adapter = new GitCliAdapter(root);
        const out = new Map<string, BlameLine[]>();
        for (const { relPath } of files) out.set(relPath, await adapter.blameFile(relPath, timeoutMs));
        return out;
      },
      close: async () => undefined,
    };
  }),
}));

vi.setConfig({ testTimeout: 60_000 });

const TMP_BASE = realpathSync(tmpdir());
const DAY = 86_400_000;
const NOW = Date.now();
const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();
const epochOf = (daysAgo: number): number => Math.floor((NOW - daysAgo * DAY) / 1000);

const DORMANT = "src/dormant.ts";
const ACTIVE = "src/active.ts";
const UNTRACKED = "src/untracked.ts";
const LINES = 3;

describe("GitEnrichmentProvider — window-only git.file counters (bd tea-rags-mcp-i6tkc)", () => {
  let repo: string;
  let shas: Record<string, string>;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "window-only-counters-")));
    if (!resolve(repo).startsWith(TMP_BASE + sep)) throw new Error(`refusing git outside the temp root: ${repo}`);
    const alice = { name: "alice", email: "alice@x" };
    const bob = { name: "bob", email: "bob@x" };
    shas = importGitHistory(repo, [
      {
        label: "created",
        message: "feat: add legacy module",
        author: alice,
        authorDate: at(900),
        writes: { "src/legacy.ts": "export const a = 1;\n", [ACTIVE]: "export const b = 1;\n" },
      },
      {
        message: "fix: legacy crash",
        author: bob,
        authorDate: at(800),
        writes: { "src/legacy.ts": "export const a = 2;\n" },
      },
      {
        label: "moved",
        message: "refactor: move legacy",
        author: bob,
        authorDate: at(700),
        renames: [["src/legacy.ts", DORMANT]],
      },
      { message: "fix: active bug", author: alice, authorDate: at(30), writes: { [ACTIVE]: "export const b = 2;\n" } },
      {
        message: "feat: active feature",
        author: bob,
        authorDate: at(10),
        writes: { [ACTIVE]: "export const b = 3;\n" },
      },
    ]);
    writeFileSync(join(repo, UNTRACKED), "export const c = 1;\n");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const newProvider = (): GitEnrichmentProvider =>
    new GitEnrichmentProvider({
      vcsAdapter: "git",
      logMaxAgeMonths: 12,
      logTimeoutMs: 30_000,
      chunkConcurrency: 4,
      blamePoolSize: 1,
      chunkMaxAgeMonths: 6,
      chunkTimeoutMs: 30_000,
      chunkMaxFileLines: 5000,
    });

  const signalsOf = (provider: GitEnrichmentProvider, overlays: Map<string, unknown>): Map<string, GitFileSignals> =>
    new Map(
      [...overlays].map(([path, data]) => [
        path,
        provider.fileSignalTransform?.(data as never, LINES) as unknown as GitFileSignals,
      ]),
    );

  it("stamps a dormant file in the live file phase: zero window counters, exact rename-following age stamps", async () => {
    const provider = newProvider();
    try {
      const signals = signalsOf(provider, await provider.streamFileBatch(repo, [DORMANT, ACTIVE, UNTRACKED]));

      const dormant = signals.get(DORMANT);
      expect(dormant).toBeDefined();
      expect(dormant).toMatchObject({
        commitCount: 0,
        linesAdded: 0,
        linesDeleted: 0,
        fileChurnCount: 0,
        relativeChurn: 0,
        recencyWeightedFreq: 0,
        changeDensity: 0,
        churnVolatility: 0,
        recentContributorCount: 0,
        recentAuthors: [],
        taskIds: [],
        // Exact, from the whole history: last touched by the rename, created
        // 900 days ago under its former name.
        lastModifiedAt: epochOf(700),
        firstCreatedAt: epochOf(900),
        lastCommitHash: shas.moved,
        ageDays: 700,
      });
      // A zero-commit file has no bug-fix rate — not a healthy 0.
      expect(dormant).not.toHaveProperty("bugFixRate");
      // Blame describes HEAD's lines, which the window does not bound.
      expect(dormant?.blameDominantAuthor).toBe("bob");

      // An active file counts only its in-window commits — the 900-day-old
      // creation is outside the window.
      expect(signals.get(ACTIVE)).toMatchObject({ commitCount: 2, bugFixRate: 50, lastModifiedAt: epochOf(10) });
      // Never committed: nothing to say.
      expect(signals.has(UNTRACKED)).toBe(false);
    } finally {
      await provider.finalizeSignals();
    }
  });

  it("answers recovery / backfill with the same window semantics, never a lifetime walk", async () => {
    const streaming = newProvider();
    const recovering = newProvider();
    try {
      const streamed = signalsOf(streaming, await streaming.streamFileBatch(repo, [DORMANT, ACTIVE, UNTRACKED]));
      const recovered = signalsOf(
        recovering,
        await recovering.buildFileSignals(repo, { paths: [DORMANT, ACTIVE, UNTRACKED] }),
      );

      expect(recovered.get(DORMANT)).toMatchObject({ commitCount: 0, linesAdded: 0, lastModifiedAt: epochOf(700) });
      expect(recovered.get(DORMANT)).not.toHaveProperty("bugFixRate");
      expect(recovered).toEqual(streamed);
    } finally {
      await streaming.finalizeSignals();
      await recovering.finalizeSignals();
    }
  });
});
