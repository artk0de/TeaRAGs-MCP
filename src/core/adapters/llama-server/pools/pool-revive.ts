// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Restart-on-demand of a managed pool (spec "Restart after reboot"): pools are
 * not OS services, so after a reboot the first process that finds every
 * endpoint of a recorded pool silent starts it again from its record.
 */

import type { LlamaServerPools } from "./llama-server-pools.js";
import { readLlamaServerPoolRecords } from "./pool-registry.js";

function endpointKey(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Restart the recorded pool whose endpoints are exactly `endpoints` (order and
 * a trailing slash aside). `false` — without touching any process — when no
 * record matches (a user-run server, a remote host, a partial list), and when
 * the registry cannot be read or the restart fails: the caller then surfaces
 * its own connection error.
 */
export async function reviveManagedLlamaServerPool(
  endpoints: readonly string[],
  o: {
    pools: Pick<LlamaServerPools, "endpointsFor" | "restart">;
    dataDir: string;
    /** Why a revive failed (corrupt registry, restart error). Default: silent. */
    log?: (line: string) => void;
  },
): Promise<boolean> {
  const wanted = [...new Set(endpoints.map(endpointKey))].sort();
  try {
    const record = (await readLlamaServerPoolRecords(o.dataDir)).find((candidate) => {
      const recorded = o.pools.endpointsFor(candidate).map(endpointKey).sort();
      return recorded.length === wanted.length && recorded.every((url, i) => url === wanted[i]);
    });
    if (record === undefined) return false;
    await o.pools.restart(record);
    return true;
  } catch (error) {
    o.log?.(`[llama-server] managed pool revive failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
