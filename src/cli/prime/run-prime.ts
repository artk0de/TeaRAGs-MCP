import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseAppConfig } from "../../bootstrap/config/index.js";
import { createAppContext } from "../../bootstrap/factory.js";
import { resolveCollectionName } from "../../core/infra/collection-name.js";
import { CollectionRegistry } from "../../core/infra/registry/collection-registry.js";
import type { CollectionEntry } from "../../core/infra/registry/types.js";
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
function lookupRegistryEntry(input: { path?: string; project?: string }): CollectionEntry | null {
  const registry = new CollectionRegistry(resolveDataDir());
  if (input.project) {
    return registry.findByName(input.project);
  }
  if (input.path) {
    return registry.get(resolveCollectionName(input.path));
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
export async function runPrime(input: { path?: string; project?: string }): Promise<void> {
  const registryEntry = lookupRegistryEntry(input);
  const path = registryEntry?.path ?? input.path;

  if (!path) {
    process.stdout.write(
      formatPrime({
        kind: "path-not-found",
        path: input.project ? `(project '${input.project}' not registered)` : "(no path provided)",
      }),
    );
    return;
  }

  if (!existsSync(path)) {
    process.stdout.write(formatPrime({ kind: "path-not-found", path }));
    return;
  }

  const config = parseAppConfig();
  // Registry-first: prefer the registered qdrantUrl (the Qdrant the project was
  // indexed against). Fall back to heuristic only when the registry entry has
  // no qdrantUrl or no entry exists at all.
  const registryQdrantUrl = registryEntry?.qdrantUrl;
  const qdrantUrl = registryQdrantUrl && registryQdrantUrl.length > 0 ? registryQdrantUrl : discoverQdrantUrl(config);
  // Registry-first for embedding endpoints too: when the project was indexed
  // against a remote Ollama (and optionally a fallback), reuse those URLs
  // instead of letting the current shell's env silently downgrade prime to
  // localhost:11434. Symmetric with qdrantUrl above. Untouched for legacy
  // entries that pre-date embedding URL tracking (env value preserved).
  if (registryEntry?.embeddingBaseUrl || registryEntry?.embeddingFallbackUrl) {
    const configWithEmbedding = config as typeof config & {
      embedding?: { baseUrl?: string; fallbackBaseUrl?: string };
    };
    configWithEmbedding.embedding = {
      ...configWithEmbedding.embedding,
      ...(registryEntry.embeddingBaseUrl ? { baseUrl: registryEntry.embeddingBaseUrl } : {}),
      ...(registryEntry.embeddingFallbackUrl ? { fallbackBaseUrl: registryEntry.embeddingFallbackUrl } : {}),
    };
  }
  const reachable = await pingQdrant(qdrantUrl);
  if (!reachable) {
    process.stdout.write(formatPrime({ kind: "qdrant-cold", path }));
    return;
  }

  const ctx = await createAppContext(config);
  const updateService = (ctx as { updateService?: UpdateCheckService }).updateService ?? buildUpdateService();

  try {
    const [status, metricsResult, drift, update] = await Promise.allSettled([
      ctx.app.getIndexStatus(path),
      ctx.app.getIndexMetrics(path),
      ctx.app.checkSchemaDrift({ path }),
      updateService.checkForUpdate({
        allowNetwork: true,
        timeoutMs: 1500,
        preferCache: true,
      }),
    ]);

    if (status.status !== "fulfilled") {
      process.stdout.write(formatPrime({ kind: "qdrant-cold", path }));
      return;
    }

    const data: PrimeData = {
      path,
      projectName: registryEntry?.name ?? null,
      status: status.value,
      metrics: metricsResult.status === "fulfilled" ? metricsResult.value : null,
      drift: drift.status === "fulfilled" ? drift.value : null,
      update: update.status === "fulfilled" ? update.value : null,
    };
    process.stdout.write(formatPrime(data));
  } finally {
    ctx.cleanup?.();
  }
}
