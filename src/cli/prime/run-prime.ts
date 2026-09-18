import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { spawnDetachedUpdater } from "../../bootstrap/auto-update/spawner.js";
import { AutoUpdateTrigger, type AutoUpdateTriggerOutcome } from "../../bootstrap/auto-update/trigger.js";
import { autoUpdateLogPath, closeAutoUpdateLog, openAutoUpdateLog } from "../../bootstrap/auto-update/updater-log.js";
import { parseAppConfig } from "../../bootstrap/config/index.js";
import { createAppContext } from "../../bootstrap/factory.js";
import {
  CollectionRegistry,
  createPathCollectionResolver,
  IndexFreshnessCheck,
  replayRegistryEnv,
  type CollectionEntry,
} from "../../core/api/public/index.js";
import { FileCacheStore } from "../update-check/cache-store.js";
import { UpdateCheckService } from "../update-check/check-service.js";
import { NpmRegistryClient } from "../update-check/registry-client.js";
import { PackageJsonVersionSource } from "../update-check/version-source.js";
import { formatPrime } from "./format.js";
import { discoverQdrantUrl } from "./qdrant-discovery.js";
import { pingQdrant } from "./qdrant-ping.js";
import type { PrimeData } from "./types.js";

function buildUpdateService(): UpdateCheckService {
  return new UpdateCheckService(new PackageJsonVersionSource(), new NpmRegistryClient(), new FileCacheStore());
}

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

/**
 * Look up a registry entry by project name (alias) or by path. Project alias
 * wins when both are provided. Returns null when the registry has no matching
 * entry — caller falls back to heuristic discovery.
 */
async function lookupRegistryEntry(input: { path?: string; project?: string }): Promise<CollectionEntry | null> {
  const registry = new CollectionRegistry(resolveDataDir());
  if (input.project) {
    return registry.findByName(input.project);
  }
  if (input.path) {
    // Through the shared resolver: the entry that CLAIMS the path wins, and the
    // path hash is only its fallback. Hashing here printed "not indexed" for a
    // project whose directory had moved, while its index sat under the
    // collection the entry recorded (bd tea-rags-mcp-dxa9w).
    return registry.get(await createPathCollectionResolver(registry)(input.path));
  }
  return null;
}

/**
 * Run prime: emit a markdown digest of index state to stdout.
 * Always exits 0 — degrades to placeholder when path missing or Qdrant cold.
 *
 * Resolution priority for path + Qdrant URL:
 *   1. Registered project entry (lookup by --project alias or --path).
 *      Uses entry.path for path and entry.qdrantUrl for Qdrant.
 *   2. Heuristic: discoverQdrantUrl + the provided --path.
 */
/**
 * Default auto-update trigger for prime (hpg2): freshness check + detached
 * spawn with the per-project log fd. Constructed only when a registry entry
 * matched. The spawn is fire-and-forget (~10 ms) — SessionStart latency stays
 * untouched; the parent's log fd is closed right after the child inherits it.
 */
function buildPrimeAutoUpdateTrigger(entry: CollectionEntry, dataDir: string): AutoUpdateTrigger {
  const label = entry.name ?? entry.collectionName;
  return new AutoUpdateTrigger({
    registry: new CollectionRegistry(dataDir),
    freshness: new IndexFreshnessCheck(),
    spawn: (project) => {
      const log = openAutoUpdateLog(dataDir, label);
      spawnDetachedUpdater({ project, logFd: log.fd });
      closeAutoUpdateLog(log);
    },
    clock: () => Date.now(),
  });
}

export async function runPrime(input: {
  path?: string;
  project?: string;
  /** Test seam — production builds the real trigger via buildPrimeAutoUpdateTrigger. */
  autoUpdateTrigger?: { maybeSpawn: (collectionName: string) => AutoUpdateTriggerOutcome };
}): Promise<void> {
  // Path resolution priority: explicit --path, then --project alias (via
  // registry), then the current working directory. The cwd fallback covers
  // hooks whose $CLAUDE_PROJECT_DIR expanded empty (`prime ""`): prime then
  // resolves the cwd's registered project instead of erroring "no path
  // provided". An explicit but unregistered --project keeps its own error —
  // cwd would mask the caller's stated intent.
  const hasExplicitPath = typeof input.path === "string" && input.path.length > 0;
  const requestedPath = hasExplicitPath ? input.path : input.project ? undefined : process.cwd();

  const registryEntry = await lookupRegistryEntry({ path: requestedPath, project: input.project });
  const path = registryEntry?.path ?? requestedPath;

  if (!path) {
    // Only reachable when --project was given but is absent from the registry;
    // a missing path with no project resolved to cwd above.
    process.stdout.write(formatPrime({ kind: "path-not-found", path: `(project '${input.project}' not registered)` }));
    return;
  }

  if (!existsSync(path)) {
    process.stdout.write(formatPrime({ kind: "path-not-found", path }));
    return;
  }

  // Registry-first for embedding endpoints: when the project was indexed
  // against a remote Ollama (and optionally a fallback), reuse those URLs
  // instead of letting the current shell's env silently downgrade prime to
  // localhost:11434. Symmetric with qdrantUrl below. Untouched for legacy
  // entries that pre-date embedding URL tracking (env value preserved).
  //
  // Mechanism: set process.env BEFORE parseAppConfig so parseAppConfigZod
  // picks up the override and caches it into _lastZodConfig. createAppContext
  // reads embedding URLs from getZodConfig() (NOT from the AppConfig returned
  // by parseAppConfig), so the env channel is the only mutation site that
  // actually propagates downstream. runPrime is a CLI single-shot; env
  // mutation persists for the process lifetime, which is fine here.
  if (registryEntry?.embeddingBaseUrl) {
    process.env.EMBEDDING_BASE_URL = registryEntry.embeddingBaseUrl;
  }
  if (registryEntry?.embeddingFallbackUrl) {
    process.env.EMBEDDING_FALLBACK_URL = registryEntry.embeddingFallbackUrl;
  }
  // Codegraph is gated by CODEGRAPH_ENABLED, read from env at parseAppConfig
  // time. When the project was indexed with codegraph (the MCP server's env
  // carried the flag), re-apply it here so the prime composition declares the
  // codegraph signal descriptors and does not report a phantom "removed
  // fields" schema drift. Symmetric with the embedding URL overrides above;
  // legacy entries (field undefined) keep the shell's env untouched.
  if (registryEntry?.codegraphEnabled) {
    process.env.CODEGRAPH_ENABLED = "true";
  }
  // Registry env re-apply (same seam as CODEGRAPH_ENABLED above): the project
  // was indexed with this env set in the indexing process (typically the MCP
  // server's env block), but prime runs in a fresh shell without it. Unlike
  // the embedding URL overrides, explicit shell env WINS over the stored
  // value — only unset alias groups are seeded (outer env > registry env >
  // code default). Empty-string env values count as unset, matching
  // envWithFallback. Legacy entries fall back to the deprecated `tuning` map.
  replayRegistryEnv(registryEntry?.env ?? registryEntry?.tuning, process.env);
  const config = parseAppConfig();
  // Registry-first: prefer the registered qdrantUrl (the Qdrant the project was
  // indexed against). The "embedded" sentinel (2nfdm) is not a pingable URL —
  // resolve it through discovery (daemon.port) like a missing entry; same for
  // legacy embedded entries whose frozen ephemeral port is stale after a
  // daemon restart (qdrantEmbedded flag without the sentinel).
  const registryQdrantUrl = registryEntry?.qdrantUrl;
  const usableRegistryUrl =
    registryQdrantUrl &&
    registryQdrantUrl.length > 0 &&
    registryQdrantUrl !== "embedded" &&
    registryEntry?.qdrantEmbedded !== true
      ? registryQdrantUrl
      : undefined;
  const qdrantUrl = usableRegistryUrl ?? discoverQdrantUrl(config);
  const reachable = await pingQdrant(qdrantUrl);
  if (!reachable) {
    process.stdout.write(formatPrime({ kind: "qdrant-cold", path }));
    return;
  }

  const ctx = await createAppContext(config);
  const updateService = (ctx as { updateService?: UpdateCheckService }).updateService ?? buildUpdateService();

  try {
    const statusRequest = ctx.app.getIndexStatus(path);
    // The memory report addresses the collection the status resolved, so it
    // chains on status and still overlaps the reads below. A report that cannot
    // be read settles rejected or null — the digest just drops the section.
    const memoryRequest = statusRequest.then(async (resolved) =>
      resolved.status === "indexed" && resolved.collectionName
        ? ctx.app.getCollectionMemory(resolved.collectionName)
        : null,
    );
    const [status, metricsResult, drift, update, memory] = await Promise.allSettled([
      statusRequest,
      ctx.app.getIndexMetrics(path),
      // Inspection, like get_index_status — the digest must read the same way
      // every time it is rendered, and the once-per-session warning belongs to
      // the search path. (This process is short-lived, so consuming would cost
      // nothing here in practice; it is stated anyway so the call site and the
      // contract agree.)
      ctx.app.checkIndexDrift({ path, consume: false }),
      updateService.checkForUpdate({
        allowNetwork: true,
        timeoutMs: 1500,
        preferCache: true,
      }),
      memoryRequest,
    ]);

    if (status.status !== "fulfilled") {
      process.stdout.write(formatPrime({ kind: "qdrant-cold", path }));
      return;
    }

    // Auto-update trigger (hpg2): verdict computed BEFORE render so the
    // digest reflects it; the eligible-path spawn is detached fire-and-forget.
    const autoUpdateOutcome = registryEntry
      ? (input.autoUpdateTrigger ?? buildPrimeAutoUpdateTrigger(registryEntry, resolveDataDir())).maybeSpawn(
          registryEntry.collectionName,
        )
      : null;

    const data: PrimeData = {
      path,
      projectName: registryEntry?.name ?? null,
      registry: registryEntry,
      status: status.value,
      metrics: metricsResult.status === "fulfilled" ? metricsResult.value : null,
      drift: drift.status === "fulfilled" ? drift.value : null,
      update: update.status === "fulfilled" ? update.value : null,
      memory: memory.status === "fulfilled" ? memory.value : null,
      autoUpdateOutcome,
      ...(registryEntry
        ? { autoUpdateLogPath: autoUpdateLogPath(resolveDataDir(), registryEntry.name ?? registryEntry.collectionName) }
        : {}),
    };
    // DEBUG decides how much of the codegraph resolve tally the digest shows —
    // taken from the parsed config, the same flag the runtime debug state uses.
    process.stdout.write(formatPrime(data, new Date(), { debug: config.debug }));
  } finally {
    // Best-effort teardown (synchronous, fire-and-forget by design — see
    // factory.ts). The guaranteed reap is process.exit(0) in the prime command
    // handler: it terminates the process so the OS releases the DuckDB file
    // lock and undici keep-alive sockets that previously kept prime alive and
    // hung the SessionStart hook until timeout.
    ctx.cleanup?.();
  }
}
