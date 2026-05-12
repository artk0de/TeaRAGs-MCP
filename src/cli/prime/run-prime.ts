import { existsSync } from "node:fs";

import { parseAppConfig } from "../../bootstrap/config/index.js";
import { createAppContext } from "../../bootstrap/factory.js";
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

/**
 * Run prime: emit a markdown digest of index state to stdout.
 * Always exits 0 — degrades to placeholder when path missing or Qdrant cold.
 */
export async function runPrime(path: string): Promise<void> {
  if (!existsSync(path)) {
    process.stdout.write(formatPrime({ kind: "path-not-found", path }));
    return;
  }

  const config = parseAppConfig();
  const qdrantUrl = discoverQdrantUrl(config);
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
