/**
 * Persistent tier of the file-churn discovery cache — the numstat-preserving
 * sibling of GitCommitDiscoveryStore. Same layout
 * (`<baseDir>/<sha256(repoRoot).hex.slice(0,16)>/<head>.json`), atomic
 * tmp+rename writes, stale-HEAD drop on save, corrupt / mismatched / oversized
 * payloads degrade silently to null (rebuild semantics). A DISTINCT baseDir
 * subdir keeps it from colliding with the chunk snapshot.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommitFileNumstat, CommitInfo } from "../../../../../../src/core/adapters/vcs/types.js";
import { FileChurnDiscoveryStore } from "../../../../../../src/core/domains/trajectory/git/infra/file-churn-discovery-store.js";

const REPO_ROOT = "/some/repo";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const SINCE_ISO = "2026-01-04T00:00:00.000Z";

function commit(sha: string): CommitInfo {
  return { sha, author: "Alice", authorEmail: "alice@ex.com", timestamp: 1000, body: "feat: x", parents: [] };
}

function entries(): CommitFileNumstat[] {
  return [
    {
      commit: commit("c".repeat(40)),
      files: [
        { path: "a.ts", added: 3, deleted: 1 },
        { path: "b.ts", added: 0, deleted: 0 },
      ],
    },
  ];
}

function repoDir(baseDir: string): string {
  return join(baseDir, createHash("sha256").update(REPO_ROOT).digest("hex").slice(0, 16));
}

describe("FileChurnDiscoveryStore", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "tr-file-churn-discovery-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("round-trips save → load(repoRoot, head)", () => {
    const store = new FileChurnDiscoveryStore(baseDir);
    store.save(REPO_ROOT, HEAD_A, SINCE_ISO, entries());

    const loaded = store.load(REPO_ROOT, HEAD_A);

    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(1);
    expect(loaded?.repoRoot).toBe(REPO_ROOT);
    expect(loaded?.head).toBe(HEAD_A);
    expect(loaded?.sinceIso).toBe(SINCE_ISO);
    expect(loaded?.entries).toEqual(entries());
  });

  it("returns null for a missing file", () => {
    const store = new FileChurnDiscoveryStore(baseDir);
    expect(store.load(REPO_ROOT, HEAD_A)).toBeNull();
    expect(store.loadLatest(REPO_ROOT)).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    const store = new FileChurnDiscoveryStore(baseDir);
    mkdirSync(repoDir(baseDir), { recursive: true });
    writeFileSync(join(repoDir(baseDir), `${HEAD_A}.json`), "{not json!!");

    expect(store.load(REPO_ROOT, HEAD_A)).toBeNull();
    expect(store.loadLatest(REPO_ROOT)).toBeNull();
  });

  it("returns null on version mismatch", () => {
    const store = new FileChurnDiscoveryStore(baseDir);
    mkdirSync(repoDir(baseDir), { recursive: true });
    writeFileSync(
      join(repoDir(baseDir), `${HEAD_A}.json`),
      JSON.stringify({ version: 2, repoRoot: REPO_ROOT, head: HEAD_A, sinceIso: SINCE_ISO, entries: entries() }),
    );

    expect(store.load(REPO_ROOT, HEAD_A)).toBeNull();
  });

  it("returns null on repoRoot mismatch (hash-collision guard)", () => {
    const store = new FileChurnDiscoveryStore(baseDir);
    mkdirSync(repoDir(baseDir), { recursive: true });
    writeFileSync(
      join(repoDir(baseDir), `${HEAD_A}.json`),
      JSON.stringify({ version: 1, repoRoot: "/other/repo", head: HEAD_A, sinceIso: SINCE_ISO, entries: entries() }),
    );

    expect(store.load(REPO_ROOT, HEAD_A)).toBeNull();
  });

  it("returns null on a malformed entry (bad files shape)", () => {
    const store = new FileChurnDiscoveryStore(baseDir);
    mkdirSync(repoDir(baseDir), { recursive: true });
    writeFileSync(
      join(repoDir(baseDir), `${HEAD_A}.json`),
      JSON.stringify({
        version: 1,
        repoRoot: REPO_ROOT,
        head: HEAD_A,
        sinceIso: SINCE_ISO,
        entries: [{ commit: commit("c".repeat(40)), files: [{ path: "a.ts", added: "nope", deleted: 1 }] }],
      }),
    );

    expect(store.load(REPO_ROOT, HEAD_A)).toBeNull();
  });

  it("drops stale head files on save; loadLatest returns the new head", () => {
    const store = new FileChurnDiscoveryStore(baseDir);
    store.save(REPO_ROOT, HEAD_A, SINCE_ISO, entries());
    expect(existsSync(join(repoDir(baseDir), `${HEAD_A}.json`))).toBe(true);

    store.save(REPO_ROOT, HEAD_B, SINCE_ISO, entries());

    expect(existsSync(join(repoDir(baseDir), `${HEAD_A}.json`))).toBe(false);
    expect(existsSync(join(repoDir(baseDir), `${HEAD_B}.json`))).toBe(true);
    expect(store.loadLatest(REPO_ROOT)?.head).toBe(HEAD_B);
    const raw = JSON.parse(readFileSync(join(repoDir(baseDir), `${HEAD_B}.json`), "utf8")) as { head: string };
    expect(raw.head).toBe(HEAD_B);
  });

  it("skips save silently when the payload exceeds maxBytes", () => {
    const store = new FileChurnDiscoveryStore(baseDir, 16);
    store.save(REPO_ROOT, HEAD_A, SINCE_ISO, entries());

    expect(store.load(REPO_ROOT, HEAD_A)).toBeNull();
    expect(existsSync(join(repoDir(baseDir), `${HEAD_A}.json`))).toBe(false);
  });
});
