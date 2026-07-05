/**
 * T9 equivalence suite: EsGitAdapter core ops vs the GitCliAdapter oracle —
 * getHead / isAncestor / blameFile / readBlobAsString / blob + oid batch
 * readers. Every op must DEEP-EQUAL the CLI output on the shared fixture;
 * any deviation is a blocker (fix the EsGitAdapter, never the assertion).
 */

import { rmSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { VcsAdapterFactory } from "../../../../../../src/core/adapters/vcs/factory.js";
import type { VcsGitAdapter } from "../../../../../../src/core/adapters/vcs/git/adapter.js";
import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import { buildEquivalenceFixtureRepo, type EquivalenceFixtureRepo } from "./__fixtures__/equivalence-repo.js";

// Collection-safe availability probe: es-git is an optionalDependency — CI
// without the binding SKIPS the suite (never fails). EsGitAdapter itself is
// imported lazily in beforeAll for the same reason (it imports es-git
// statically).
const esGitAvailable = await import("es-git").then(
  () => true,
  () => false,
);

// Generous timeouts: the fixture spawns ~20 sequential git processes and the
// oracle side is spawn-heavy too — EDR throttles machine-wide process spawns
// (~10/s) when the whole test tree runs in parallel.
describe.skipIf(!esGitAvailable)("EsGitAdapter ⇄ GitCliAdapter equivalence — core ops", { timeout: 30_000 }, () => {
  let fixture: EquivalenceFixtureRepo;
  let cli: GitCliAdapter;
  let esGit: VcsGitAdapter;

  beforeAll(async () => {
    fixture = buildEquivalenceFixtureRepo();
    cli = new GitCliAdapter(fixture.root);
    const { EsGitAdapter } = await import("../../../../../../src/core/adapters/vcs/git/es-git/adapter.js");
    esGit = await EsGitAdapter.open(fixture.root);
  }, 60_000);

  afterAll(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("factory: GIT_ADAPTER=es-git resolves to an EsGitAdapter bound to the repo root", async () => {
    const { EsGitAdapter } = await import("../../../../../../src/core/adapters/vcs/git/es-git/adapter.js");
    const adapter = await VcsAdapterFactory.create("es-git", fixture.root);
    expect(adapter).toBeInstanceOf(EsGitAdapter);
    expect(adapter.repoRoot).toBe(fixture.root);
  });

  it("getHead: identical full 40-hex sha", async () => {
    const [es, oracle] = [await esGit.getHead(), await cli.getHead()];
    expect(es).toBe(oracle);
    expect(es).toMatch(/^[0-9a-f]{40}$/);
    expect(es).toBe(fixture.headSha);
  });

  it("isAncestor: reachability verdicts match the CLI for every probe (errors → false, never throw)", async () => {
    const probes: [string, string, boolean][] = [
      [fixture.initialSha, fixture.headSha, true],
      [fixture.headSha, fixture.initialSha, false],
      [fixture.featureSha, fixture.headSha, true], // merged side branch is reachable
      [fixture.mainSideSha, fixture.featureSha, false], // divergent legs
      [fixture.headSha, fixture.headSha, true], // merge-base --is-ancestor A A → true
      ["not-a-sha", fixture.headSha, false], // unparseable rev → false, no throw
      ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", fixture.headSha, false], // unknown oid → false
      [fixture.initialSha, "also-junk", false],
    ];
    for (const [ancestor, descendant, expected] of probes) {
      const oracle = await cli.isAncestor(ancestor, descendant);
      expect(oracle).toBe(expected); // pin the oracle itself
      expect(await esGit.isAncestor(ancestor, descendant)).toBe(oracle);
    }
  });

  it("blameFile: per-line attributions byte-equal for a file with layered history", async () => {
    const oracle = await cli.blameFile("src/app.ts");
    const es = await esGit.blameFile("src/app.ts");
    expect(es).toEqual(oracle);

    // Pin the oracle shape: every line covered, ordered, layered shas.
    expect(oracle).toHaveLength(10);
    expect(oracle.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(oracle[0].sha).toBe(fixture.mainSideSha); // L1-alice
    expect(oracle[3].sha).toBe(fixture.utilSha); // L4-bob
    expect(oracle[4].sha).toBe(fixture.headSha); // L5-fix
    expect(oracle[9].sha).toBe(fixture.featureSha); // L10
    // .mailmap applies to blame output on BOTH sides (empirically pinned).
    expect(oracle[3].author).toBe("Robert Mapped");
    expect(oracle[3].authorEmail).toBe("robert@example.com");
  });

  it("blameFile: renamed file follows the rename on both adapters", async () => {
    const oracle = await cli.blameFile("src/helper.ts");
    expect(await esGit.blameFile("src/helper.ts")).toEqual(oracle);
    // Lines were born in c2 as src/util.ts — blame follows the whole-file rename.
    expect(oracle.map((l) => l.sha)).toEqual([fixture.utilSha, fixture.utilSha, fixture.utilSha]);
  });

  it("blameFile: missing and untracked paths → [] on both adapters (never throw)", async () => {
    await expect(cli.blameFile("no/such/file.ts")).resolves.toEqual([]);
    await expect(esGit.blameFile("no/such/file.ts")).resolves.toEqual([]);
    await expect(cli.blameFile("src/untracked.ts")).resolves.toEqual([]);
    await expect(esGit.blameFile("src/untracked.ts")).resolves.toEqual([]);
  });

  it("blameFile: DEEP-history files (hint ≥ threshold) route to native git blame; SHALLOW ones stay in-process", async () => {
    // Depth routing, not a value pin (parity is proven above). libgit2's
    // git_blame__like_git is O(commits × tree-diff): fine shallow, 16-124s/file
    // + ~1GB resident past a few dozen commits on the taxdome monolith. Deep
    // files must hit the CLI; shallow must NOT (keeps them spawn-free/light).
    const spy = vi.spyOn(GitCliAdapter.prototype, "blameFile");
    try {
      // hint 100 ≥ default threshold (30) → CLI, with timeout forwarded.
      const deep = await esGit.blameFile("src/app.ts", 7_000, 100);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("src/app.ts", 7_000);
      expect(deep).toEqual(await cli.blameFile("src/app.ts")); // still correct

      spy.mockClear();
      // hint 3 < threshold → in-process es-git, no spawn.
      await esGit.blameFile("src/app.ts", 7_000, 3);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("blameFile: caps concurrent native git blame spawns (OOM guard — 10×1GB bricked a run)", async () => {
    let active = 0;
    let peak = 0;
    const spy = vi.spyOn(GitCliAdapter.prototype, "blameFile").mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return [];
    });
    try {
      // 8 deep files fired at once — the gate must hold the peak at the cap (2).
      await Promise.all(
        Array.from({ length: 8 }, async (_, i) => esGit.blameFile(`deep${String(i)}.ts`, undefined, 500)),
      );
      expect(spy).toHaveBeenCalledTimes(8); // all still complete
      expect(peak).toBeLessThanOrEqual(2); // never all-at-once
    } finally {
      spy.mockRestore();
    }
  });

  it("readBlobAsString: identical utf8 content at historical revisions", async () => {
    const cases: [string, string][] = [
      [fixture.initialSha, "src/app.ts"],
      [fixture.utilSha, "src/util.ts"],
      [fixture.headSha, "src/app.ts"],
      [fixture.utilSha, "assets/logo.bin"], // binary read as (lossy) utf8 — identical on both
    ];
    for (const [oid, path] of cases) {
      const oracle = await cli.readBlobAsString(oid, path);
      expect(oracle).not.toBe("");
      expect(await esGit.readBlobAsString(oid, path)).toBe(oracle);
    }
  });

  it('readBlobAsString: absent path / directory path → "" on both adapters (never throw)', async () => {
    // util.ts did not exist yet at c1; helper.ts did not exist before c3.
    for (const [oid, path] of [
      [fixture.initialSha, "src/util.ts"],
      [fixture.utilSha, "src/helper.ts"],
      [fixture.headSha, "no/such/file.ts"],
      [fixture.headSha, "src"], // tree, not a blob
    ] as [string, string][]) {
      await expect(cli.readBlobAsString(oid, path)).resolves.toBe("");
      await expect(esGit.readBlobAsString(oid, path)).resolves.toBe("");
    }
  });

  it("createBlobBatchReader: reads match readBlobAsString; close() rejects later reads; adapter survives", async () => {
    const cliReader = cli.createBlobBatchReader();
    const esReader = esGit.createBlobBatchReader();
    try {
      for (const [oid, path] of [
        [fixture.headSha, "src/app.ts"],
        [fixture.initialSha, "README.md"],
        [fixture.headSha, "no/such/file.ts"], // missing → "" (not an error)
        [fixture.utilSha, "src/util.ts"],
      ] as [string, string][]) {
        const oracle = await cliReader.read(oid, path);
        expect(oracle).toBe(await cli.readBlobAsString(oid, path));
        expect(await esReader.read(oid, path)).toBe(oracle);
      }
    } finally {
      await cliReader.close();
      await esReader.close();
    }
    await expect(cliReader.read(fixture.headSha, "src/app.ts")).rejects.toThrow();
    await expect(esReader.read(fixture.headSha, "src/app.ts")).rejects.toThrow();
    // The reader borrows the adapter-owned handle — the adapter itself stays usable.
    expect(await esGit.getHead()).toBe(fixture.headSha);
    expect(await esGit.readBlobAsString(fixture.headSha, "README.md")).not.toBe("");
  });

  it("createOidBatchResolver: rev → oid | null matches the CLI; close() rejects later checks", async () => {
    const cliResolver = cli.createOidBatchResolver();
    const esResolver = esGit.createOidBatchResolver();
    try {
      for (const rev of [
        "HEAD",
        `${fixture.headSha}:src/app.ts`,
        "HEAD:README.md",
        "HEAD:src/untracked.ts", // untracked → null
        "HEAD:no/such/file.ts", // missing → null
        "garbage-rev", // unparseable → null
      ]) {
        const oracle = await cliResolver.check(rev);
        expect(await esResolver.check(rev)).toBe(oracle);
      }
      expect(await cliResolver.check("HEAD")).toBe(fixture.headSha);
      expect(await cliResolver.check("HEAD:no/such/file.ts")).toBeNull();
      expect(await cliResolver.check(`${fixture.headSha}:src/app.ts`)).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await cliResolver.close();
      await esResolver.close();
    }
    await expect(cliResolver.check("HEAD")).rejects.toThrow();
    await expect(esResolver.check("HEAD")).rejects.toThrow();
  });
});
