/**
 * bd tea-rags-mcp-iqpuu — ChunkChurnWalkThread equivalence pin on a REAL git
 * fixture. The dedicated churn-walk worker thread must produce BYTE-EQUAL
 * chunk overlays vs the inline main-thread path — the walk itself is
 * unchanged, only the thread it runs on moves.
 *
 * Real git, no child_process mock (precedent: client-catfile.test.ts).
 * REQUIRES `npm run build` before GREEN — the thread loads its compiled
 * worker entry from build/.../churn-walk/worker.js (precedent: enrichment
 * infra/worker.test.ts hard-references build/).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { ChunkSignalOverlay } from "../../../../../../src/core/contracts/types/provider.js";
import { ChunkChurnWalkThread } from "../../../../../../src/core/domains/trajectory/git/infra/churn-walk/thread.js";
import { GitCommitDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";
import type { ChunkChurnWalkStats } from "../../../../../../src/core/domains/trajectory/git/infra/walk-commits.js";
import { GitEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/git/provider.js";

// Temp base captured ONCE at module load (realpath-normalised; macOS /var →
// /private/var). Guard: these tests run REAL `git init`/`git commit` — refuse
// loudly if cwd ever points outside the temp tree (see client-catfile.test.ts).
const TMP_BASE = realpathSync(tmpdir());
function gitIn(cwd: string, args: string[]): string {
  const r = cwd ? resolve(cwd) : "";
  if (!r?.startsWith(TMP_BASE + sep)) {
    throw new Error(`churn-walk-thread.test: refusing git "${args[0]}" in non-temp cwd: ${String(cwd)}`);
  }
  // Pin author/committer via env: inside a `git commit` hook run (pre-commit
  // affected-tests) git exports GIT_AUTHOR_NAME of the OUTER commit, which
  // would override the fixture repo's local user.name and break the blame
  // ownership assertions.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

let repo: string;
const g = (args: string[]): string => gitIn(repo, args);

const F1_V1 = `${Array.from({ length: 12 }, (_, i) => `f1 line ${i + 1}`).join("\n")}\n`;
const F1_V2 = `${["f1 HEAD-EDIT 1", "f1 HEAD-EDIT 2", ...Array.from({ length: 10 }, (_, i) => `f1 line ${i + 3}`)].join("\n")}\n`;
const F1_V3 = `${F1_V2.split("\n").slice(0, 10).join("\n")}\nf1 TAIL-EDIT 11\nf1 TAIL-EDIT 12\n`;
const F2_V1 = `${Array.from({ length: 8 }, (_, i) => `f2 line ${i + 1}`).join("\n")}\n`;
const F2_V2 = F2_V1.replace("f2 line 8", "f2 EDIT 8");

beforeAll(() => {
  repo = mkdtempSync(join(TMP_BASE, "churn-walk-"));
  g(["init", "-q"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "Test"]);

  // Commit 1 (root): f1.ts with 12 deterministic lines.
  writeFileSync(join(repo, "f1.ts"), F1_V1);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "feat: add f1"]);

  // Commit 2: modify f1 head lines.
  writeFileSync(join(repo, "f1.ts"), F1_V2);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "feat: extend"]);

  // Commit 3: add f2.ts (bug-fix classified body).
  writeFileSync(join(repo, "f2.ts"), F2_V1);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "fix: broken thing"]);

  // Commit 4: modify f1 tail + f2 (carries a taskId).
  writeFileSync(join(repo, "f1.ts"), F1_V3);
  writeFileSync(join(repo, "f2.ts"), F2_V2);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "TD-123 update both"]);
}, 30000); // ~13 sync git spawns; 10s default hook timeout flakes under coverage/CI load (matches file-discovery)

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Absolute-keyed chunk map — same shape the post-flush path hands the provider. */
function fixtureChunkMap(): Map<string, { chunkId: string; startLine: number; endLine: number }[]> {
  return new Map([
    [
      join(repo, "f1.ts"),
      [
        { chunkId: "c1", startLine: 1, endLine: 6 },
        { chunkId: "c2", startLine: 7, endLine: 12 },
      ],
    ],
    [join(repo, "f2.ts"), [{ chunkId: "c3", startLine: 1, endLine: 8 }]],
  ]);
}

function freshDiscovery(): GitCommitDiscovery {
  return new GitCommitDiscovery(new GitCliAdapter(repo), { maxAgeMonths: 6, timeoutMs: 120000 });
}

/** Deterministic serialization: sorted files, sorted chunkIds, sorted object keys. */
function canonical(overlays: Map<string, Map<string, ChunkSignalOverlay>>): string {
  const files = [...overlays.keys()].sort();
  const out: Record<string, Record<string, unknown>> = {};
  for (const file of files) {
    const chunkIds = [...(overlays.get(file)?.keys() ?? [])].sort();
    const perChunk: Record<string, unknown> = {};
    for (const chunkId of chunkIds) {
      const overlay = overlays.get(file)?.get(chunkId) as Record<string, unknown>;
      const sortedOverlay: Record<string, unknown> = {};
      for (const key of Object.keys(overlay).sort()) sortedOverlay[key] = overlay[key];
      perChunk[chunkId] = sortedOverlay;
    }
    out[file] = perChunk;
  }
  return JSON.stringify(out);
}

describe("ChunkChurnWalkThread equivalence (bd tea-rags-mcp-iqpuu, real git)", () => {
  it("off-thread walk produces byte-equal overlays vs the inline path (no file signals)", async () => {
    const inlineProvider = new GitEnrichmentProvider();
    const inline = await inlineProvider.buildChunkSignals(repo, fixtureChunkMap(), {
      skipCache: true,
      commitDiscovery: freshDiscovery() as never,
    });

    const thread = new ChunkChurnWalkThread();
    try {
      const offProvider = new GitEnrichmentProvider();
      const off = await offProvider.buildChunkSignals(repo, fixtureChunkMap(), {
        skipCache: true,
        commitDiscovery: freshDiscovery() as never,
        churnWalkThread: thread as never,
      });

      expect(inline.size).toBe(2);
      expect(canonical(off)).toBe(canonical(inline));
      const c1 = inline.get("f1.ts")?.get("c1") as { commitCount: number } | undefined;
      expect(c1?.commitCount).toBeGreaterThanOrEqual(1);
    } finally {
      await thread.close();
    }
  }, 30000);

  it("byte-equal WITH file-signal state (blame + fileChurn slices cross the boundary)", async () => {
    const inlineProvider = new GitEnrichmentProvider();
    await inlineProvider.streamFileBatch(repo, ["f1.ts", "f2.ts"]);
    const inline = await inlineProvider.buildChunkSignals(repo, fixtureChunkMap(), {
      skipCache: true,
      commitDiscovery: freshDiscovery() as never,
    });

    const thread = new ChunkChurnWalkThread();
    try {
      const offProvider = new GitEnrichmentProvider();
      await offProvider.streamFileBatch(repo, ["f1.ts", "f2.ts"]);
      const off = await offProvider.buildChunkSignals(repo, fixtureChunkMap(), {
        skipCache: true,
        commitDiscovery: freshDiscovery() as never,
        churnWalkThread: thread as never,
      });

      expect(canonical(off)).toBe(canonical(inline));
      // Blame ownership crossed the boundary: fixture has a single author.
      const c3 = off.get("f2.ts")?.get("c3") as { blameDominantAuthor: string } | undefined;
      expect(c3?.blameDominantAuthor).toBe("Test");
    } finally {
      await thread.close();
    }
  }, 30000);

  it("reports walk stats from the worker", async () => {
    const thread = new ChunkChurnWalkThread();
    try {
      const provider = new GitEnrichmentProvider();
      const onWalkStats = vi.fn();
      await provider.buildChunkSignals(repo, fixtureChunkMap(), {
        skipCache: true,
        commitDiscovery: freshDiscovery() as never,
        churnWalkThread: thread as never,
        onWalkStats,
      });

      expect(onWalkStats).toHaveBeenCalledTimes(1);
      const stats = onWalkStats.mock.calls[0][0] as ChunkChurnWalkStats;
      expect(stats.files).toBe(2);
      expect(stats.holdCount).toBeGreaterThanOrEqual(1);
      expect(stats.blobReads).toBeGreaterThanOrEqual(2);
    } finally {
      await thread.close();
    }
  }, 30000);

  it("close() shuts the thread down and is idempotent", async () => {
    // Never-walked thread: close() without a spawned worker is a no-op.
    const idle = new ChunkChurnWalkThread();
    await expect(idle.close()).resolves.toBeUndefined();
    await expect(idle.close()).resolves.toBeUndefined();

    // Walked thread: close() tears the worker down; the second close no-ops.
    const thread = new ChunkChurnWalkThread();
    const provider = new GitEnrichmentProvider();
    await provider.buildChunkSignals(repo, fixtureChunkMap(), {
      skipCache: true,
      commitDiscovery: freshDiscovery() as never,
      churnWalkThread: thread as never,
    });
    await expect(thread.close()).resolves.toBeUndefined();
    await expect(thread.close()).resolves.toBeUndefined();
  }, 30000);
});
