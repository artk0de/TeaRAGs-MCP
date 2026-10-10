/**
 * bd tea-rags-mcp-89k7k.35.22 — `buildOnDemandGitSignals` shares per-call git
 * state instead of re-spawning it, and the answer does not move:
 * - S2: with a file window containing the chunk window, the chunk walk's
 *   commits are sliced from the file walk's read; the result deep-equals the
 *   one computed with every chunk-window read going to git, on a history with
 *   a rename, a `fix/*` merge and commits on both sides of the chunk window;
 * - S3: a HEAD handed in is used, never re-resolved;
 * - S4: one blob reader per call, closed exactly once — also when the walk
 *   throws.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importGitHistory } from "../../../../__helpers__/git-history-import.js";
import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { BlobBatchReader } from "../../../../../../src/core/adapters/vcs/index.js";
import type { FileChurnDiscoveryPersistence } from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery.js";
import {
  buildOnDemandGitSignals,
  type OnDemandGitSignalOptions,
  type OnDemandGitSignalTarget,
} from "../../../../../../src/core/domains/trajectory/git/infra/on-demand-signals.js";
import * as pathspecReads from "../../../../../../src/core/domains/trajectory/git/infra/pathspec-numstat-reads.js";

vi.mock("../../../../../../src/core/domains/trajectory/git/infra/pathspec-numstat-reads.js", async (importOriginal) =>
  importOriginal(),
);

vi.setConfig({ testTimeout: 60_000 });

const DAY = 86_400_000;
const NOW = Date.now();
const at = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();
const who = { name: "T", email: "t@x" };
const other = { name: "O", email: "o@x" };
const body = (n: number): string =>
  `${Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i === n % 20 ? n * 100 : i};`).join("\n")}\n`;

/** Adapter numstat reads over a window other than the file walk's (its first read). */
function chunkWindowReads(calls: [string[], number?, Date?][]): number {
  const fileSince = calls[0]?.[2]?.getTime();
  return calls.filter(([, , since]) => since?.getTime() !== fileSince).length;
}

const NO_SNAPSHOT: FileChurnDiscoveryPersistence = { load: () => null, loadLatest: () => null, save: () => {} };
const OPTIONS: OnDemandGitSignalOptions = {
  timeoutMs: 30_000,
  file: { maxAgeMonths: 12 },
  chunk: { maxAgeMonths: 6, timeoutMs: 30_000, maxFileLines: 5000, concurrency: 4 },
  churnStore: NO_SNAPSHOT,
};

describe("buildOnDemandGitSignals — per-call git state sharing (89k7k.35.22)", () => {
  let repo: string;
  let targets: OnDemandGitSignalTarget[];

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "on-demand-sharing-")));
    mkdirSync(join(repo, "src"));
    importGitHistory(repo, [
      // File window only (> 180 days): the add, the rename, an edit.
      { label: "add", message: "add old", author: who, authorDate: at(300), writes: { "src/old.ts": body(1) } },
      { message: "move old", author: who, authorDate: at(260), renames: [["src/old.ts", "src/c.ts"]] },
      { message: "feat: c", author: other, authorDate: at(200), writes: { "src/c.ts": body(2) } },
      // Chunk window: a fix branch merged with a fix/* merge, a mainline edit.
      { label: "side", message: "feat: d", author: who, authorDate: at(160), writes: { "src/d.ts": body(3) } },
      {
        label: "fix",
        branch: "fix/c-off-by-one",
        from: "side",
        message: "correct c",
        author: other,
        authorDate: at(150),
        writes: { "src/c.ts": body(4) },
      },
      {
        label: "main2",
        from: "side",
        message: "feat: d 2",
        author: who,
        authorDate: at(145),
        writes: { "src/d.ts": body(5) },
      },
      {
        from: "main2",
        merge: ["fix"],
        message: "Merge branch 'fix/c-off-by-one'",
        author: who,
        authorDate: at(140),
        writes: { "src/c.ts": body(4) },
      },
      { message: "fix: c late", author: who, authorDate: at(30), writes: { "src/c.ts": body(6) } },
      { message: "feat: d 3", author: other, authorDate: at(20), writes: { "src/d.ts": body(7) } },
    ]);
    const edited = (n: number): string => `${body(n)}export const fresh = 0;\n`;
    targets = [
      {
        relPath: "src/c.ts",
        lineCount: 21,
        fileSignals: true,
        workingContent: edited(6),
        chunks: [
          { chunkId: "c-head", startLine: 1, endLine: 10 },
          { chunkId: "c-tail", startLine: 11, endLine: 20 },
          { chunkId: "c-fresh", startLine: 21, endLine: 21 },
        ],
      },
      {
        relPath: "src/d.ts",
        lineCount: 20,
        fileSignals: true,
        workingContent: body(7),
        chunks: [{ chunkId: "d-all", startLine: 1, endLine: 20 }],
      },
      {
        relPath: "src/new.ts",
        lineCount: 2,
        fileSignals: true,
        workingContent: "a\nb\n",
        chunks: [{ chunkId: "n", startLine: 1, endLine: 2 }],
      },
    ];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(repo, { recursive: true, force: true });
  });

  it("slicing the chunk window out of the file walk's read answers exactly what reading it again does", async () => {
    const adapter = new GitCliAdapter(repo);
    const sliced = await buildOnDemandGitSignals(adapter, targets, OPTIONS);

    const create = pathspecReads.createPathspecNumstatReads;
    const spy = vi.spyOn(pathspecReads, "createPathspecNumstatReads").mockImplementation((a) => {
      const reads = create(a);
      return { ...reads, sliceFor: () => undefined };
    });
    const readEach = vi.spyOn(adapter, "readCommitFileNumstatForPaths");
    const reread = await buildOnDemandGitSignals(adapter, targets, OPTIONS);

    expect(spy).toHaveBeenCalled();
    // The control really read the chunk window from git.
    expect(chunkWindowReads(readEach.mock.calls)).toBeGreaterThan(0);
    // Only the two chunk-window commits on c's first rows; the merge carries no rows.
    expect(sliced.get("src/c.ts")?.chunks.get("c-head")).toMatchObject({ commitCount: 2 });
    expect(sliced).toEqual(reread);
  });

  it("reads no chunk-window log when the file window contains the chunk window", async () => {
    const adapter = new GitCliAdapter(repo);
    const readEach = vi.spyOn(adapter, "readCommitFileNumstatForPaths");

    await buildOnDemandGitSignals(adapter, targets, OPTIONS);

    expect(readEach.mock.calls.length).toBeGreaterThan(0);
    expect(chunkWindowReads(readEach.mock.calls)).toBe(0);
  });

  it("reads the chunk window from git when the file window is narrower", async () => {
    const adapter = new GitCliAdapter(repo);
    const readEach = vi.spyOn(adapter, "readCommitFileNumstatForPaths");

    await buildOnDemandGitSignals(adapter, targets, { ...OPTIONS, file: { maxAgeMonths: 3 } });

    expect(chunkWindowReads(readEach.mock.calls)).toBeGreaterThan(0);
  });

  it("uses a HEAD handed in and never resolves one", async () => {
    const adapter = new GitCliAdapter(repo);
    const head = await adapter.getHead();
    const getHead = vi.spyOn(adapter, "getHead");

    const answered = await buildOnDemandGitSignals(adapter, targets, { ...OPTIONS, head });

    expect(getHead).not.toHaveBeenCalled();
    expect(answered).toEqual(await buildOnDemandGitSignals(new GitCliAdapter(repo), targets, OPTIONS));
  });

  it("opens one blob reader for the carry and both walks, and closes it once", async () => {
    const adapter = new GitCliAdapter(repo);
    const opened: BlobBatchReader[] = [];
    const closes = vi.fn();
    const createReader = adapter.createBlobBatchReader.bind(adapter);
    vi.spyOn(adapter, "createBlobBatchReader").mockImplementation(() => {
      const reader = createReader();
      opened.push(reader);
      return {
        read: async (sha, path) => reader.read(sha, path),
        close: async () => {
          closes();
          await reader.close();
        },
      };
    });

    await buildOnDemandGitSignals(adapter, targets, OPTIONS);

    expect(opened).toHaveLength(1);
    expect(closes).toHaveBeenCalledTimes(1);
  });

  it("closes the shared blob reader when the walk throws", async () => {
    const adapter = new GitCliAdapter(repo);
    const closes = vi.fn();
    const createReader = adapter.createBlobBatchReader.bind(adapter);
    vi.spyOn(adapter, "createBlobBatchReader").mockImplementation(() => {
      const reader = createReader();
      return {
        read: async () => {
          throw new Error("blob read failed");
        },
        close: async () => {
          closes();
          await reader.close();
        },
      };
    });

    await expect(buildOnDemandGitSignals(adapter, targets, OPTIONS)).rejects.toThrow("blob read failed");
    expect(closes).toHaveBeenCalledTimes(1);
  });
});
