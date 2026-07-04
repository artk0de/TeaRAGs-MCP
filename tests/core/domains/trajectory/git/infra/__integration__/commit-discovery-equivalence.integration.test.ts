/**
 * bd tea-rags-mcp-82va1 — THE equivalence pin.
 *
 * On a real (linear-ish) fixture repo, per-batch walks slicing ONE repo-wide
 * commit-discovery matrix must produce BYTE-EQUAL chunk-churn overlays to the
 * legacy per-batch pathspec discovery — while collapsing K pathspec logs into
 * one repo-wide `git log --since --numstat`. The persistent tier must then
 * skip the log on an exact-HEAD hit and top up via `git log old..new` after a
 * new commit, still byte-equal to a fresh legacy walk at the new HEAD.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as gitClient from "../../../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import { buildChunkChurnMapUncached } from "../../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import { GitCommitDiscoveryStore } from "../../../../../../../src/core/domains/trajectory/git/infra/commit-discovery-store.js";
import { GitCommitDiscovery } from "../../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";

// Enable cross-module CALL-THROUGH spy interception for adapter functions.
vi.mock("../../../../../../../src/core/adapters/vcs/git/git-cli/client.js", async (importOriginal) => importOriginal());

const TEST_TIMEOUT = 60000;

// All commits land within the 6-month window, minutes apart, so Phase-2
// newest→oldest ordering is deterministic and byte-equality is meaningful.
const BASE_TIME = Date.now() - 30 * 86400 * 1000;
let dateSeq = 0;

function git(args: string[], cwd: string, env: Record<string, string> = {}): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: "pipe" });
}

function commitEnv(): Record<string, string> {
  const date = new Date(BASE_TIME + ++dateSeq * 60_000).toISOString();
  return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

function commitAll(repo: string, message: string): void {
  git(["add", "-A"], repo);
  git(["commit", "-m", message], repo, commitEnv());
}

const chunk = (chunkId: string) => [{ chunkId, startLine: 1, endLine: 10 }];

type ChurnResult = Map<string, Map<string, unknown>>;

/** Canonical byte representation of a churn result (insertion-ordered maps). */
const canon = (result: ChurnResult): string => JSON.stringify([...result].map(([f, m]) => [f, [...m]]));

async function walk(
  repo: string,
  chunkMap: Map<string, { chunkId: string; startLine: number; endLine: number }[]>,
  discovery?: GitCommitDiscovery,
): Promise<ChurnResult> {
  return (await buildChunkChurnMapUncached(
    repo,
    chunkMap,
    {},
    10,
    6,
    undefined,
    undefined,
    120000,
    10000,
    undefined,
    undefined,
    undefined,
    undefined,
    discovery,
  )) as never;
}

describe("commit-discovery equivalence pin (bd tea-rags-mcp-82va1)", () => {
  let repo: string;
  let storeBase: string;
  const batchA = new Map([["a.ts", chunk("cA")]]);
  const batchB = new Map([
    ["b.ts", chunk("cB")],
    ["c.ts", chunk("cC")],
  ]);
  const mega = new Map([
    ["a.ts", chunk("cA")],
    ["b.ts", chunk("cB")],
    ["c.ts", chunk("cC")],
  ]);

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "tr-discovery-fixture-"));
    storeBase = mkdtempSync(join(tmpdir(), "tr-discovery-store-"));
    git(["init", "-b", "main"], repo);
    git(["config", "user.name", "Test"], repo);
    git(["config", "user.email", "t@example.com"], repo);
    git(["config", "commit.gpgsign", "false"], repo);

    // c1: adds a.ts + b.ts
    writeFileSync(join(repo, "a.ts"), "const a = 1;\nconst a2 = 2;\nconst a3 = 3;\n");
    writeFileSync(join(repo, "b.ts"), "const b = 1;\nconst b2 = 2;\n");
    commitAll(repo, "feat: add a and b");
    // c2: modifies a.ts
    writeFileSync(join(repo, "a.ts"), "const a = 10;\nconst a2 = 2;\nconst a3 = 3;\n");
    commitAll(repo, "improve: bump a");
    // fix/crash branch: c3 modifies b.ts, merged --no-ff back into main
    git(["checkout", "-b", "fix/crash"], repo);
    writeFileSync(join(repo, "b.ts"), "const b = 99;\nconst b2 = 2;\n");
    commitAll(repo, "fix: crash in b");
    git(["checkout", "main"], repo);
    git(["merge", "--no-ff", "fix/crash", "-m", "Merge branch 'fix/crash'"], repo, commitEnv());
    // c4: adds c.ts + modifies a.ts
    writeFileSync(join(repo, "c.ts"), "export const c = true;\n");
    writeFileSync(join(repo, "a.ts"), "const a = 10;\nconst a2 = 20;\nconst a3 = 3;\n");
    commitAll(repo, "feat: add c, tweak a");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(storeBase, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it(
    "matrix slices are byte-equal to legacy per-batch pathspec walks (3 pathspec logs → 1 repo-wide log)",
    async () => {
      const pathspecSpy = vi.spyOn(gitClient, "getCommitsByPathspec");
      const sinceSpy = vi.spyOn(gitClient, "getCommitsSince");

      // LEGACY leg: three independent walks, per-batch pathspec discovery.
      const legacyA = canon(await walk(repo, batchA));
      const legacyB = canon(await walk(repo, batchB));
      const legacyMega = canon(await walk(repo, mega));
      expect(pathspecSpy).toHaveBeenCalledTimes(3);
      expect(sinceSpy).not.toHaveBeenCalled();

      pathspecSpy.mockClear();
      sinceSpy.mockClear();

      // MATRIX leg: ONE discovery shared across the same three walks.
      const discovery = new GitCommitDiscovery(repo, { maxAgeMonths: 6, timeoutMs: 120000 });
      const matrixA = canon(await walk(repo, batchA, discovery));
      const matrixB = canon(await walk(repo, batchB, discovery));
      const matrixMega = canon(await walk(repo, mega, discovery));

      expect(matrixA).toBe(legacyA);
      expect(matrixB).toBe(legacyB);
      expect(matrixMega).toBe(legacyMega);
      expect(pathspecSpy).not.toHaveBeenCalled();
      expect(sinceSpy).toHaveBeenCalledTimes(1);
    },
    TEST_TIMEOUT,
  );

  it(
    "persistence: exact-HEAD load skips the log; post-c5 top-up walk is byte-equal to a fresh legacy walk",
    async () => {
      const sinceSpy = vi.spyOn(gitClient, "getCommitsSince");
      const rangeSpy = vi.spyOn(gitClient, "getCommitsInRange");

      // Discovery A (cold store) — pays the ONE repo-wide log and persists it.
      const store = new GitCommitDiscoveryStore(storeBase);
      const discoveryA = new GitCommitDiscovery(repo, { maxAgeMonths: 6, timeoutMs: 120000, store });
      const megaA = canon(await walk(repo, mega, discoveryA));
      expect(sinceSpy).toHaveBeenCalledTimes(1);

      sinceSpy.mockClear();

      // Discovery B (same store, same HEAD) — exact-HEAD load, NO log at all.
      const discoveryB = new GitCommitDiscovery(repo, {
        maxAgeMonths: 6,
        timeoutMs: 120000,
        store: new GitCommitDiscoveryStore(storeBase),
      });
      const megaB = canon(await walk(repo, mega, discoveryB));
      expect(sinceSpy).not.toHaveBeenCalled();
      expect(megaB).toBe(megaA);

      // c5: new commit moves HEAD — discovery C tops up via git log old..new.
      writeFileSync(join(repo, "a.ts"), "const a = 100;\nconst a2 = 20;\nconst a3 = 3;\n");
      commitAll(repo, "improve: bump a again (c5)");

      sinceSpy.mockClear();
      rangeSpy.mockClear();

      const discoveryC = new GitCommitDiscovery(repo, {
        maxAgeMonths: 6,
        timeoutMs: 120000,
        store: new GitCommitDiscoveryStore(storeBase),
      });
      const megaC = canon(await walk(repo, mega, discoveryC));
      expect(rangeSpy).toHaveBeenCalledTimes(1);
      expect(sinceSpy).not.toHaveBeenCalled();

      // Byte-equal to a FRESH legacy walk at the new HEAD.
      const legacyAtNewHead = canon(await walk(repo, mega));
      expect(megaC).toBe(legacyAtNewHead);
    },
    TEST_TIMEOUT,
  );
});
