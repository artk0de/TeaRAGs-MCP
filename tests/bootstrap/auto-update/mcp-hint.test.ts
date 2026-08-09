import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildMcpAutoUpdateTrigger } from "../../../src/bootstrap/auto-update/mcp-hint.js";
import { spawnDetachedUpdater } from "../../../src/bootstrap/auto-update/spawner.js";
import { closeAutoUpdateLog, openAutoUpdateLog } from "../../../src/bootstrap/auto-update/updater-log.js";
import { CollectionRegistry, resolveCollectionName } from "../../../src/core/api/public/index.js";

// The default spawn path (no injected impl) really forks a detached CLI and
// opens a log fd. Both are stubbed so the wiring can be asserted without a
// child process or a stray file descriptor outliving the test.
vi.mock("../../../src/bootstrap/auto-update/spawner.js", async (importOriginal) => ({
  ...(await importOriginal()),
  spawnDetachedUpdater: vi.fn(),
}));

const STUB_LOG_FD = 7;

vi.mock("../../../src/bootstrap/auto-update/updater-log.js", async (importOriginal) => ({
  ...(await importOriginal()),
  openAutoUpdateLog: vi.fn(() => ({ fd: 7, path: "/tmp/auto-update-stub.log" })),
  closeAutoUpdateLog: vi.fn(),
}));

const created: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Minimal repo fixture with HEAD on master (file-based, no git spawn). */
function writeRepoOnMaster(): string {
  const dir = tmpDir("mcp-hint-repo-");
  mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/master\n");
  writeFileSync(join(dir, ".git", "refs", "heads", "master"), "abc123\n");
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, deadlineMs = 4000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("buildMcpAutoUpdateTrigger", () => {
  it("sees a config enabled AFTER construction (long-lived MCP server, registry watcher)", async () => {
    const dataDir = tmpDir("mcp-hint-data-");
    const repo = writeRepoOnMaster();
    const spawn = vi.fn();
    const trigger = buildMcpAutoUpdateTrigger(dataDir, spawn);

    // Server is up, project not registered yet → inert.
    expect(trigger.hintFor({ project: "p" })).toBeNull();

    // A DIFFERENT process (CLI `auto-update`) registers + enables afterwards.
    const external = new CollectionRegistry(dataDir);
    external.record({
      collectionName: "code_p",
      path: repo,
      embeddingModel: "m",
      embeddingDimensions: 384,
      qdrantUrl: "http://localhost:6333",
      indexedAt: "2026-08-06T00:00:00.000Z",
      teaRagsVersion: "1.0.0",
      chunksCount: 1,
    });
    external.setName("code_p", "p");
    external.setAutoUpdate("code_p", { enabled: true, targetBranch: "master" });

    // fs.watch invalidation is async — poll until the trigger's registry
    // cache refreshes and the eligible verdict spawns + hints.
    let hint: string | null = null;
    await waitFor(() => {
      hint = trigger.hintFor({ project: "p" });
      return hint !== null;
    });

    expect(hint).toBe("index updating in background");
    expect(spawn).toHaveBeenCalledWith("code_p");
  });
});

/** Registers a collection that already exists in the registry before the MCP
 *  server starts — the ordinary case, where no watcher round-trip is needed. */
function register(
  dataDir: string,
  collectionName: string,
  name: string,
  path: string,
  autoUpdate?: { enabled: boolean; targetBranch: string },
): void {
  const registry = new CollectionRegistry(dataDir);
  registry.record({
    collectionName,
    path,
    embeddingModel: "m",
    embeddingDimensions: 384,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-08-06T00:00:00.000Z",
    teaRagsVersion: "1.0.0",
    chunksCount: 1,
  });
  registry.setName(collectionName, name);
  if (autoUpdate) registry.setAutoUpdate(collectionName, autoUpdate);
}

/**
 * The hint is attached to a serving search response, so the resolution rules
 * matter twice over: an unresolvable request must cost nothing (no spawn, no
 * hint), and a resolvable one must reach the same collection the search itself
 * queried — verbatim `collection`, `project` via the alias, `path` via the
 * deterministic path-hash.
 */
describe("buildMcpAutoUpdateTrigger request resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("takes a verbatim collection and fires the default spawner through a per-project log", () => {
    const dataDir = tmpDir("mcp-hint-data-");
    const repo = writeRepoOnMaster();
    register(dataDir, "code_verbatim", "verbatim", repo, { enabled: true, targetBranch: "master" });

    // No spawn impl injected — this exercises the production wiring.
    const trigger = buildMcpAutoUpdateTrigger(dataDir);

    expect(trigger.hintFor({ collection: "code_verbatim" })).toBe("index updating in background");
    // The log is named after the human-facing project alias, not the hash.
    expect(vi.mocked(openAutoUpdateLog)).toHaveBeenCalledWith(dataDir, "verbatim");
    expect(vi.mocked(spawnDetachedUpdater)).toHaveBeenCalledWith({
      project: "code_verbatim",
      logFd: STUB_LOG_FD,
    });
    // The fd is handed to the detached child, then released by the parent.
    expect(vi.mocked(closeAutoUpdateLog)).toHaveBeenCalledTimes(1);
  });

  it("resolves a path request through the path-hash and reports why auto-update is paused", () => {
    const dataDir = tmpDir("mcp-hint-data-");
    // HEAD is on master, but the index was configured to follow main.
    const repo = writeRepoOnMaster();
    register(dataDir, resolveCollectionName(repo), "paused", repo, { enabled: true, targetBranch: "main" });

    const trigger = buildMcpAutoUpdateTrigger(dataDir);

    expect(trigger.hintFor({ path: repo })).toBe(
      "auto-update paused — HEAD not on target main; run index_codebase to switch the index",
    );
    expect(vi.mocked(spawnDetachedUpdater)).not.toHaveBeenCalled();
  });

  it("stays silent and inert for a request it cannot act on", () => {
    const dataDir = tmpDir("mcp-hint-data-");
    const repo = writeRepoOnMaster();
    // Registered and indexed, but the operator never enabled auto-update.
    register(dataDir, "code_off", "off", repo);

    const trigger = buildMcpAutoUpdateTrigger(dataDir);

    // Nothing named at all.
    expect(trigger.hintFor({})).toBeNull();
    // Named, but empty — an absent field, not a lookup key.
    expect(trigger.hintFor({ collection: "", project: "" })).toBeNull();
    // A real directory nobody ever indexed.
    expect(trigger.hintFor({ path: tmpDir("mcp-hint-unindexed-") })).toBeNull();
    // Indexed and resolvable, but auto-update is off.
    expect(trigger.hintFor({ project: "off" })).toBeNull();

    expect(vi.mocked(spawnDetachedUpdater)).not.toHaveBeenCalled();
  });
});
