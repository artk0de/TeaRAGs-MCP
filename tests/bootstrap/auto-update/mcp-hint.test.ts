import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMcpAutoUpdateTrigger } from "../../../src/bootstrap/auto-update/mcp-hint.js";
import { CollectionRegistry } from "../../../src/core/api/public/index.js";

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
