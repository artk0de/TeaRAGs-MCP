/**
 * The collection as a server-side object: bring it into existence, read what
 * the server says about it, patch its configuration, take it away again.
 *
 * Everything here addresses a collection as a whole — its vector/sparse layout,
 * quantization, strict-mode guardrails, optimizer thresholds, health status and
 * on-disk footprint. Nothing here touches the POINTS inside it; that is
 * `QdrantPointStore`'s job, and the payload FIELD indexes are
 * `QdrantPayloadIndexManager`'s.
 *
 * The config-patching methods (`updateCollection*`, `pauseOptimizer`,
 * `resumeOptimizer`) sit next to the config-reading ones (`getQuantizationConfig`,
 * `getStrictModeConfig`, `getCollectionInfo`) deliberately: the startup reconcile
 * and the reindex optimizer window each read one and then write its counterpart,
 * and splitting the pair would put the two halves of one decision in two files.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { QdrantConnection } from "./connection.js";
import { CollectionAlreadyExistsError, QdrantUnavailableError } from "./errors.js";

export interface CollectionInfo {
  name: string;
  vectorSize: number;
  pointsCount: number;
  distance: "Cosine" | "Euclid" | "Dot";
  hybridEnabled?: boolean;
  /** Qdrant collection health status. `yellow` indicates background optimization. */
  status: "green" | "yellow" | "red";
  /** Optimizer state string from Qdrant (`"ok"` or `"unknown"` when absent). */
  optimizerStatus: string;
  /**
   * Vector quantization mode derived from `config.quantization_config`:
   * `turbo` (TurboQuant 8x), `scalar` (int8), or `none` (unquantized or an
   * unrecognized quantization variant).
   */
  quantization: "turbo" | "scalar" | "none";
}

export class QdrantCollectionAdmin {
  constructor(private readonly connection: QdrantConnection) {}

  async createCollection(
    name: string,
    vectorSize: number,
    distance: "Cosine" | "Euclid" | "Dot" = "Cosine",
    enableSparse = false,
    quantizationScalar = false,
    turboQuant = false,
    strictMode?: { maxResidentMemoryPercent?: number; searchMaxBatchsize?: number },
  ): Promise<void> {
    type DistanceType = "Cosine" | "Euclid" | "Dot" | "Manhattan";
    type VectorConfig =
      | {
          size: number;
          distance: DistanceType;
        }
      | {
          dense: {
            size: number;
            distance: DistanceType;
          };
        };

    interface CollectionConfig {
      vectors: VectorConfig;
      sparse_vectors?: {
        text: {
          modifier: "idf" | "none";
        };
      };
      quantization_config?:
        | { scalar: { type: "int8"; always_ram: boolean } }
        | { turbo: { bits: "bits4"; always_ram: boolean } };
      strict_mode_config?: {
        enabled: boolean;
        max_resident_memory_percent?: number;
        search_max_batchsize?: number;
      };
    }

    const config: CollectionConfig = enableSparse
      ? {
          vectors: {
            dense: {
              size: vectorSize,
              distance,
            },
          },
          sparse_vectors: {
            text: {
              modifier: "idf",
            },
          },
        }
      : {
          vectors: {
            size: vectorSize,
            distance,
          },
        };

    if (turboQuant) {
      config.quantization_config = { turbo: { bits: "bits4", always_ram: true } };
    } else if (quantizationScalar) {
      config.quantization_config = { scalar: { type: "int8", always_ram: true } };
    }

    if (
      strictMode &&
      (strictMode.maxResidentMemoryPercent !== undefined || strictMode.searchMaxBatchsize !== undefined)
    ) {
      config.strict_mode_config = {
        enabled: true,
        ...(strictMode.maxResidentMemoryPercent !== undefined && {
          max_resident_memory_percent: strictMode.maxResidentMemoryPercent,
        }),
        ...(strictMode.searchMaxBatchsize !== undefined && { search_max_batchsize: strictMode.searchMaxBatchsize }),
      };
    }

    try {
      await this.connection.call(async () => this.connection.client.createCollection(name, config));
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
      if (isConflictError(error)) {
        throw new CollectionAlreadyExistsError(name, error instanceof Error ? error : undefined);
      }
      throw error;
    }
  }

  async collectionExists(name: string): Promise<boolean> {
    try {
      await this.connection.call(async () => this.connection.client.getCollection(name));
      return true;
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
      // Qdrant client throws with status property for HTTP errors (404 = not found)
      const { status } = error as { status?: number };
      if (status === 404 || status === 400) return false;
      throw error;
    }
  }

  async listCollections(): Promise<string[]> {
    const response = await this.connection.call(async () => this.connection.client.getCollections());
    return response.collections.map((c) => c.name);
  }

  async getCollectionInfo(name: string): Promise<CollectionInfo> {
    const info = await this.connection.call(async () => this.connection.client.getCollection(name));
    const vectorConfig = info.config.params.vectors;

    // Handle both named and unnamed vector configurations
    let size = 0;
    let distance: "Cosine" | "Euclid" | "Dot" = "Cosine";
    let hybridEnabled = false;

    // Check if sparse vectors are configured
    if (info.config.params.sparse_vectors) {
      hybridEnabled = true;
    }

    if (typeof vectorConfig === "object" && vectorConfig !== null) {
      // Check for unnamed vector config (has 'size' directly)
      if ("size" in vectorConfig) {
        size = typeof vectorConfig.size === "number" ? vectorConfig.size : 0;
        distance = vectorConfig.distance as "Cosine" | "Euclid" | "Dot";
      } else if ("dense" in vectorConfig) {
        // Named vector config for hybrid search
        const denseConfig = vectorConfig.dense as { size: unknown; distance: unknown };
        size = typeof denseConfig.size === "number" ? denseConfig.size : 0;
        distance = denseConfig.distance as "Cosine" | "Euclid" | "Dot";
      }
    }

    return {
      name,
      vectorSize: size,
      pointsCount: info.points_count || 0,
      distance,
      hybridEnabled,
      status: (info.status ?? "green") as "green" | "yellow" | "red",
      optimizerStatus: typeof info.optimizer_status === "string" ? info.optimizer_status : "unknown",
      quantization: mapQuantization((info.config as { quantization_config?: unknown }).quantization_config),
    };
  }

  /**
   * Best-effort read of a collection's health status for the TurboQuant
   * migration progress poll. Returns the live status, or "unknown" on ANY
   * failure — a migration poll runs alongside (not gating) the index run and
   * MUST NOT throw. Mirrors the swallow-error contract of
   * `QdrantConnection.getServerVersion`.
   */
  async getCollectionStatus(name: string): Promise<"green" | "yellow" | "red" | "unknown"> {
    try {
      return (await this.getCollectionInfo(name)).status;
    } catch {
      return "unknown";
    }
  }

  /**
   * Reads the live quantization config of a collection (e.g.
   * `{ turbo: { bits: "bits4", always_ram: true } }`) or `undefined` when the
   * collection is unquantized. Used by the startup TurboQuant reconcile to
   * decide whether a PATCH is needed.
   */
  async getQuantizationConfig(name: string): Promise<unknown> {
    const info = await this.connection.call(async () => this.connection.client.getCollection(name));
    return (info.config as { quantization_config?: unknown } | undefined)?.quantization_config;
  }

  /**
   * Reads the live strict-mode config of a collection (e.g.
   * `{ enabled: true, max_resident_memory_percent: 90 }`) or `undefined` when
   * strict mode is not configured. Used by the startup strict-mode reconcile to
   * decide whether a PATCH is needed.
   */
  async getStrictModeConfig(name: string): Promise<unknown> {
    const info = await this.connection.call(async () => this.connection.client.getCollection(name));
    return (info.config as { strict_mode_config?: unknown } | undefined)?.strict_mode_config;
  }

  async deleteCollection(name: string): Promise<void> {
    await this.connection.call(async () => this.connection.client.deleteCollection(name));
  }

  /**
   * Adds sparse vector configuration (IDF-modified "text" sparse vector) to an existing collection.
   * Used when migrating a legacy dense-only collection to hybrid search.
   */
  async updateCollectionSparseConfig(collectionName: string): Promise<void> {
    await this.connection.call(async () =>
      this.connection.client.updateCollection(collectionName, {
        sparse_vectors: { text: { modifier: "idf" } },
      }),
    );
  }

  /**
   * Enables TurboQuant 8x quantization on an existing collection. Qdrant's
   * optimizer rebuilds quantized vectors from the stored float vectors in the
   * background — no re-embedding / reindex. Idempotent at the call site (the
   * startup reconcile only calls this when the live config differs).
   */
  async updateCollectionQuantization(collectionName: string): Promise<void> {
    await this.connection.call(async () =>
      this.connection.client.updateCollection(collectionName, {
        quantization_config: { turbo: { bits: "bits4", always_ram: true } },
      }),
    );
  }

  /**
   * Applies Qdrant 1.18 strict-mode guardrails to an existing collection — the
   * `max_resident_memory_percent` OOM guard and/or the `search_max_batchsize`
   * cap. Server-side config only, no reindex. Idempotent at the call site (the
   * startup reconcile only calls this when the live config differs).
   */
  async updateCollectionStrictMode(
    collectionName: string,
    strictMode: { maxResidentMemoryPercent?: number; searchMaxBatchsize?: number },
  ): Promise<void> {
    await this.connection.call(async () =>
      this.connection.client.updateCollection(collectionName, {
        strict_mode_config: {
          enabled: true,
          ...(strictMode.maxResidentMemoryPercent !== undefined && {
            max_resident_memory_percent: strictMode.maxResidentMemoryPercent,
          }),
          ...(strictMode.searchMaxBatchsize !== undefined && { search_max_batchsize: strictMode.searchMaxBatchsize }),
        },
      }),
    );
  }

  /**
   * Pause both HNSW indexing and segment vacuum during a large-delta reindex.
   *
   * After a bulk delete on embedded Qdrant the optimizer repacks segments
   * (triggered by `deleted_threshold`, default 0.2 = ≥20% tombstones). On
   * multi-thousand-file deletes this holds WAL busy for several minutes and
   * starves concurrent upsert HTTP requests until they hit the 300s client
   * timeout (production incident 2026-04-24T16-34).
   *
   * Setting `deleted_threshold: 0.99` prevents vacuum from firing mid-reindex.
   * Setting `indexing_threshold: 0` pauses HNSW rebuilds. Both resume via
   * {@link resumeOptimizer}, which also triggers a one-shot optimization pass
   * when thresholds revert.
   */
  async pauseOptimizer(collectionName: string): Promise<void> {
    await this.connection.call(async () =>
      this.connection.client.updateCollection(collectionName, {
        optimizers_config: {
          indexing_threshold: 0,
          deleted_threshold: 0.99,
          // Qdrant 1.18: defer optimization during the bulk phase so segments are
          // not repacked mid-index; resumeOptimizer clears it so one pass runs at
          // finalize (2-3× faster than incremental optimization on large repos).
          prevent_unoptimized: true,
        },
      }),
    );
  }

  /**
   * Resume optimizer after reindex: restore thresholds to their productive
   * defaults. Reverting `deleted_threshold` naturally triggers one optimizer
   * pass to repack any tombstones accumulated during the paused interval.
   *
   * @param options.indexingThreshold - HNSW indexing threshold (Qdrant default: 20000)
   * @param options.deletedThreshold - Vacuum trigger ratio (Qdrant default: 0.2)
   */
  async resumeOptimizer(
    collectionName: string,
    options: { indexingThreshold?: number; deletedThreshold?: number } = {},
  ): Promise<void> {
    const { indexingThreshold = 20000, deletedThreshold = 0.2 } = options;
    await this.connection.call(async () =>
      this.connection.client.updateCollection(collectionName, {
        optimizers_config: {
          indexing_threshold: indexingThreshold,
          deleted_threshold: deletedThreshold,
          // Clear the bulk-phase defer set by pauseOptimizer: reverting it lets
          // the optimizer run its single post-index pass over the new segments.
          prevent_unoptimized: false,
        },
      }),
    );
  }

  /**
   * Best-effort on-disk byte size of a collection's storage directory.
   *
   * EMBEDDED only: recursively sums file sizes under
   * `<storagePath>/collections/<name>` (Qdrant stores each collection at that
   * path). EXTERNAL Qdrant returns `undefined` — no filesystem access to the
   * remote server. Swallows ALL errors (missing dir, permission, race) →
   * `undefined`, so this status probe can never break `get_index_status`.
   * Mirrors the swallow-error contract of `QdrantConnection.getServerVersion`.
   */
  async getCollectionDiskBytes(collectionName: string): Promise<number | undefined> {
    const storagePath = this.connection.daemon?.storagePath;
    if (storagePath === undefined) return undefined;
    try {
      // The status reports the alias (e.g. `code_<hash>`); the on-disk directory
      // is the active PHYSICAL collection it points at (`code_<hash>_vN`). Resolve
      // the alias before stat-ing, or we'd read a non-existent dir → undefined.
      const physical = await this.connection.aliases.resolveActive(collectionName);
      return await sumDirBytes(join(storagePath, "collections", physical));
    } catch {
      return undefined;
    }
  }
}

/**
 * Recursively sum the ACTUAL on-disk size of every regular file under `dir`
 * (allocated blocks × 512), matching `du`. Qdrant preallocates sparse files, so
 * `stat.size` (logical length) wildly overstates real usage — ~1.5 GB apparent
 * vs ~382 MB allocated observed live. We therefore account allocated blocks, not
 * logical size; on exotic platforms where `blocks` is undefined we round the
 * logical size up to the next 512-byte sector. Directories are descended;
 * symlinks and special files are skipped (best-effort). Propagates fs errors
 * (e.g. ENOENT for a missing collection dir) to the caller, which swallows them
 * — see {@link QdrantCollectionAdmin.getCollectionDiskBytes}.
 */
async function sumDirBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await sumDirBytes(full);
    } else if (entry.isFile()) {
      const st = await stat(full);
      total += st.blocks !== undefined ? st.blocks * 512 : Math.ceil(st.size / 512) * 512;
    }
  }
  return total;
}

/**
 * Classify a Qdrant `quantization_config` block into a coarse mode. `turbo`
 * (TurboQuant 8x) and `scalar` (int8) are the modes tea-rags creates; any other
 * shape — including a missing config or an unrecognized variant — is `none`.
 */
function mapQuantization(config: unknown): "turbo" | "scalar" | "none" {
  if (typeof config === "object" && config !== null) {
    if ("turbo" in config) return "turbo";
    if ("scalar" in config) return "scalar";
  }
  return "none";
}

/** Detect Qdrant 409 Conflict (collection already exists). */
function isConflictError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("conflict") || msg.includes("already exists")) return true;
  }
  if (typeof error === "object" && error !== null && "status" in error) {
    return (error as { status: number }).status === 409;
  }
  return false;
}
