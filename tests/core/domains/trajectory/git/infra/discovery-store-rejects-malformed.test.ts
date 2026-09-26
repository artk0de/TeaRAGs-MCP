/**
 * Both persistent git discovery tiers — the commit matrix
 * (`GitCommitDiscoveryStore`) and the file-churn window
 * (`FileChurnDiscoveryStore`) — share one contract for what they find on disk:
 * ANY snapshot that is not exactly a valid v1 or v2 payload for this repo and
 * head loads as null, so the discovery rebuilds instead of trusting a partial
 * row; persistence failures never throw; and a v1 file still upgrades in memory
 * when the cache dir is read-only.
 *
 * Driven over both stores with the same malformed shapes, so a validator that
 * drifts in one of them fails here.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitCommitDiscoveryStore } from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery-store.js";
import { FileChurnDiscoveryStore } from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery-store.js";

const REPO_ROOT = "/some/repo";
const HEAD = "a".repeat(40);
const SINCE_ISO = "2026-01-04T00:00:00.000Z";

const COMMIT = {
  sha: "c".repeat(40),
  author: "Alice",
  authorEmail: "a@ex.com",
  timestamp: 1000,
  body: "x",
  parents: [],
};

interface DiscoveryStoreUnderTest {
  load: (repoRoot: string, head: string) => { version: number; entries: unknown[] } | null;
  loadLatest: (repoRoot: string) => { head: string } | null;
  save: (repoRoot: string, head: string, sinceIso: string, entries: never[]) => void;
}

interface StoreCase {
  name: string;
  make: (baseDir: string) => DiscoveryStoreUnderTest;
  validV2Entry: Record<string, unknown>;
  validV1Entry: Record<string, unknown>;
  /** v2 rows that are each wrong in exactly one way. */
  malformedV2Entries: [string, unknown][];
  /** v1 rows that are each wrong in exactly one way. */
  malformedV1Entries: [string, unknown][];
}

const sharedMalformedCommits: [string, unknown][] = [
  ["a null commit", null],
  ["a commit without an author", { ...COMMIT, author: undefined }],
  ["a commit whose parents are not strings", { ...COMMIT, parents: [1] }],
];

const CASES: StoreCase[] = [
  {
    name: "GitCommitDiscoveryStore",
    make: (baseDir) => new GitCommitDiscoveryStore(baseDir),
    validV2Entry: { commit: COMMIT, changedFiles: [{ path: "a.ts" }] },
    validV1Entry: { commit: COMMIT, changedFiles: ["src/{old.ts => new.ts}"] },
    malformedV2Entries: [
      ["a null row", null],
      ["changedFiles that is not an array", { commit: COMMIT, changedFiles: "a.ts" }],
      ["a null changed path", { commit: COMMIT, changedFiles: [null] }],
      ["a changed path without a path", { commit: COMMIT, changedFiles: [{ previousPath: "a.ts" }] }],
      ["a non-string previousPath", { commit: COMMIT, changedFiles: [{ path: "a.ts", previousPath: 3 }] }],
      ...sharedMalformedCommits.map(([label, commit]): [string, unknown] => [
        label,
        { commit, changedFiles: [{ path: "a.ts" }] },
      ]),
    ],
    malformedV1Entries: [
      ["a null row", null],
      ["changedFiles that are objects, not numstat strings", { commit: COMMIT, changedFiles: [{ path: "a.ts" }] }],
      ["a null commit", { commit: null, changedFiles: ["a.ts"] }],
    ],
  },
  {
    name: "FileChurnDiscoveryStore",
    make: (baseDir) => new FileChurnDiscoveryStore(baseDir),
    validV2Entry: { commit: COMMIT, committerTimestamp: 1000, files: [{ path: "a.ts", added: 1, deleted: 0 }] },
    validV1Entry: {
      commit: COMMIT,
      committerTimestamp: 1000,
      files: [{ path: "src/{old.ts => new.ts}", added: 1, deleted: 0 }],
    },
    malformedV2Entries: [
      ["a null row", null],
      ["files that is not an array", { commit: COMMIT, committerTimestamp: 1, files: {} }],
      ["a null file row", { commit: COMMIT, committerTimestamp: 1, files: [null] }],
      ["a file row without a path", { commit: COMMIT, committerTimestamp: 1, files: [{ added: 1, deleted: 0 }] }],
      [
        "a non-string previousPath",
        { commit: COMMIT, committerTimestamp: 1, files: [{ path: "a.ts", previousPath: 3, added: 1, deleted: 0 }] },
      ],
      ...sharedMalformedCommits.map(([label, commit]): [string, unknown] => [
        label,
        { commit, committerTimestamp: 1, files: [{ path: "a.ts", added: 1, deleted: 0 }] },
      ]),
    ],
    malformedV1Entries: [
      ["a null row", null],
      ["a row without committerTimestamp", { commit: COMMIT, files: [{ path: "a.ts", added: 1, deleted: 0 }] }],
      [
        "a file row with string counts",
        { commit: COMMIT, committerTimestamp: 1, files: [{ path: "a.ts", added: "1" }] },
      ],
    ],
  },
];

function repoDir(baseDir: string): string {
  return join(baseDir, createHash("sha256").update(REPO_ROOT).digest("hex").slice(0, 16));
}

describe.each(CASES)("$name — what it will not load", (c) => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "tr-discovery-malformed-"));
    mkdirSync(repoDir(baseDir), { recursive: true });
  });

  afterEach(() => {
    chmodSync(repoDir(baseDir), 0o755);
    rmSync(baseDir, { recursive: true, force: true });
  });

  const writeSnapshot = (payload: unknown, head = HEAD): void => {
    writeFileSync(join(repoDir(baseDir), `${head}.json`), JSON.stringify(payload));
  };
  const envelope = (over: Record<string, unknown>): Record<string, unknown> => ({
    version: 2,
    repoRoot: REPO_ROOT,
    head: HEAD,
    sinceIso: SINCE_ISO,
    entries: [c.validV2Entry],
    ...over,
  });

  it("loads the well-formed v2 envelope the malformed cases are cut from", () => {
    writeSnapshot(envelope({}));
    expect(c.make(baseDir).load(REPO_ROOT, HEAD)?.entries).toEqual([c.validV2Entry]);
  });

  it.each([
    ["a JSON null", null],
    ["a JSON number", 42],
    ["a non-string head", { head: 7 }],
    ["a non-string sinceIso", { sinceIso: null }],
    ["v2 entries that are not an array", { entries: {} }],
    ["v1 entries that are not an array", { version: 1, entries: {} }],
  ])("rejects %s", (_label, shape) => {
    writeSnapshot(shape !== null && typeof shape === "object" ? envelope(shape) : shape);
    expect(c.make(baseDir).load(REPO_ROOT, HEAD)).toBeNull();
  });

  it("rejects every v2 row that is wrong in a single way", () => {
    for (const [label, entry] of c.malformedV2Entries) {
      writeSnapshot(envelope({ entries: [c.validV2Entry, entry] }));
      expect(c.make(baseDir).load(REPO_ROOT, HEAD), label).toBeNull();
    }
  });

  it("rejects every v1 row that is wrong in a single way instead of half-upgrading it", () => {
    for (const [label, entry] of c.malformedV1Entries) {
      writeSnapshot(envelope({ version: 1, entries: [c.validV1Entry, entry] }));
      expect(c.make(baseDir).load(REPO_ROOT, HEAD), label).toBeNull();
    }
  });

  it("still upgrades a v1 snapshot in memory when the cache dir is read-only", () => {
    writeSnapshot(envelope({ version: 1, entries: [c.validV1Entry] }));
    chmodSync(repoDir(baseDir), 0o555);

    const loaded = c.make(baseDir).load(REPO_ROOT, HEAD);

    expect(loaded?.version).toBe(2);
    expect(loaded?.entries).toHaveLength(1);
    expect(JSON.stringify(loaded?.entries)).toContain('"previousPath":"src/old.ts"');
  });

  it("loadLatest ignores non-snapshot files, and answers null when only those exist", () => {
    writeFileSync(join(repoDir(baseDir), "notes.txt"), "not a snapshot");
    writeFileSync(join(repoDir(baseDir), `${HEAD}.json.tmp`), "{");
    const store = c.make(baseDir);

    expect(store.loadLatest(REPO_ROOT)).toBeNull();

    writeSnapshot(envelope({}));
    expect(store.loadLatest(REPO_ROOT)?.head).toBe(HEAD);
  });

  it("swallows a save it cannot persist and leaves nothing loadable behind", () => {
    const blocked = join(baseDir, "blocked");
    writeFileSync(blocked, "a file where the store expects a directory");
    const store = c.make(blocked);

    expect(() => {
      store.save(REPO_ROOT, HEAD, SINCE_ISO, []);
    }).not.toThrow();
    expect(store.load(REPO_ROOT, HEAD)).toBeNull();
    expect(readdirSync(baseDir)).toEqual(expect.arrayContaining(["blocked"]));
  });
});
