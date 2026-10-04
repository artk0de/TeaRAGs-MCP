/**
 * bd tea-rags-mcp-i6tkc, part 2 — `TRAJECTORY_GIT_ANCHOR=head` measures every
 * git window and age from the HEAD commit's committer time instead of the
 * wall clock, so a historical snapshot (a benchmark corpus whose HEAD is years
 * old) gets the signals it had on the day of that HEAD. With the default
 * `now`, the same snapshot is one big dormant tree: every window is empty.
 *
 * Production path end to end: real `GitCliAdapter`, real discoveries.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importGitHistory } from "../../../__helpers__/git-history-import.js";
import { GitCliAdapter } from "../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { BlameLine } from "../../../../../src/core/adapters/vcs/types.js";
import { buildOnDemandGitSignals } from "../../../../../src/core/domains/trajectory/git/infra/on-demand-signals.js";
import { GitEnrichmentProvider } from "../../../../../src/core/domains/trajectory/git/provider.js";
import type { ChunkChurnOverlay, GitFileSignals } from "../../../../../src/core/domains/trajectory/git/types.js";

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

const ENGINE = "src/engine.ts";
const OLD = "src/old.ts";
const ANCIENT = "src/ancient.ts";
const engine = (v: number): string => `export function step(): number {\n  return ${v};\n}\n`;

describe("GitEnrichmentProvider — TRAJECTORY_GIT_ANCHOR (bd tea-rags-mcp-i6tkc)", () => {
  let repo: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "history-anchor-")));
    if (!resolve(repo).startsWith(TMP_BASE + sep)) throw new Error(`refusing git outside the temp root: ${repo}`);
    mkdirSync(join(repo, "src"));
    const who = { name: "alice", email: "alice@x" };
    // A snapshot whose HEAD is ~7.8 years old.
    importGitHistory(repo, [
      { message: "feat: ancient", author: who, authorDate: at(3500), writes: { [ANCIENT]: "export const a = 1;\n" } },
      { message: "feat: old", author: who, authorDate: at(3000), writes: { [OLD]: "export const o = 1;\n" } },
      { message: "feat: engine", author: who, authorDate: at(2900), writes: { [ENGINE]: engine(1) } },
      { message: "fix: engine", author: who, authorDate: at(2850), writes: { [ENGINE]: engine(2) } },
    ]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const run = async (
    anchor: "now" | "head",
  ): Promise<{ file: Map<string, GitFileSignals>; chunk?: ChunkChurnOverlay }> => {
    const provider = new GitEnrichmentProvider({
      vcsAdapter: "git",
      logMaxAgeMonths: 12,
      logTimeoutMs: 30_000,
      chunkConcurrency: 4,
      blamePoolSize: 1,
      chunkMaxAgeMonths: 6,
      chunkTimeoutMs: 30_000,
      chunkMaxFileLines: 5000,
      anchor,
    });
    try {
      const overlays = await provider.streamFileBatch(repo, [ENGINE, OLD, ANCIENT]);
      const file = new Map(
        [...overlays].map(([path, data]) => [
          path,
          provider.fileSignalTransform?.(data, 3) as unknown as GitFileSignals,
        ]),
      );
      const chunks = await provider.buildChunkSignals(
        repo,
        new Map([[ENGINE, [{ chunkId: "step", startLine: 1, endLine: 3 }]]]),
        { skipCache: true, commitDiscovery: provider.createCommitDiscovery(repo) },
      );
      return { file, chunk: chunks.get(ENGINE)?.get("step") as ChunkChurnOverlay | undefined };
    } finally {
      await provider.finalizeSignals();
    }
  };

  it("head: every window and age is measured from the HEAD commit's committer time", async () => {
    const { file, chunk } = await run("head");

    expect(file.get(ENGINE)).toMatchObject({ commitCount: 2, bugFixRate: 50, ageDays: 0 });
    expect(file.get(ENGINE)?.recencyWeightedFreq).toBeGreaterThan(1);
    // 150 days before HEAD: inside the 12-month file window.
    expect(file.get(OLD)).toMatchObject({ commitCount: 1, ageDays: 150 });
    // 650 days before HEAD: dormant relative to HEAD, aged from HEAD.
    expect(file.get(ANCIENT)).toMatchObject({ commitCount: 0, ageDays: 650 });
    // The chunk walk's 6-month window ends at HEAD too.
    expect(chunk).toMatchObject({ commitCount: 2, ageDays: 0 });
    expect(chunk?.recencyWeightedFreq).toBeGreaterThan(1);
  });

  it("now (default): the same snapshot is dormant — windows end at the wall clock", async () => {
    const { file, chunk } = await run("now");

    expect(file.get(ENGINE)).toMatchObject({ commitCount: 0, ageDays: 2850 });
    expect(file.get(ANCIENT)).toMatchObject({ commitCount: 0, ageDays: 3500 });
    expect(chunk).toMatchObject({ commitCount: 0 });
  });

  it("on-demand (working-tree) signals read the same anchor an index run does", async () => {
    const onDemand = async (anchor?: "head") =>
      buildOnDemandGitSignals(
        new GitCliAdapter(repo),
        [
          {
            relPath: ENGINE,
            lineCount: 3,
            fileSignals: true,
            workingContent: engine(2),
            chunks: [{ chunkId: "step", startLine: 1, endLine: 3 }],
          },
        ],
        {
          timeoutMs: 30_000,
          file: { maxAgeMonths: 12 },
          chunk: { maxAgeMonths: 6, timeoutMs: 30_000, maxFileLines: 5000, concurrency: 4 },
          ...(anchor ? { anchor } : {}),
        },
      );

    const head = (await onDemand("head")).get(ENGINE);
    expect(head?.file).toMatchObject({ commitCount: 2, bugFixRate: 50, ageDays: 0 });
    expect(head?.chunks.get("step")).toMatchObject({ commitCount: 2, ageDays: 0 });

    const unanchored = (await onDemand()).get(ENGINE);
    expect(unanchored?.file).toMatchObject({ commitCount: 0, ageDays: 2850 });
    expect(unanchored?.chunks.get("step")).toMatchObject({ commitCount: 0 });
  });
});
