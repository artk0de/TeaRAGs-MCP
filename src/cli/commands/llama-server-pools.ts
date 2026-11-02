/**
 * `tea-rags llama-server start|stop|status|bench` — managed llama-server pools: one
 * catalog model on N detached instances bound to random loopback ports,
 * recorded in `<data dir>/llama-server/pools.json`. Work runs over injected
 * deps so tests use object literals.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import {
  benchPoolThroughput,
  chooseInstanceCount,
  createLlamaServerPoolBenchEmbed,
  defaultPoolBenchMaxInstances,
  LlamaServerPools,
  productionLlamaServerPoolsDeps,
  type LlamaServerPoolThroughputSample,
} from "../../core/api/index.js";
import { InvalidParameterError } from "../../core/api/public/index.js";
import { whichOnPath } from "./llama-server-install.js";

/** A pool below two instances leaves the provider no endpoint to fail over to. */
const MIN_POOL_INSTANCES = 2;

export interface LlamaServerPoolsCommandDeps {
  pools: Pick<LlamaServerPools, "start" | "stop" | "status" | "endpointsFor">;
  out: (line: string) => void;
  embed: (endpoints: string[], texts: string[]) => Promise<void>;
  now: () => number;
}

export interface LlamaServerBenchArgs {
  model: string;
  /** Highest count to bench; default {@link defaultPoolBenchMaxInstances} of this host. */
  maxInstances?: number;
  slots: number;
  gpuLayers: number;
  flashAttention: boolean;
}

/** The bench's highest count: the flag, else this host's default; below 2 there is nothing to choose between. */
function resolveBenchMaxInstances(maxInstances: number | undefined): number {
  const resolved = maxInstances ?? defaultPoolBenchMaxInstances({ platform: process.platform, arch: process.arch });
  if (!Number.isInteger(resolved) || resolved < MIN_POOL_INSTANCES) {
    throw new InvalidParameterError("max-instances", `--max-instances must be an integer ≥ ${MIN_POOL_INSTANCES}`);
  }
  return resolved;
}

/** Bench the pool at 1..maxInstances; prints ONE JSON line `{ model, results, chosenInstances }`. Leaves no pool running. */
export async function runLlamaServerBench(
  args: LlamaServerBenchArgs,
  deps: LlamaServerPoolsCommandDeps,
): Promise<void> {
  const results = await benchPoolThroughput(
    { ...args, maxInstances: resolveBenchMaxInstances(args.maxInstances) },
    deps,
  );
  deps.out(JSON.stringify({ model: args.model, results, chosenInstances: chooseInstanceCount(results) }));
}

export interface LlamaServerStartArgs {
  model: string;
  /** A count ≥ 2, or `"auto"`: bench 1..maxInstances first and start the chosen count. */
  instances: number | "auto";
  /** Highest count `"auto"` benches; default {@link defaultPoolBenchMaxInstances} of this host. */
  maxInstances?: number;
  slots: number;
  gpuLayers: number;
  flashAttention: boolean;
}

/** Start the pool; prints ONE JSON line `{ model, endpoints, instances }`, plus `bench` results under `--instances auto`. */
export async function runLlamaServerStart(
  args: LlamaServerStartArgs,
  deps: LlamaServerPoolsCommandDeps,
): Promise<void> {
  const { instances: requested, maxInstances, ...launch } = args;
  let bench: LlamaServerPoolThroughputSample[] | undefined;
  let instances: number;
  if (requested === "auto") {
    bench = await benchPoolThroughput({ ...launch, maxInstances: resolveBenchMaxInstances(maxInstances) }, deps);
    instances = chooseInstanceCount(bench);
  } else {
    if (!Number.isInteger(requested) || requested < MIN_POOL_INSTANCES) {
      throw new InvalidParameterError("instances", `--instances must be an integer ≥ ${MIN_POOL_INSTANCES} or auto`);
    }
    instances = requested;
  }
  const record = await deps.pools.start({ ...launch, instances });
  deps.out(
    JSON.stringify({
      model: record.model,
      endpoints: deps.pools.endpointsFor(record),
      instances: record.instances,
      ...(bench === undefined ? {} : { bench }),
    }),
  );
}

/** Parse the `--instances` flag: `auto`, or a number left for {@link runLlamaServerStart} to validate (NaN fails there). */
export function parseLlamaServerInstancesFlag(value: string | number): number | "auto" {
  return value === "auto" ? "auto" : Number(value);
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

/** `slots` = the pool's `-np`: the bench keeps that many requests in flight per instance. */
export function productionLlamaServerPoolsCommandDeps(o: { slots?: number } = {}): LlamaServerPoolsCommandDeps {
  const dataDir = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
  return {
    pools: new LlamaServerPools(productionLlamaServerPoolsDeps({ dataDir, env: process.env, which: whichOnPath })),
    out: (line) => process.stdout.write(`${line}\n`),
    embed: createLlamaServerPoolBenchEmbed({ fetch: async (input, init) => fetch(input, init), slots: o.slots ?? 1 }),
    now: Date.now,
  };
}
