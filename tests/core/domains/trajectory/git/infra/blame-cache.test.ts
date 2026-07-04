/**
 * bd tea-rags-mcp-v2mlw — OID-keyed persistent blame cache, provider-level
 * pins on a REAL git fixture. Sequential scenario in one file:
 *
 *   1. COLD: first run blames every file (hits 0), overlays correct, cache
 *      persisted at finalizeSignals.
 *   2. WARM EQUIVALENCE: a fresh provider reuses the persisted lines
 *      (hits === files) and its chunk overlays are byte-equal to the cold
 *      run's — cache reconstruction is invisible to signals. Persisted lines
 *      deep-equal a fresh inline blameFile.
 *   3. INVALIDATION: a new commit changes f1's blob OID → exactly that file
 *      re-blames (hits 1 / misses 1), ownership stays correct.
 *   4. FALLBACK: corrupt blame.json on disk → silent rebuild (cold
 *      semantics, no throw).
 *
 * Store isolation relies on TEA_RAGS_DATA_DIR (vitest.setup.ts) — the
 * provider's default-constructed GitBlameStore writes under
 * $TEA_RAGS_DATA_DIR/git-blame/<hash16>/blame.json.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { blameFile } from "../../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import type { ChunkSignalOverlay } from "../../../../../../src/core/contracts/types/provider.js";
import { GitBlameStore } from "../../../../../../src/core/domains/trajectory/git/infra/blame-store.js";
import { GitCommitDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";
import { GitEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/git/provider.js";

// Temp base captured ONCE at module load (realpath-normalised; macOS /var →
// /private/var). Guard: these tests run REAL `git init`/`git commit` — refuse
// loudly if cwd ever points outside the temp tree (see churn-walk-thread.test.ts).
const TMP_BASE = realpathSync(tmpdir());
function gitIn(cwd: string, args: string[]): string {
  const r = cwd ? resolve(cwd) : "";
  if (!r?.startsWith(TMP_BASE + sep)) {
    throw new Error(`blame-cache.test: refusing git "${args[0]}" in non-temp cwd: ${String(cwd)}`);
  }
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
  repo = mkdtempSync(join(TMP_BASE, "blame-cache-"));
  g(["init", "-q"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "Test"]);

  writeFileSync(join(repo, "f1.ts"), F1_V1);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "feat: add f1"]);

  writeFileSync(join(repo, "f1.ts"), F1_V2);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "feat: extend"]);

  writeFileSync(join(repo, "f2.ts"), F2_V1);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "fix: broken thing"]);

  writeFileSync(join(repo, "f1.ts"), F1_V3);
  writeFileSync(join(repo, "f2.ts"), F2_V2);
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "TD-123 update both"]);
});

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
  return new GitCommitDiscovery(repo, { maxAgeMonths: 6, timeoutMs: 120000 });
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

function persistedBlameJsonPath(): string {
  const dataDir = process.env.TEA_RAGS_DATA_DIR;
  if (!dataDir) throw new Error("blame-cache.test: TEA_RAGS_DATA_DIR not set by vitest.setup.ts");
  const hash16 = createHash("sha256").update(repo).digest("hex").slice(0, 16);
  return join(dataDir, "git-blame", hash16, "blame.json");
}

// Cold-run canonical overlays captured in test 1, pinned against in test 2.
let coldCanonical = "";

describe("OID-keyed blame cache (bd tea-rags-mcp-v2mlw, real git, sequential)", () => {
  it("COLD: first run blames every file, produces correct ownership, persists at finalize", async () => {
    const provider = new GitEnrichmentProvider();
    const onBlameStats = vi.fn();
    await provider.streamFileBatch(repo, ["f1.ts", "f2.ts"], { onBlameStats });

    expect(onBlameStats).toHaveBeenCalledTimes(1);
    expect(onBlameStats.mock.calls[0][0]).toMatchObject({ files: 2, hits: 0, misses: 2 });

    const overlays = await provider.buildChunkSignals(repo, fixtureChunkMap(), {
      skipCache: true,
      commitDiscovery: freshDiscovery() as never,
    });
    const c3 = overlays.get("f2.ts")?.get("c3") as { blameDominantAuthor: string } | undefined;
    expect(c3?.blameDominantAuthor).toBe("Test");
    coldCanonical = canonical(overlays);

    // The once-per-run seam persists the cache (and closes the OID reader).
    await provider.finalizeSignals();
  }, 30000);

  it("WARM EQUIVALENCE: fresh provider reuses persisted blame, overlays byte-equal to cold", async () => {
    const provider = new GitEnrichmentProvider();
    const onBlameStats = vi.fn();
    await provider.streamFileBatch(repo, ["f1.ts", "f2.ts"], { onBlameStats });

    expect(onBlameStats).toHaveBeenCalledTimes(1);
    expect(onBlameStats.mock.calls[0][0]).toMatchObject({ files: 2, hits: 2, misses: 0 });

    const overlays = await provider.buildChunkSignals(repo, fixtureChunkMap(), {
      skipCache: true,
      commitDiscovery: freshDiscovery() as never,
    });
    expect(coldCanonical).not.toBe("");
    expect(canonical(overlays)).toBe(coldCanonical);
    const c3 = overlays.get("f2.ts")?.get("c3") as { blameDominantAuthor: string } | undefined;
    expect(c3?.blameDominantAuthor).toBe("Test");

    // Direct pin: the persisted lines deep-equal a fresh inline blameFile.
    const stored = new GitBlameStore().load(repo);
    const inlineF1 = await blameFile(repo, "f1.ts", 60000);
    expect(inlineF1.length).toBeGreaterThan(0);
    expect(stored?.get("f1.ts")?.lines).toEqual(inlineF1);

    await provider.finalizeSignals();
  }, 30000);

  it("INVALIDATION: a new commit changing f1's OID re-blames exactly that file", async () => {
    writeFileSync(join(repo, "f1.ts"), `${F1_V3}f1 CACHE-BUST 13\n`);
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "feat: bust f1 blame cache"]);

    const provider = new GitEnrichmentProvider();
    const onBlameStats = vi.fn();
    await provider.streamFileBatch(repo, ["f1.ts", "f2.ts"], { onBlameStats });

    expect(onBlameStats).toHaveBeenCalledTimes(1);
    expect(onBlameStats.mock.calls[0][0]).toMatchObject({ files: 2, hits: 1, misses: 1 });

    const overlays = await provider.buildChunkSignals(repo, fixtureChunkMap(), {
      skipCache: true,
      commitDiscovery: freshDiscovery() as never,
    });
    const c3 = overlays.get("f2.ts")?.get("c3") as { blameDominantAuthor: string } | undefined;
    expect(c3?.blameDominantAuthor).toBe("Test");

    await provider.finalizeSignals();
  }, 30000);

  it("FALLBACK: corrupt persisted blame.json degrades to cold semantics (silent rebuild)", async () => {
    writeFileSync(persistedBlameJsonPath(), "{ definitely not json");

    const provider = new GitEnrichmentProvider();
    const onBlameStats = vi.fn();
    await provider.streamFileBatch(repo, ["f1.ts", "f2.ts"], { onBlameStats });

    expect(onBlameStats).toHaveBeenCalledTimes(1);
    const stats = onBlameStats.mock.calls[0][0] as { files: number; hits: number; misses: number };
    expect(stats.files).toBe(2);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(stats.files);

    await provider.finalizeSignals();
  }, 30000);
});
