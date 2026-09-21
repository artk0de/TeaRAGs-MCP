/**
 * bd tea-rags-mcp-0dwsn — v1 → v2 upgrade of the two git discovery snapshots.
 *
 * Both stores persist numstat paths: the commit-discovery matrix as
 * `changedFiles`, the file-churn window as `files[].path`. v1 wrote whatever
 * `git log --numstat` printed, so every renamed file sits on disk as a mangled
 * `pre{old => new}post` column. That string CONTAINS both paths, so the upgrade
 * is computable from the file alone — which, per `.claude/rules/migrations.md`,
 * makes it a migration and not a rebuild: a v1 snapshot is transformed on load,
 * used, and rewritten at v2. Nothing is discarded and no reindex is implied.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitCommitDiscoveryStore } from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery-store.js";
import { FileChurnDiscoveryStore } from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery-store.js";

const REPO_ROOT = "/some/repo";
const HEAD = "a".repeat(40);
const SINCE_ISO = "2026-01-04T00:00:00.000Z";
const COMMIT_SHA = "c".repeat(40);

const commit = {
  sha: COMMIT_SHA,
  author: "Alice",
  authorEmail: "alice@ex.com",
  timestamp: 1000,
  body: "refactor: move things",
  parents: [],
};

/** Every mangled shape a v1 snapshot can be holding, plus a plain path. */
const V1_PATHS = [
  "src/bootstrap/config/{tuning-snapshot.ts => env-snapshot.ts}",
  "src/core/domains/maintenance/{ => drift}/schema-drift-monitor.ts",
  "src/core/{domains/ingest => }/infra/score-background.ts",
  "verify-providers.js => scripts/verify-providers.js",
  '"src/\\320\\277.ts"',
  "src/bootstrap/factory.ts",
];

const EXPECTED_PAIRS = [
  { path: "src/bootstrap/config/env-snapshot.ts", previousPath: "src/bootstrap/config/tuning-snapshot.ts" },
  {
    path: "src/core/domains/maintenance/drift/schema-drift-monitor.ts",
    previousPath: "src/core/domains/maintenance/schema-drift-monitor.ts",
  },
  {
    path: "src/core/infra/score-background.ts",
    previousPath: "src/core/domains/ingest/infra/score-background.ts",
  },
  { path: "scripts/verify-providers.js", previousPath: "verify-providers.js" },
  { path: "src/п.ts" },
  { path: "src/bootstrap/factory.ts" },
];

function repoDir(baseDir: string): string {
  return join(baseDir, createHash("sha256").update(REPO_ROOT).digest("hex").slice(0, 16));
}

function writeSnapshot(baseDir: string, payload: unknown): string {
  const dir = repoDir(baseDir);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${HEAD}.json`);
  writeFileSync(target, JSON.stringify(payload));
  return target;
}

describe("GitCommitDiscoveryStore — v1 snapshot upgrade (bd tea-rags-mcp-0dwsn)", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "tr-git-discovery-v1-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("upgrades a v1 snapshot in place rather than discarding it", () => {
    writeSnapshot(baseDir, {
      version: 1,
      repoRoot: REPO_ROOT,
      head: HEAD,
      sinceIso: SINCE_ISO,
      entries: [{ commit, changedFiles: V1_PATHS }],
    });

    const loaded = new GitCommitDiscoveryStore(baseDir).load(REPO_ROOT, HEAD);

    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(2);
    expect(loaded?.sinceIso).toBe(SINCE_ISO);
    expect(loaded?.entries[0].changedFiles).toEqual(EXPECTED_PAIRS);
  });

  it("rewrites the upgraded snapshot at v2 so the next load needs no transform", () => {
    const target = writeSnapshot(baseDir, {
      version: 1,
      repoRoot: REPO_ROOT,
      head: HEAD,
      sinceIso: SINCE_ISO,
      entries: [{ commit, changedFiles: V1_PATHS }],
    });

    const store = new GitCommitDiscoveryStore(baseDir);
    store.load(REPO_ROOT, HEAD);

    const onDisk = JSON.parse(readFileSync(target, "utf8")) as { version: number };
    expect(onDisk.version).toBe(2);
    // Round trip: reloading the rewritten file yields the same pairs.
    expect(store.load(REPO_ROOT, HEAD)?.entries[0].changedFiles).toEqual(EXPECTED_PAIRS);
  });

  it("finds and upgrades a v1 snapshot through loadLatest too", () => {
    writeSnapshot(baseDir, {
      version: 1,
      repoRoot: REPO_ROOT,
      head: HEAD,
      sinceIso: SINCE_ISO,
      entries: [{ commit, changedFiles: V1_PATHS }],
    });

    const loaded = new GitCommitDiscoveryStore(baseDir).loadLatest(REPO_ROOT);

    expect(loaded?.version).toBe(2);
    expect(loaded?.entries[0].changedFiles).toEqual(EXPECTED_PAIRS);
  });

  it("still rejects a snapshot whose version is neither 1 nor 2", () => {
    writeSnapshot(baseDir, {
      version: 99,
      repoRoot: REPO_ROOT,
      head: HEAD,
      sinceIso: SINCE_ISO,
      entries: [{ commit, changedFiles: [{ path: "a.ts" }] }],
    });

    expect(new GitCommitDiscoveryStore(baseDir).load(REPO_ROOT, HEAD)).toBeNull();
  });
});

describe("FileChurnDiscoveryStore — v1 snapshot upgrade (bd tea-rags-mcp-0dwsn)", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "tr-file-churn-v1-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("upgrades v1 per-file numstat rows, keeping the +/- counts", () => {
    writeSnapshot(baseDir, {
      version: 1,
      repoRoot: REPO_ROOT,
      head: HEAD,
      sinceIso: SINCE_ISO,
      entries: [
        {
          commit,
          committerTimestamp: 1001,
          files: V1_PATHS.map((path, i) => ({ path, added: i, deleted: i * 2 })),
        },
      ],
    });

    const loaded = new FileChurnDiscoveryStore(baseDir).load(REPO_ROOT, HEAD);

    expect(loaded?.version).toBe(2);
    expect(loaded?.entries[0].files).toEqual(EXPECTED_PAIRS.map((pair, i) => ({ ...pair, added: i, deleted: i * 2 })));
  });

  it("rewrites the upgraded file-churn snapshot at v2", () => {
    const target = writeSnapshot(baseDir, {
      version: 1,
      repoRoot: REPO_ROOT,
      head: HEAD,
      sinceIso: SINCE_ISO,
      entries: [{ commit, committerTimestamp: 1001, files: [{ path: V1_PATHS[0], added: 39, deleted: 14 }] }],
    });

    const store = new FileChurnDiscoveryStore(baseDir);
    store.load(REPO_ROOT, HEAD);

    expect((JSON.parse(readFileSync(target, "utf8")) as { version: number }).version).toBe(2);
    expect(store.load(REPO_ROOT, HEAD)?.entries[0].files).toEqual([{ ...EXPECTED_PAIRS[0], added: 39, deleted: 14 }]);
  });
});
