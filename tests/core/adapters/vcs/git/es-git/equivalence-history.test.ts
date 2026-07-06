/**
 * T10 equivalence suite: EsGitAdapter history ops vs the GitCliAdapter oracle —
 * readNumstatLog / readNumstatLogForPaths / getCommitsSince / getCommitsInRange /
 * getCommitsByPathspec, plus a walk-level pin running the REAL walkCommits
 * against both adapters. Any deviation is a blocker.
 *
 * Empirically pinned CLI semantics the fixture asserts explicitly:
 * - merge commits: `git log --numstat` without `-m` emits the header but NO
 *   file rows → the parsers drop them, so merges never surface in any output;
 * - rename detection is ON by default (`diff.renames` unset ⇒ true since
 *   git 2.9): a pure rename is ONE row `0 0 pfx{old => new}sfx`, not
 *   delete+add — the `diff.renames=false` block covers the opposite branch;
 * - binary files emit `- -` numstat columns → skipped from churn maps AND
 *   changedFiles.
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { VcsGitAdapter } from "../../../../../../src/core/adapters/vcs/git/adapter.js";
import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { ChunkLookupEntry } from "../../../../../../src/core/contracts/types/chunker.js";
import type { ChunkAccumulator } from "../../../../../../src/core/domains/trajectory/git/infra/metrics.js";
import { walkCommits } from "../../../../../../src/core/domains/trajectory/git/infra/walk-commits.js";
import { buildEquivalenceFixtureRepo, type EquivalenceFixtureRepo } from "./__fixtures__/equivalence-repo.js";

const esGitAvailable = await import("es-git").then(
  () => true,
  () => false,
);

const EARLY_SINCE = new Date("2020-01-01T00:00:00Z"); // before every fixture commit
const MID_SINCE = new Date("2026-01-03T12:00:00Z"); // between c3 (rename) and c4 (feature)

async function openEsGitAdapter(root: string): Promise<VcsGitAdapter> {
  const { EsGitAdapter } = await import("../../../../../../src/core/adapters/vcs/git/es-git/adapter.js");
  return EsGitAdapter.open(root);
}

// Generous timeouts: the fixture spawns ~20 sequential git processes and the
// oracle side is spawn-heavy too — EDR throttles machine-wide process spawns
// (~10/s) when the whole test tree runs in parallel.
describe.skipIf(!esGitAvailable)("EsGitAdapter ⇄ GitCliAdapter equivalence — history ops", { timeout: 30_000 }, () => {
  let fixture: EquivalenceFixtureRepo;
  let cli: GitCliAdapter;
  let esGit: VcsGitAdapter;

  beforeAll(async () => {
    fixture = buildEquivalenceFixtureRepo();
    cli = new GitCliAdapter(fixture.root);
    esGit = await openEsGitAdapter(fixture.root);
  }, 60_000);

  afterAll(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("readNumstatLog: full-history churn maps deep-equal; merge/rename/binary semantics pinned", async () => {
    const oracle = await cli.readNumstatLog();
    expect(await esGit.readNumstatLog()).toEqual(oracle);

    // Merge commits contribute NO rows anywhere (empirically pinned).
    for (const churn of oracle.values()) {
      for (const commit of churn.commits) expect(commit.sha).not.toBe(fixture.mergeSha);
    }
    // Rename detection ON by default → ONE combined-path row for the pure rename.
    expect([...oracle.keys()]).toContain("src/{util.ts => helper.ts}");
    expect(oracle.get("src/{util.ts => helper.ts}")?.commits.map((c) => c.sha)).toEqual([fixture.renameSha]);
    // The rename source still has its c2 creation row under the plain path.
    expect(oracle.get("src/util.ts")?.commits.map((c) => c.sha)).toEqual([fixture.utilSha]);
    // Binary files ("-\t-" numstat) never enter the churn map.
    expect(oracle.has("assets/logo.bin")).toBe(false);
    // Multi-line body (%B) and parent lists (%P) survive byte-equal.
    const initial = oracle.get("README.md")?.commits.at(-1);
    expect(initial?.sha).toBe(fixture.initialSha);
    expect(initial?.body).toContain("Introduces the app skeleton.\nSecond body line.");
    expect(initial?.parents).toEqual([]);
  });

  it("readNumstatLog: --since bounded maps deep-equal", async () => {
    const oracle = await cli.readNumstatLog(MID_SINCE);
    expect(await esGit.readNumstatLog(MID_SINCE)).toEqual(oracle);
    // Only commits at/after the bound survive (c4, c5, c7 — merge never emits rows).
    const shas = new Set([...oracle.values()].flatMap((c) => c.commits.map((x) => x.sha)));
    expect(shas).toEqual(new Set([fixture.featureSha, fixture.mainSideSha, fixture.headSha]));
  });

  it("readNumstatLogForPaths: single-path full-history churn deep-equal", async () => {
    const oracle = await cli.readNumstatLogForPaths(["src/app.ts"]);
    expect(await esGit.readNumstatLogForPaths(["src/app.ts"])).toEqual(oracle);
    expect(oracle.has("src/app.ts")).toBe(true);
    expect(oracle.has("README.md")).toBe(false);
  });

  it("readNumstatLogForPaths: pathspec covering both rename sides pairs the rename on both adapters", async () => {
    const paths = ["src/util.ts", "src/helper.ts"];
    const oracle = await cli.readNumstatLogForPaths(paths);
    expect(await esGit.readNumstatLogForPaths(paths)).toEqual(oracle);
    expect([...oracle.keys()].sort()).toEqual(["src/util.ts", "src/{util.ts => helper.ts}"]);
  });

  it("readNumstatLogForPaths: pathspec covering ONE rename side degrades to add/delete on both adapters", async () => {
    const oracle = await cli.readNumstatLogForPaths(["src/helper.ts"]);
    expect(await esGit.readNumstatLogForPaths(["src/helper.ts"])).toEqual(oracle);
    // The unpaired target side surfaces as a plain add at the rename commit.
    expect(oracle.get("src/helper.ts")?.commits.map((c) => c.sha)).toEqual([fixture.renameSha]);
    expect(oracle.get("src/helper.ts")?.linesAdded).toBe(3);
  });

  it("readNumstatLogForPaths: missing paths and empty input → empty maps on both adapters", async () => {
    await expect(cli.readNumstatLogForPaths(["no/such/file.ts"])).resolves.toEqual(new Map());
    await expect(esGit.readNumstatLogForPaths(["no/such/file.ts"])).resolves.toEqual(new Map());
    await expect(cli.readNumstatLogForPaths([])).resolves.toEqual(new Map());
    await expect(esGit.readNumstatLogForPaths([])).resolves.toEqual(new Map());
  });

  it("getCommitsSince: full-history commit+changedFiles arrays deep-equal INCLUDING order", async () => {
    const oracle = await cli.getCommitsSince(EARLY_SINCE);
    expect(await esGit.getCommitsSince(EARLY_SINCE)).toEqual(oracle);

    // Order = git log order (newest first); merges dropped; binary excluded.
    expect(oracle.map((e) => e.commit.sha)).toEqual([
      fixture.headSha,
      fixture.mainSideSha,
      fixture.featureSha,
      fixture.renameSha,
      fixture.utilSha,
      fixture.initialSha,
    ]);
    const util = oracle.find((e) => e.commit.sha === fixture.utilSha);
    expect(util?.changedFiles).not.toContain("assets/logo.bin");
    expect(util?.changedFiles).toContain("src/util.ts");
  });

  it("getCommitsSince: --since bounded arrays deep-equal", async () => {
    const oracle = await cli.getCommitsSince(MID_SINCE);
    expect(await esGit.getCommitsSince(MID_SINCE)).toEqual(oracle);
    expect(oracle.map((e) => e.commit.sha)).toEqual([fixture.headSha, fixture.mainSideSha, fixture.featureSha]);
  });

  it("getCommitsInRange: from..to reachability + since bound deep-equal", async () => {
    const oracle = await cli.getCommitsInRange(fixture.utilSha, fixture.headSha, EARLY_SINCE);
    expect(await esGit.getCommitsInRange(fixture.utilSha, fixture.headSha, EARLY_SINCE)).toEqual(oracle);
    expect(oracle.map((e) => e.commit.sha)).toEqual([
      fixture.headSha,
      fixture.mainSideSha,
      fixture.featureSha,
      fixture.renameSha,
    ]);
  });

  it("getCommitsInRange: identical bounds → empty on both adapters", async () => {
    await expect(cli.getCommitsInRange(fixture.headSha, fixture.headSha, EARLY_SINCE)).resolves.toEqual([]);
    await expect(esGit.getCommitsInRange(fixture.headSha, fixture.headSha, EARLY_SINCE)).resolves.toEqual([]);
  });

  it("getCommitsInRange: unresolvable bound → BOTH adapters reject (CLI parity)", async () => {
    const bad = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    await expect(cli.getCommitsInRange(bad, fixture.headSha, EARLY_SINCE)).rejects.toThrow();
    await expect(esGit.getCommitsInRange(bad, fixture.headSha, EARLY_SINCE)).rejects.toThrow();
  });

  it("getCommitsByPathspec: multi-path discovery deep-equal INCLUDING order", async () => {
    const paths = ["src/app.ts", "src/feature.ts", "README.md"];
    const oracle = await cli.getCommitsByPathspec(EARLY_SINCE, paths);
    expect(await esGit.getCommitsByPathspec(EARLY_SINCE, paths)).toEqual(oracle);
    expect(oracle.map((e) => e.commit.sha)).toEqual([
      fixture.headSha,
      fixture.mainSideSha,
      fixture.featureSha,
      fixture.renameSha,
      fixture.utilSha,
      fixture.initialSha,
    ]);
  });

  it("getCommitsByPathspec: since bound + pathspec interplay deep-equal", async () => {
    const oracle = await cli.getCommitsByPathspec(MID_SINCE, ["src/app.ts"]);
    expect(await esGit.getCommitsByPathspec(MID_SINCE, ["src/app.ts"])).toEqual(oracle);
    expect(oracle.map((e) => e.commit.sha)).toEqual([fixture.headSha, fixture.mainSideSha, fixture.featureSha]);
  });

  it("getCommitsByPathspec: empty path list → [] on both adapters", async () => {
    await expect(cli.getCommitsByPathspec(EARLY_SINCE, [])).resolves.toEqual([]);
    await expect(esGit.getCommitsByPathspec(EARLY_SINCE, [])).resolves.toEqual([]);
  });

  it("walk-level pin: the REAL walkCommits produces identical accumulators over both adapters", async () => {
    const runWalk = async (adapter: VcsGitAdapter) => {
      const relativeChunkMap = new Map<string, ChunkLookupEntry[]>([
        [
          "src/app.ts",
          [
            { chunkId: "app#head", startLine: 1, endLine: 5 },
            { chunkId: "app#tail", startLine: 6, endLine: 10 },
          ],
        ],
        ["src/feature.ts", [{ chunkId: "feature#all", startLine: 1, endLine: 2 }]],
      ]);
      const makeAccumulator = (): ChunkAccumulator => ({
        commitShas: new Set(),
        authors: new Set(),
        bugFixCount: 0,
        lastModifiedAt: 0,
        linesAdded: 0,
        linesDeleted: 0,
        commitTimestamps: [],
        commitAuthors: [],
        commitIsFix: [],
        taskIds: new Set(),
      });
      const accumulators = new Map<string, ChunkAccumulator>([
        ["app#head", makeAccumulator()],
        ["app#tail", makeAccumulator()],
        ["feature#all", makeAccumulator()],
      ]);
      const result = await walkCommits({
        adapter,
        relativeChunkMap,
        accumulators,
        isoGitCache: {},
        concurrency: 2,
        maxAgeMonths: 120,
        chunkTimeoutMs: 30_000,
        maxFileLines: 5_000,
      });
      return { accumulators, result };
    };

    const oracle = await runWalk(cli);
    const es = await runWalk(esGit);

    expect(es.accumulators).toEqual(oracle.accumulators);
    // semWaitMs is wall-clock noise; every deterministic counter must match.
    expect(es.result.commitCount).toBe(oracle.result.commitCount);
    expect(es.result.holdCount).toBe(oracle.result.holdCount);
    expect(es.result.blobReads).toBe(oracle.result.blobReads);
    expect(es.result.patchCalls).toBe(oracle.result.patchCalls);
    expect(es.result.memoHits).toBe(oracle.result.memoHits);

    // The walk actually accumulated signal (guards against vacuous equality).
    const appHead = oracle.accumulators.get("app#head");
    expect(appHead?.commitShas.size).toBeGreaterThan(0);
    expect(oracle.result.commitCount).toBeGreaterThan(0);
  });
});

describe.skipIf(!esGitAvailable)(
  "EsGitAdapter ⇄ GitCliAdapter equivalence — diff.renames=false parity",
  { timeout: 30_000 },
  () => {
    let fixture: EquivalenceFixtureRepo;
    let cli: GitCliAdapter;
    let esGit: VcsGitAdapter;

    beforeAll(async () => {
      fixture = buildEquivalenceFixtureRepo();
      // Flip the effective config BEFORE opening the adapters — both must follow it.
      execFileSync("git", ["-C", fixture.root, "config", "diff.renames", "false"], { encoding: "utf8" });
      cli = new GitCliAdapter(fixture.root);
      esGit = await openEsGitAdapter(fixture.root);
    }, 60_000);

    afterAll(() => {
      rmSync(fixture.root, { recursive: true, force: true });
    });

    it("readNumstatLog: rename shows as delete+add of two plain paths on both adapters", async () => {
      const oracle = await cli.readNumstatLog();
      expect(await esGit.readNumstatLog()).toEqual(oracle);

      expect([...oracle.keys()]).not.toContain("src/{util.ts => helper.ts}");
      const helper = oracle.get("src/helper.ts");
      const util = oracle.get("src/util.ts");
      expect(helper?.commits.map((c) => c.sha)).toEqual([fixture.renameSha]); // add side
      expect(helper?.linesAdded).toBe(3);
      expect(util?.commits.map((c) => c.sha)).toEqual([fixture.renameSha, fixture.utilSha]); // delete side + creation
      expect(util?.linesDeleted).toBe(3);
    });

    it("getCommitsByPathspec: changedFiles carry both plain rename sides on both adapters", async () => {
      const paths = ["src/util.ts", "src/helper.ts"];
      const oracle = await cli.getCommitsByPathspec(EARLY_SINCE, paths);
      expect(await esGit.getCommitsByPathspec(EARLY_SINCE, paths)).toEqual(oracle);
      const rename = oracle.find((e) => e.commit.sha === fixture.renameSha);
      expect(rename?.changedFiles.sort()).toEqual(["src/helper.ts", "src/util.ts"]);
    });
  },
);
