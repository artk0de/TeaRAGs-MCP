import { existsSync } from "node:fs";

import { parseAppConfig } from "../../bootstrap/config/index.js";
import { createAppContext } from "../../bootstrap/factory.js";
import { formatPrime } from "./format.js";
import { pingQdrant } from "./qdrant-ping.js";
import type { PrimeData } from "./types.js";

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
  const qdrantUrl = config.qdrantUrl ?? "http://localhost:6333";
  const reachable = await pingQdrant(qdrantUrl);
  if (!reachable) {
    process.stdout.write(formatPrime({ kind: "qdrant-cold", path }));
    return;
  }

  const ctx = await createAppContext(config);
  try {
    const [status, metricsResult, drift] = await Promise.allSettled([
      ctx.app.getIndexStatus(path),
      ctx.app.getIndexMetrics(path),
      ctx.app.checkSchemaDrift({ path }),
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
    };
    process.stdout.write(formatPrime(data));
  } finally {
    ctx.cleanup?.();
  }
}
