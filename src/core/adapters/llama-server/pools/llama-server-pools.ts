// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Managed llama-server pools: one catalog model served by N detached
 * llama-server processes on random loopback ports, recorded in `pools.json` so
 * any later process can report, stop or restart them. Every side effect —
 * spawn, HTTP, signals, port probes, clock — is injected.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { ConfigValueInvalidError } from "../../../primitives/errors/index.js";
import { EmbeddingModelNotPublishedError } from "../../embeddings/errors.js";
import { servedModelMatches } from "../../embeddings/llama-server/provider.js";
import { EMBEDDING_MODEL_CATALOG, type EmbeddingModelCatalogEntry } from "../../embeddings/model-catalog.js";
import { LlamaServerPoolStartError } from "./errors.js";
import {
  llamaServerPoolsDir,
  readLlamaServerPoolRecords,
  writeLlamaServerPoolRecords,
  type LlamaServerPoolRecord,
} from "./pool-registry.js";
import { pickFreePorts } from "./ports.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const PROBE_REQUEST_TIMEOUT_MS = 2_000;

export interface LlamaServerPoolsDeps {
  /** tea-rags data dir: GGUFs under `models/`, the registry and logs under `llama-server/`. */
  dataDir: string;
  /** The llama-server binary path; null when none is installed. */
  resolveBinary: () => string | null;
  /** Start a DETACHED process writing stdout+stderr to `logPath`; it must outlive the caller. */
  spawn: (binary: string, args: string[], logPath: string) => { pid: number };
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  kill: (pid: number) => void;
  isAlive: (pid: number) => boolean;
  isPortFree: (port: number) => Promise<boolean>;
  /** [0, 1) — drives port choice. */
  random: () => number;
  /** Epoch milliseconds. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Models a pool may serve; defaults to the shipped catalog. */
  catalog?: readonly EmbeddingModelCatalogEntry[];
  /** How long one instance may take to answer `/health`; default 120 s. */
  healthTimeoutMs?: number;
}

export interface LlamaServerPoolStartOptions {
  /** Catalog id. */
  model: string;
  instances: number;
  /** Parallel slots per instance (`-np`). */
  slots: number;
  gpuLayers: number;
  flashAttention: boolean;
  /** Bind these ports instead of picking random ones — restarting a recorded pool keeps its endpoints. */
  ports?: number[];
}

export interface LlamaServerPoolStatus {
  model: string;
  slots: number;
  instances: { port: number; pid: number; alive: boolean }[];
}

/** Launch args shared by every instance of a pool (each adds `--port`): `-c = slots × window`, `-b = -ub = window`. */
export function buildPoolLaunchArgs(o: {
  ggufPath: string;
  window: number;
  slots: number;
  gpuLayers: number;
  flashAttention: boolean;
}): string[] {
  return [
    "-m",
    o.ggufPath,
    "--embedding",
    "--host",
    LOOPBACK_HOST,
    "-ngl",
    String(o.gpuLayers),
    "-fa",
    o.flashAttention ? "on" : "off",
    "-np",
    String(o.slots),
    "-c",
    String(o.slots * o.window),
    "-b",
    String(o.window),
    "-ub",
    String(o.window),
  ];
}

function slotsOf(args: readonly string[]): number {
  const index = args.indexOf("-np");
  return index === -1 ? 1 : Number(args[index + 1]);
}

function logFileSlug(model: string): string {
  return model.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export class LlamaServerPools {
  constructor(private readonly deps: LlamaServerPoolsDeps) {}

  /**
   * Spawn the pool, wait until every instance answers `/health`, check `/props`
   * serves the model, then record it. A model that already has a pool is
   * stopped first. Any failure stops everything this call spawned.
   */
  async start(o: LlamaServerPoolStartOptions): Promise<LlamaServerPoolRecord> {
    if (!Number.isInteger(o.instances) || o.instances < 1) {
      throw new ConfigValueInvalidError("llama-server pool instances", String(o.instances), "an integer ≥ 1");
    }
    if (o.ports !== undefined && o.ports.length !== o.instances) {
      throw new ConfigValueInvalidError("llama-server pool ports", o.ports.join(","), `${o.instances} ports`);
    }
    const entry = this.catalogEntry(o.model);
    const ggufPath = this.ggufPathOf(entry);
    const binary = this.deps.resolveBinary();
    if (binary === null) {
      throw new LlamaServerPoolStartError(
        "No llama-server binary found; install one with: tea-rags llama-server install",
        "Run tea-rags llama-server install, or point LLAMA_SERVER_PATH at an existing llama-server",
      );
    }
    await this.stop(o.model);

    const args = buildPoolLaunchArgs({
      ggufPath,
      window: entry.window,
      slots: o.slots,
      gpuLayers: o.gpuLayers,
      flashAttention: o.flashAttention,
    });
    const ports =
      o.ports ?? (await pickFreePorts(o.instances, { isFree: this.deps.isPortFree, random: this.deps.random }));
    const instances = await this.launchInstances(o.model, binary, args, ports);

    const record: LlamaServerPoolRecord = {
      model: o.model,
      ggufPath,
      binary,
      instances,
      args,
      startedAt: new Date(this.deps.now()).toISOString(),
    };
    await this.recordPool(record);
    return record;
  }

  /**
   * Start a recorded pool again from its record — same binary, launch args and
   * ports — once none of its instances answers (after a reboot). The recorded
   * pids are never signalled: with nothing listening on the ports they may
   * belong to unrelated processes. A port still held makes its instance fail,
   * which stops what this call spawned and throws.
   */
  async restart(record: LlamaServerPoolRecord): Promise<LlamaServerPoolRecord> {
    const instances = await this.launchInstances(
      record.model,
      record.binary,
      record.args,
      record.instances.map((instance) => instance.port),
    );
    const restarted: LlamaServerPoolRecord = {
      ...record,
      instances,
      startedAt: new Date(this.deps.now()).toISOString(),
    };
    await this.recordPool(restarted);
    return restarted;
  }

  /** Stop one model's pool, or every pool when `model` is omitted, and drop the records. */
  async stop(model?: string): Promise<void> {
    const records = await readLlamaServerPoolRecords(this.deps.dataDir);
    const stopping = records.filter((r) => model === undefined || r.model === model);
    if (stopping.length === 0) return;
    for (const record of stopping) this.killInstances(record.instances);
    await writeLlamaServerPoolRecords(
      this.deps.dataDir,
      records.filter((r) => !stopping.includes(r)),
    );
  }

  async status(): Promise<LlamaServerPoolStatus[]> {
    const records = await readLlamaServerPoolRecords(this.deps.dataDir);
    return records.map((record) => ({
      model: record.model,
      slots: slotsOf(record.args),
      instances: record.instances.map(({ port, pid }) => ({ port, pid, alive: this.deps.isAlive(pid) })),
    }));
  }

  /** The EMBEDDING_BASE_URL endpoints of a pool. */
  endpointsFor(record: LlamaServerPoolRecord): string[] {
    return record.instances.map((instance) => `http://${LOOPBACK_HOST}:${instance.port}`);
  }

  private catalogEntry(model: string): EmbeddingModelCatalogEntry {
    const catalog = this.deps.catalog ?? EMBEDDING_MODEL_CATALOG;
    const entry = catalog.find((candidate) => candidate.id === model);
    if (entry === undefined) {
      throw new ConfigValueInvalidError(
        "llama-server pool model",
        model,
        `a catalog model: ${catalog.map((candidate) => candidate.id).join(", ")}`,
      );
    }
    return entry;
  }

  /** The GGUF `fetch-model` writes for a catalog entry; it must already be on disk. */
  private ggufPathOf(entry: EmbeddingModelCatalogEntry): string {
    if (entry.gguf === null) throw new EmbeddingModelNotPublishedError(entry.id);
    const path = join(this.deps.dataDir, "models", entry.gguf.file);
    if (!existsSync(path)) {
      throw new LlamaServerPoolStartError(
        `GGUF for ${entry.id} not found at ${path}; download it with: tea-rags llama-server fetch-model ${entry.id}`,
        `Run tea-rags llama-server fetch-model ${entry.id}, then start the pool again`,
      );
    }
    return path;
  }

  /** Spawn one instance per port and wait until each serves `model`; any failure stops every instance spawned here. */
  private async launchInstances(
    model: string,
    binary: string,
    args: readonly string[],
    ports: readonly number[],
  ): Promise<LlamaServerPoolRecord["instances"]> {
    const instances: LlamaServerPoolRecord["instances"] = [];
    try {
      for (const port of ports) {
        const logPath = join(llamaServerPoolsDir(this.deps.dataDir), "logs", `${logFileSlug(model)}-${port}.log`);
        const { pid } = this.deps.spawn(binary, [...args, "--port", String(port)], logPath);
        instances.push({ pid, port, logPath });
      }
      await Promise.all(instances.map(async (instance) => this.waitUntilServing(instance, model)));
    } catch (error) {
      this.killInstances(instances);
      throw error;
    }
    return instances;
  }

  /** Write `record` into `pools.json`, replacing the pool of the same model. */
  private async recordPool(record: LlamaServerPoolRecord): Promise<void> {
    const others = (await readLlamaServerPoolRecords(this.deps.dataDir)).filter((r) => r.model !== record.model);
    await writeLlamaServerPoolRecords(this.deps.dataDir, [...others, record]);
  }

  private killInstances(instances: readonly { pid: number }[]): void {
    for (const { pid } of instances) {
      if (this.deps.isAlive(pid)) this.deps.kill(pid);
    }
  }

  /** Poll `/health` until 200, then judge `/props` `model_path` the way the embedding provider does. */
  private async waitUntilServing(
    instance: { pid: number; port: number; logPath: string },
    model: string,
  ): Promise<void> {
    const base = `http://${LOOPBACK_HOST}:${instance.port}`;
    const deadline = this.deps.now() + (this.deps.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
    while (!(await this.answersHealth(base))) {
      if (!this.deps.isAlive(instance.pid)) {
        throw new LlamaServerPoolStartError(
          `llama-server on port ${instance.port} exited before it became healthy`,
          `See its log: ${instance.logPath}`,
        );
      }
      if (this.deps.now() >= deadline) {
        throw new LlamaServerPoolStartError(
          `llama-server on port ${instance.port} did not answer /health in time`,
          `See its log: ${instance.logPath}`,
        );
      }
      await this.deps.sleep(HEALTH_POLL_INTERVAL_MS);
    }
    const modelPath = await this.servedModelPath(base);
    if (modelPath !== undefined && !servedModelMatches(model, modelPath)) {
      throw new LlamaServerPoolStartError(
        `llama-server on port ${instance.port} serves ${modelPath}, not ${model}`,
        `Re-fetch the model with: tea-rags llama-server fetch-model ${model}`,
      );
    }
  }

  private async answersHealth(base: string): Promise<boolean> {
    try {
      const response = await this.deps.fetch(`${base}/health`, {
        signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async servedModelPath(base: string): Promise<string | undefined> {
    const response = await this.deps.fetch(`${base}/props`, { signal: AbortSignal.timeout(PROBE_REQUEST_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const props = (await response.json()) as { model_path?: unknown };
    return typeof props.model_path === "string" ? props.model_path : undefined;
  }
}
