/**
 * pickRegistryEntry for a linked worktree — config inheritance.
 *
 * Indexing a fresh worktree of an already-indexed repo used to seed the worker
 * env from "the most recently indexed project", which is whatever the operator
 * happened to touch last. The worktree is the same codebase as its main
 * checkout, so the checkout's entry is the right config to borrow: same
 * embedding backend, same tuning, same codegraph settings.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CollectionEntry } from "../../../../../src/core/api/public/index.js";
import {
  pickRegistryEntry,
  type RegistryLookup,
} from "../../../../../src/core/domains/maintenance/registry/env-resolution.js";

const TEST_TIMEOUT = 60000;

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function entry(name: string, path: string, indexedAt: string): CollectionEntry {
  return {
    collectionName: `code_${name}`,
    name,
    path,
    indexedAt,
    embeddingModel: "test-model",
    embeddingDimensions: 768,
    qdrantUrl: "embedded",
  } as CollectionEntry;
}

describe("pickRegistryEntry for a linked worktree", () => {
  let root: string;
  let mainCheckout: string;
  let linkedWorktree: string;
  let unrelated: string;
  let registry: RegistryLookup;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "registry-env-wt-"));
    mainCheckout = join(root, "main");
    linkedWorktree = join(root, "wt");
    unrelated = join(root, "unrelated");
    mkdirSync(mainCheckout, { recursive: true });
    mkdirSync(unrelated, { recursive: true });

    for (const repo of [mainCheckout, unrelated]) {
      git(["init", "-b", "master"], repo);
      git(["config", "user.email", "test@example.com"], repo);
      git(["config", "user.name", "Test"], repo);
      writeFileSync(join(repo, "a.txt"), "one\n");
      git(["add", "-A"], repo);
      git(["commit", "-m", "first"], repo);
    }
    git(["worktree", "add", "--detach", linkedWorktree, "HEAD"], mainCheckout);

    // The unrelated project is the MOST RECENTLY indexed — the old rule would
    // borrow its config for the worktree.
    const parent = entry("parent", mainCheckout, "2026-01-01T00:00:00Z");
    const other = entry("other", unrelated, "2026-06-20T00:00:00Z");
    registry = {
      findByName: (n) => [parent, other].find((e) => e.name === n) ?? null,
      findByPath: (p) => [parent, other].find((e) => e.path === p) ?? null,
      list: () => [parent, other],
    };
  }, TEST_TIMEOUT);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("borrows the main checkout's config rather than the last-indexed project", () => {
    expect(pickRegistryEntry(registry, { path: linkedWorktree })?.name).toBe("parent");
  });

  it("still prefers an exact path match when the worktree itself is registered", () => {
    expect(pickRegistryEntry(registry, { path: mainCheckout })?.name).toBe("parent");
  });

  it("falls back to the last-indexed project for a path from an unrelated repo", () => {
    const stranger = mkdtempSync(join(tmpdir(), "registry-env-stranger-"));
    try {
      expect(pickRegistryEntry(registry, { path: stranger })?.name).toBe("other");
    } finally {
      rmSync(stranger, { recursive: true, force: true });
    }
  });
});
