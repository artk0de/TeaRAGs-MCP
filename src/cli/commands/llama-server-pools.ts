/**
 * `tea-rags llama-server start|stop|status` — managed llama-server pools: one
 * catalog model on N detached instances bound to random loopback ports,
 * recorded in `<data dir>/llama-server/pools.json`. Work runs over injected
 * deps so tests use object literals.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { LlamaServerPools, productionLlamaServerPoolsDeps } from "../../core/api/index.js";
import { InvalidParameterError } from "../../core/api/public/index.js";
import { whichOnPath } from "./llama-server-install.js";

/** A pool below two instances leaves the provider no endpoint to fail over to. */
const MIN_POOL_INSTANCES = 2;

export interface LlamaServerPoolsCommandDeps {
  pools: Pick<LlamaServerPools, "start" | "stop" | "status" | "endpointsFor">;
  out: (line: string) => void;
}

export interface LlamaServerStartArgs {
  model: string;
  instances: number;
  slots: number;
  gpuLayers: number;
  flashAttention: boolean;
}

/** Start the pool; prints ONE JSON line `{ model, endpoints, instances }`. */
export async function runLlamaServerStart(
  args: LlamaServerStartArgs,
  deps: LlamaServerPoolsCommandDeps,
): Promise<void> {
  if (!Number.isInteger(args.instances) || args.instances < MIN_POOL_INSTANCES) {
    throw new InvalidParameterError("instances", `--instances must be an integer ≥ ${MIN_POOL_INSTANCES}`);
  }
  const record = await deps.pools.start(args);
  deps.out(
    JSON.stringify({ model: record.model, endpoints: deps.pools.endpointsFor(record), instances: record.instances }),
  );
}

/** Stop one model's pool, or every pool. */
export async function runLlamaServerStop(args: { model?: string }, deps: LlamaServerPoolsCommandDeps): Promise<void> {
  await deps.pools.stop(args.model);
  deps.out(`llama-server: stopped ${args.model ?? "every pool"}`);
}

/** Print every recorded pool with each instance's liveness as JSON. */
export async function runLlamaServerStatus(deps: LlamaServerPoolsCommandDeps): Promise<void> {
  deps.out(JSON.stringify(await deps.pools.status(), null, 2));
}

export function productionLlamaServerPoolsCommandDeps(): LlamaServerPoolsCommandDeps {
  const dataDir = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
  return {
    pools: new LlamaServerPools(productionLlamaServerPoolsDeps({ dataDir, env: process.env, which: whichOnPath })),
    out: (line) => process.stdout.write(`${line}\n`),
  };
}
