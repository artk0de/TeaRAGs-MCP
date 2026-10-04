/**
 * bd tea-rags-mcp-iqpuu — ChunkChurnWalkPool equivalence pin on a REAL git
 * fixture. The dedicated churn-walk worker thread must produce BYTE-EQUAL
 * chunk overlays vs the inline main-thread path — the walk itself is
 * unchanged, only the thread it runs on moves.
 *
 * Real git, no child_process mock (precedent: client-catfile.test.ts).
 * REQUIRES `npm run build` before GREEN — the thread loads its compiled
 * worker entry from build/.../churn-walk/worker.js (precedent: enrichment
 * infra/worker.test.ts hard-references build/).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { importGitHistory } from "../../../../__helpers__/git-history-import.js";
import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { ChunkSignalOverlay } from "../../../../../../src/core/contracts/types/provider.js";
import { ChunkChurnWalkPool } from "../../../../../../src/core/domains/trajectory/git/infra/churn-walk/walk-pool.js";
import { GitCommitDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";
import type { ChunkChurnWalkStats } from "../../../../../../src/core/domains/trajectory/git/infra/walk-commits.js";
import { GitEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/git/provider.js";

// Temp base captured ONCE at module load (realpath-normalised; macOS /var →
// /private/var). Guard: these tests run REAL `git init`/`git commit` — refuse
// loudly if cwd ever points outside the temp tree (see client-catfile.test.ts).
const TMP_BASE = realpathSync(tmpdir());

let repo: string;

const F1_V1 = `${Array.from({ length: 12 }, (_, i) => `f1 line ${i + 1}`).join("\n")}\n`;
const F1_V2 = `${["f1 HEAD-EDIT 1", "f1 HEAD-EDIT 2", ...Array.from({ length: 10 }, (_, i) => `f1 line ${i + 3}`)].join("\n")}\n`;
const F1_V3 = `${F1_V2.split("\n").slice(0, 10).join("\n")}\nf1 TAIL-EDIT 11\nf1 TAIL-EDIT 12\n`;
const F2_V1 = `${Array.from({ length: 8 }, (_, i) => `f2 line ${i + 1}`).join("\n")}\n`;
const F2_V2 = F2_V1.replace("f2 line 8", "f2 EDIT 8");

beforeAll(() => {
  repo = mkdtempSync(join(TMP_BASE, "churn-walk-"));
  if (!resolve(repo).startsWith(TMP_BASE + sep)) {
    throw new Error(`churn-walk-thread.test: refusing git in non-temp cwd: ${repo}`);
  }
  // ONE fast-import instead of ~13 add/commit spawns (bd tea-rags-mcp-1r3e5).
  // Author and committer are explicit, so a GIT_AUTHOR_NAME exported by an
  // outer `git commit` hook run cannot leak into the blame ownership.
  const test = { name: "Test", email: "t@example.com" };
  const now = new Date();
  importGitHistory(
    repo,
    [
      // Commit 1 (root): f1.ts with 12 deterministic lines.
      { message: "feat: add f1", author: test, authorDate: now, writes: { "f1.ts": F1_V1 } },
      // Commit 2: modify f1 head lines.
      { message: "feat: extend", author: test, authorDate: now, writes: { "f1.ts": F1_V2 } },
      // Commit 3: add f2.ts (bug-fix classified body).
      { message: "fix: broken thing", author: test, authorDate: now, writes: { "f2.ts": F2_V1 } },
      // Commit 4: modify f1 tail + f2 (carries a taskId).
      { message: "TD-123 update both", author: test, authorDate: now, writes: { "f1.ts": F1_V3, "f2.ts": F2_V2 } },
    ],
    { config: { "user.email": "t@example.com", "user.name": "Test" } },
  );
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

describe("ChunkChurnWalkPool equivalence (bd tea-rags-mcp-iqpuu, real git)", () => {
  it("off-thread walk produces byte-equal overlays vs the inline path (no file signals)", async () => {
    const inlineProvider = new GitEnrichmentProvider();
    const inline = await inlineProvider.buildChunkSignals(repo, fixtureChunkMap(), {
      skipCache: true,
      commitDiscovery: freshDiscovery(),
    });

    const thread = new ChunkChurnWalkPool(2);
    try {
      const offProvider = new GitEnrichmentProvider();
      const off = await offProvider.buildChunkSignals(repo, fixtureChunkMap(), {
        skipCache: true,
        commitDiscovery: freshDiscovery(),
        churnWalkThread: thread,
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
      commitDiscovery: freshDiscovery(),
    });

    const thread = new ChunkChurnWalkPool(2);
    try {
      const offProvider = new GitEnrichmentProvider();
      await offProvider.streamFileBatch(repo, ["f1.ts", "f2.ts"]);
      const off = await offProvider.buildChunkSignals(repo, fixtureChunkMap(), {
        skipCache: true,
        commitDiscovery: freshDiscovery(),
        churnWalkThread: thread,
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
    const thread = new ChunkChurnWalkPool(2);
    try {
      const provider = new GitEnrichmentProvider();
      const onWalkStats = vi.fn();
      await provider.buildChunkSignals(repo, fixtureChunkMap(), {
        skipCache: true,
        commitDiscovery: freshDiscovery(),
        churnWalkThread: thread,
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
    const idle = new ChunkChurnWalkPool(2);
    await expect(idle.close()).resolves.toBeUndefined();
    await expect(idle.close()).resolves.toBeUndefined();

    // Walked thread: close() tears the worker down; the second close no-ops.
    const thread = new ChunkChurnWalkPool(2);
    const provider = new GitEnrichmentProvider();
    await provider.buildChunkSignals(repo, fixtureChunkMap(), {
      skipCache: true,
      commitDiscovery: freshDiscovery(),
      churnWalkThread: thread,
    });
    await expect(thread.close()).resolves.toBeUndefined();
    await expect(thread.close()).resolves.toBeUndefined();
  }, 30000);

  it("distributes concurrent walks across pool workers, each byte-equal to inline", async () => {
    // Inline baseline for the fixture.
    const inlineProvider = new GitEnrichmentProvider();
    const inline = canonical(
      await inlineProvider.buildChunkSignals(repo, fixtureChunkMap(), {
        skipCache: true,
        commitDiscovery: freshDiscovery(),
      }),
    );

    // Three walks dispatched CONCURRENTLY onto one pool of 3 → round-robin to
    // three distinct worker threads; each must still be byte-equal to inline.
    const pool = new ChunkChurnWalkPool(3);
    try {
      const offs = await Promise.all(
        Array.from({ length: 3 }, async () => {
          const p = new GitEnrichmentProvider();
          return p.buildChunkSignals(repo, fixtureChunkMap(), {
            skipCache: true,
            commitDiscovery: freshDiscovery(),
            churnWalkThread: pool,
          });
        }),
      );
      for (const off of offs) expect(canonical(off)).toBe(inline);
    } finally {
      await pool.close();
    }
  }, 30000);
});
