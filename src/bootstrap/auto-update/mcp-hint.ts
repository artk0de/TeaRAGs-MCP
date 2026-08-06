/**
 * MCP-side auto-update trigger (hpg2, spec §3): implements the structural
 * `McpAutoUpdateTrigger` seam from `mcp/tools/explore.ts`. One instance per
 * MCP server process — the AutoUpdateTrigger inside carries the in-memory
 * TTL, so the freshness check itself runs at most once per 120 s per
 * collection regardless of tool-call rate.
 *
 * Request → collection resolution is registry-backed and cheap: `collection`
 * verbatim, `project` via alias lookup, `path` via the deterministic
 * path-hash. Unresolvable / unregistered requests return null (no hint,
 * no spawn) — the serving query is never affected.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { CollectionRegistry, IndexFreshnessCheck, resolveCollectionName } from "../../core/api/public/index.js";
import type { McpAutoUpdateTrigger } from "../../mcp/tools/explore.js";
import { spawnDetachedUpdater } from "./spawner.js";
import { AutoUpdateTrigger } from "./trigger.js";
import { closeAutoUpdateLog, openAutoUpdateLog } from "./updater-log.js";

function resolveRequestCollection(
  registry: CollectionRegistry,
  request: { collection?: string; project?: string; path?: string },
): string | null {
  if (request.collection !== undefined && request.collection.length > 0) return request.collection;
  if (request.project !== undefined && request.project.length > 0) {
    return registry.findByName(request.project)?.collectionName ?? null;
  }
  if (request.path !== undefined && request.path.length > 0) {
    try {
      return resolveCollectionName(request.path);
    } catch {
      return null;
    }
  }
  return null;
}

/** Canonical data-dir fallback — same rule as cli/registry-resolver. */
function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

export function buildMcpAutoUpdateTrigger(dataDir: string = resolveDataDir()): McpAutoUpdateTrigger {
  const registry = new CollectionRegistry(dataDir);
  const trigger = new AutoUpdateTrigger({
    registry,
    freshness: new IndexFreshnessCheck(),
    spawn: (project) => {
      const entry = registry.get(project);
      const log = openAutoUpdateLog(dataDir, entry?.name ?? project);
      spawnDetachedUpdater({ project, logFd: log.fd });
      closeAutoUpdateLog(log);
    },
    clock: () => Date.now(),
  });

  return {
    hintFor(request) {
      const collectionName = resolveRequestCollection(registry, request);
      if (collectionName === null) return null;
      const outcome = trigger.maybeSpawn(collectionName);
      if (outcome === "eligible") return "index updating in background";
      if (outcome === "branch-mismatch") {
        const target = registry.get(collectionName)?.autoUpdate?.targetBranch;
        return `auto-update paused — HEAD not on target${target !== undefined ? ` ${target}` : ""}; run index_codebase to switch the index`;
      }
      return null;
    },
  };
}
