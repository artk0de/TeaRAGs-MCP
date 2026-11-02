import {
  CollectionRegistry,
  IndexFreshnessCheck,
  resolveWorkingTree,
  type CollectionEntry,
} from "../core/api/entry-points/prime/index.js";
import { spawnDetachedUpdater } from "./auto-update/spawner.js";
import { AutoUpdateTrigger, type AutoUpdateTriggerOutcome } from "./auto-update/trigger.js";
import { closeAutoUpdateLog, openAutoUpdateLog } from "./auto-update/updater-log.js";
import { appDataDir } from "./config/paths.js";

export interface PrimeAgentProject {
  entry: CollectionEntry;
  path: string;
}

export function resolvePrimeAgentProject(
  input: { path?: string; project?: string },
  dataDir = appDataDir(),
): PrimeAgentProject | null {
  const registry = new CollectionRegistry(dataDir);
  try {
    const tree = resolveWorkingTree(registry, input);
    const entry = registry.get(tree.baseIndex.collectionName);
    return entry ? { entry, path: tree.root || entry.path } : null;
  } catch {
    // No invented collection hash or alias on a failed/unknown binding.
    return null;
  }
}

/** Compose existing eligibility policy without exposing core assembly to CLI. */
export function buildPrimeAgentAutoUpdateTrigger(entry: CollectionEntry, dataDir = appDataDir()): AutoUpdateTrigger {
  return new AutoUpdateTrigger({
    registry: new CollectionRegistry(dataDir),
    freshness: new IndexFreshnessCheck(),
    spawn: (project) => {
      const log = openAutoUpdateLog(dataDir, entry.name ?? entry.collectionName);
      spawnDetachedUpdater({ project, logFd: log.fd });
      closeAutoUpdateLog(log);
    },
    clock: () => Date.now(),
  });
}

export { appDataDir };
export type { AutoUpdateTriggerOutcome, CollectionEntry };
export { formatAgentDigest } from "../mcp/resources/project/digest.js";
