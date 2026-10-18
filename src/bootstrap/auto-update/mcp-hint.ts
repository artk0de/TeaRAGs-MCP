/**
 * MCP-side auto-update trigger (hpg2, spec §3): implements the structural
 * `McpAutoUpdateTrigger` port from `core/api/public`
 * (`auto-update-trigger.ts`). One instance per MCP server process — the
 * AutoUpdateTrigger inside carries the in-memory TTL, so the freshness check
 * itself runs at most once per 120 s per collection regardless of tool-call
 * rate.
 *
 * Request → collection resolution is registry-backed and cheap: `collection`
 * verbatim, `project` via alias lookup, `path` through the shared resolver
 * (registry entry first, path hash for a path nothing claims). Unresolvable /
 * unregistered requests return null (no hint, no spawn) — the serving query is
 * never affected.
 */

import { homedir } from "node:os";
import { join } from "node:path";

// The auto-update entry point, not the api barrel (bd tea-rags-mcp-54xwd.3): the
// barrel gave auto-update an SDP edge into api, and the declaring domain leaves
// break the bootstrap -> core/api direction pin.
import {
  collectionHoldsCodegraphData,
  CollectionRegistry,
  IndexFreshnessCheck,
  outerEnvForRegistryEntry,
} from "../../core/api/entry-points/auto-update/index.js";
import type { McpAutoUpdateTrigger } from "../../core/api/public/index.js";
import type { RegistryLookup } from "../../core/contracts/types/registry.js";
import { resolveRegistryEnvCodeDefaults } from "../config/index.js";
import { spawnDetachedUpdater } from "./spawner.js";
import { AutoUpdateTrigger } from "./trigger.js";
import { closeAutoUpdateLog, openAutoUpdateLog } from "./updater-log.js";

/**
 * The api-side resolvers this hint builds with — injected by the composition
 * root (bd tea-rags-mcp-54xwd.3): naming them from the api barrel here closed
 * the SDP auto-update -> api edge. The env-defaults shape is derived from the
 * bootstrap config's own signature, so no api type is named either.
 */
export interface McpAutoUpdateApiResolvers {
  resolveCollection: (registry: RegistryLookup, input: { path: string }) => { collectionName: string };
  resolveDomainEnvCodeDefaults: () => Parameters<typeof resolveRegistryEnvCodeDefaults>[0];
}

function resolveRequestCollection(
  registry: CollectionRegistry,
  resolvers: Pick<McpAutoUpdateApiResolvers, "resolveCollection">,
  request: { collection?: string; project?: string; path?: string },
): string | null {
  if (request.collection !== undefined && request.collection.length > 0) return request.collection;
  if (request.project !== undefined && request.project.length > 0) {
    return registry.findByName(request.project)?.collectionName ?? null;
  }
  if (request.path !== undefined && request.path.length > 0) {
    try {
      // Through the owner, not the path hash: a project that moved keeps the
      // collection its registry entry recorded, and the hint has to name the
      // collection the SEARCH just queried (bd tea-rags-mcp-dxa9w).
      return resolvers.resolveCollection(registry, { path: request.path }).collectionName;
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

export function buildMcpAutoUpdateTrigger(
  resolvers: McpAutoUpdateApiResolvers,
  dataDir: string = resolveDataDir(),
  spawnImpl?: (project: string) => void,
): McpAutoUpdateTrigger {
  const registry = new CollectionRegistry(dataDir, {
    envCodeDefaults: () => resolveRegistryEnvCodeDefaults(resolvers.resolveDomainEnvCodeDefaults()),
    codegraphDataProbe: collectionHoldsCodegraphData,
  });
  // The MCP server is LONG-LIVED and CollectionRegistry caches registry.json
  // in memory — without the watcher, `tea-rags auto-update` config written
  // AFTER server start stays invisible until the next reconnect. The watcher
  // invalidates the cache on every external registry write (Audit #2 seam).
  registry.startWatching();
  const trigger = new AutoUpdateTrigger({
    registry,
    freshness: new IndexFreshnessCheck(),
    spawn:
      spawnImpl ??
      ((project) => {
        const entry = registry.get(project);
        const log = openAutoUpdateLog(dataDir, entry?.name ?? project);
        // The updater is this server's index run by delegation, but it replays
        // the registry as a CLI invocation — so it gets the server env the way
        // the server itself treats it, with the project's stamped index shape
        // carved out (tea-rags-mcp-o0qsw). Nothing carved → plain inheritance.
        const env = outerEnvForRegistryEntry(entry, process.env, "server");
        spawnDetachedUpdater({ project, logFd: log.fd, ...(env === process.env ? {} : { env }) });
        closeAutoUpdateLog(log);
      }),
    clock: () => Date.now(),
  });

  return {
    hintFor(request) {
      const collectionName = resolveRequestCollection(registry, resolvers, request);
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
