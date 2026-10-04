/**
 * Project Registry types — schema for $TEA_RAGS_DATA_DIR/registry.json.
 *
 * See docs/superpowers/specs/2026-05-12-project-registry-design.md §2.
 */

import type { CollectionAlias } from "./collection-identity.js";
import type { LanguageCodeVersions } from "./language.js";

/**
 * Git state the index represents, captured at Index/ReindexPipeline finalize.
 * Written through `record()` on every run (pipeline owns it). Absent when the
 * project path is not a git repository or for pre-existing registry entries.
 */
export interface RegistryGitState {
  /** Branch checked out at index time; null = detached HEAD. */
  indexedBranch: string | null;
  /** Resolved HEAD sha at index time ("" when the ref could not be resolved). */
  indexedCommit: string;
  /** Working tree had uncommitted changes at index time. */
  indexedDirty: boolean;
  /**
   * The indexed files whose content differed from `indexedCommit` at index
   * time — modified, staged, deleted or untracked — relative to the project
   * root, admitted by the ingest rules (bd tea-rags-mcp-xi2r9, live P1-1). The
   * index holds THEIR content, not the commit's, so a diff against
   * `indexedCommit` alone misses them once the tree is restored: the
   * working-tree overlay re-reads every one. Empty = the run saw a clean tree.
   * Stored in full, however long. Absent on entries written before the field
   * existed, on legacy overflowed entries (see `indexedDirtyPathsOverflowed`),
   * and when git could not answer — an absent list on a dirty stamp is
   * "unknown", never "none".
   */
  indexedDirtyPaths?: string[];
  /**
   * LEGACY, read-only: set by index runs that capped the list at 200 files and
   * stored no list past it. Nothing writes it any more; the overlay still reads
   * it, so such an entry answers "dirty files unknown" until it is reindexed.
   */
  indexedDirtyPathsOverflowed?: boolean;
}

/** Outcome of one detached auto-update run (spec §4 step 5). */
export interface AutoUpdateRunRecord {
  /** ISO timestamp of run completion. */
  at: string;
  outcome: "ok" | "no-op" | "skipped" | "lock-held" | "failed";
  durationMs: number;
  filesChanged: number;
  /** Present only for `outcome: "failed"`; trimmed message. */
  error?: string;
}

/**
 * Auto-update policy for a project. Sticky like `name`: `record()` preserves
 * it across pipeline reruns; managed exclusively via `setAutoUpdate()` /
 * `recordAutoUpdateRun()` (CLI + updater). Absent = auto-update disabled.
 */
export interface RegistryAutoUpdateConfig {
  enabled: boolean;
  /** Auto-update fires only when repo HEAD is on this branch. */
  targetBranch: string;
  lastRun?: AutoUpdateRunRecord;
}

/**
 * The embedding batch shape a run's throughput tuner settled on for ONE
 * endpoint + model (bd tea-rags-mcp-7ju66). A runtime HINT, never config: the
 * next run starts its hill-climb here instead of at the configured ceiling, the
 * configured bounds still clamp it, the climb still re-probes, and the
 * `EMBEDDING_TUNE_STATIC` opt-out ignores it entirely.
 */
export interface EmbeddingThroughputOptimum {
  batchSize: number;
  /** Embed concurrency the measured climb settled on for this endpoint. */
  concurrency: number;
  /** Measured throughput at `batchSize`, normalised by input size. */
  charsPerSecond: number;
  /**
   * ISO timestamp of the measurement (the settle, for a `per-batch` record).
   * Freshest wins when several entries know the endpoint.
   */
  settledAt: string;
  /**
   * What `charsPerSecond` measures (bd tea-rags-mcp-cyw2r). `aggregate`: the
   * total input of a full concurrency window over its wall-clock span — the
   * run's best measured (batchSize, concurrency) point, comparable across
   * points. `per-batch` (or absent, on every record written before cyw2r): the
   * size climb's per-call rate at the settle, which is not comparable with an
   * aggregate rate, so an aggregate measurement always replaces it.
   */
  measurement?: "aggregate" | "per-batch";
}

/**
 * Whether a run's embedding was bound by the chunk PRODUCER rather than by the
 * embedding server (bd tea-rags-mcp-y1ynz). A batch is starved when the
 * formation timeout flushed it below its target size while the embed worker
 * pool had a free slot and nothing queued — the server was waiting for input.
 * A starved run's chars/s says nothing about the server's ceiling, so more
 * concurrency would buy nothing; the throughput tuner holds its concurrency
 * climb while starved.
 */
export interface EmbeddingProducerStarvation {
  /** Embed batches the run formed by size or by formation timeout (the drain tail is not counted). */
  formedBatches: number;
  /** Of those, the timeout-flushed partial batches formed while an embed slot sat idle. */
  starvedBatches: number;
  /** `starvedBatches / formedBatches` reached `PRODUCER_STARVED_BATCH_SHARE`. */
  producerStarved: boolean;
}

/**
 * Key of `RegistryFileV1.embeddingThroughputOptima`: the EMBEDDING IDENTITY —
 * provider + endpoint + model — so a primary and a fallback endpoint each keep
 * their own optimum, a model swap never inherits another model's batch shape,
 * and neither does another provider on the same URL (bd tea-rags-mcp-y1ynz). A
 * provider that fans one batch over several endpoints passes the whole SET as
 * `endpointUrl` (`EmbeddingProvider.getThroughputTuneEndpointUrl`), so a grown
 * or shrunk cluster starts fresh. A trailing slash on the URL is not part of
 * the identity.
 *
 * Without `provider` the key has the legacy `url|model` shape every entry
 * written before y1ynz carries; production always passes one, so those legacy
 * optima are never applied again — the tuner re-measures once instead of
 * trusting a shape of unknown provenance.
 */
export function embeddingThroughputOptimumKey(endpointUrl: string, model: string, provider?: string): string {
  const legacy = `${endpointUrl.replace(/\/+$/, "")}|${model}`;
  return provider === undefined ? legacy : `${provider}|${legacy}`;
}

/**
 * One run's write into the registry-level optima section (bd tea-rags-mcp-auoxk):
 * the identity key, the optimum the run's tuner chose to persist, and the
 * stored optimum it reconciled that choice against — the record the run was
 * seeded with, absent when nothing was stored. The registry applies the write
 * against the record CURRENTLY on disk; `storedOptimum` tells it whether that
 * record is the one the tuner judged, or a newer one another process wrote.
 */
export interface EmbeddingThroughputOptimumWrite {
  key: string;
  optimum: EmbeddingThroughputOptimum;
  storedOptimum?: EmbeddingThroughputOptimum;
}

export interface CollectionEntry {
  collectionName: string;
  path: string;
  name: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  qdrantUrl: string;
  /**
   * Whether `qdrantUrl` was the embedded Qdrant daemon at index time. The daemon
   * binds an ephemeral free port and may rebind on restart, so the stored
   * `qdrantUrl` is a point-in-time value. Consumers that re-launch indexing seed
   * the embedded marker (not the frozen port) when this is true, so the worker
   * re-resolves the daemon (fresh port + reconnect) instead of pinning a stale
   * URL in external mode. Optional for backward compatibility with pre-existing
   * registry entries (treated as non-embedded / external).
   */
  qdrantEmbedded?: boolean;
  /**
   * Embedding endpoint the project was last indexed against. Symmetric with
   * `qdrantUrl` — prime CLI / run-prime register-first lookups read it so
   * the digest reflects the actual endpoint, not the current shell's env.
   * Optional for backward compatibility with pre-existing registry entries.
   */
  embeddingBaseUrl?: string;
  /**
   * Embedding fallback endpoint (Ollama EMBEDDING_FALLBACK_URL) at index
   * time. Same registry-first lookup as `embeddingBaseUrl`. Undefined when
   * none was configured at index time.
   */
  embeddingFallbackUrl?: string;
  /**
   * Whether the codegraph trajectory family (CODEGRAPH_ENABLED) was active at
   * index time. Codegraph signals land in the payload only when enabled, and
   * the prime CLI must declare the matching signal descriptors or it reports a
   * phantom "removed fields" schema drift. The MCP server's env carries the
   * flag, but the prime hook runs in a fresh shell without it — so prime reads
   * this back register-first and re-applies CODEGRAPH_ENABLED before building
   * the composition. Same registry-first lookup as `embeddingBaseUrl`. Optional
   * for backward compatibility with pre-existing registry entries.
   */
  codegraphEnabled?: boolean;
  /**
   * The FULL effective env set of the last indexing run (canonical keys,
   * code defaults materialized — see `env-groups.ts` /
   * `bootstrap/config/env-snapshot.ts`), excluding identity keys stored in
   * the dedicated fields above, secrets, and server/process knobs. Consumers
   * re-apply the map registry-first with the ONE general rule `outer env >
   * registry env > code default` (alias-group aware). Absent only for
   * pre-existing registry entries — those fall back to `tuning`.
   */
  env?: Record<string, string>;
  /**
   * DEPRECATED legacy field (pre-9vpnz "tuning snapshot"): only-when-set
   * env keys of old runs. Read as a fallback when `env` is absent; never
   * written anymore.
   */
  tuning?: Record<string, string>;
  /**
   * Canonical env keys the OPERATOR pinned for this project — set through
   * `tea-rags projects set-env` / `projects register --env`, dropped by
   * `projects unset-env` (bd tea-rags-mcp-y1ynz). Distinguishes a decision from
   * a value an index run (or `tea-rags tune`) stamped into `env`: a
   * throughput-tuned key (`THROUGHPUT_TUNED_ENV_KEYS`) replays only when it is
   * listed here. Absent on every entry written before the field existed, so
   * their stamped tuned values stop replaying. STICKY across `record()` — a
   * pipeline run never passes it.
   */
  operatorPinnedEnvKeys?: string[];
  /** Source collection logical name when this entry is a worktree clone. */
  worktreeOf?: string;
  /** Worktree name (the `<name>` in `<project>-worktree-<name>`). */
  worktreeName?: string;
  /** Git state the index represents (see RegistryGitState). */
  git?: RegistryGitState;
  /** Auto-update policy (see RegistryAutoUpdateConfig). Sticky like `name`. */
  autoUpdate?: RegistryAutoUpdateConfig;
  /**
   * Per-language code versions the indexed data was produced by — the grammar
   * we parsed with plus our own chunking / walker / codegraph-schema revisions
   * (bd tea-rags-mcp-frwka). `LanguageVersionDriftMonitor` compares it against
   * what the current build declares and routes the reindex hint by which axis
   * moved; `SchemaDriftMonitor` cannot see any of this, because payload KEYS do
   * not move when a grammar or a resolver does.
   *
   * STICKY like `name` and `autoUpdate`, and for a sharper reason: the stamp
   * claims a layer was rebuilt corpus-wide, so only the run that rebuilt it may
   * advance it (`CollectionRegistry#stampLanguageVersions`). A plain
   * incremental calls `record()` like every other run — letting that erase or
   * refresh the stamp would have auto-update silently clearing the hint.
   *
   * Axes are individually optional: an entry written before this existed has
   * none, and an enrichment recompute advances only the two it rebuilt.
   */
  languageVersions?: Record<string, Partial<LanguageCodeVersions>>;
  /**
   * Algorithm version per enrichment provider key the indexed payload was
   * computed by (`EnrichmentProvider.algorithmVersion`, bd tea-rags-mcp-xi2r9).
   * `TrajectoryVersionDriftMonitor` compares it against the running build: a
   * provider whose computation changed writes different values under the same
   * keys, which no other axis can see.
   *
   * STICKY for the same reason as `languageVersions`: the stamp claims the
   * provider's layer was rebuilt for every point, so only such a run may advance
   * it (`CollectionRegistry#stampTrajectoryVersions`). Absent ⇒ every provider
   * reads as version 1.
   */
  trajectoryVersions?: Record<string, number>;
  /**
   * DEPRECATED legacy field: the per-project embedding throughput optima
   * builds before bd tea-rags-mcp-auoxk wrote (bd tea-rags-mcp-7ju66, cyw2r).
   * Optima now live in the registry-level `RegistryFileV1.embeddingThroughputOptima`;
   * this field is only read to LIFT an identity that section lacks, never
   * written, and dropped the next time `record()` rewrites the entry.
   */
  embeddingThroughputOptima?: Record<string, EmbeddingThroughputOptimum>;
  /**
   * The LAST run's producer-starvation verdict (bd tea-rags-mcp-y1ynz) —
   * overwritten by every run that embedded something, absent after one that
   * formed no batch. Read back for `infraHealth.embedding.producerStarvation`.
   */
  embeddingProducerStarvation?: EmbeddingProducerStarvation;
  indexedAt: string;
  teaRagsVersion: string;
  chunksCount: number;
}

/**
 * Partial entry used when registry.record() is invoked from the pipeline.
 * `name` and `autoUpdate` are sticky and managed exclusively via setName() /
 * setAutoUpdate().
 */
export type RecordEntryInput = Omit<CollectionEntry, "name" | "autoUpdate" | "embeddingThroughputOptima">;

export interface RegistryFileV1 {
  /**
   * Wire version. Stays 1 across data migrations: every release up to and
   * including the one that added `revision` backs up and discards a registry
   * whose version is not exactly 1 (`loadRegistryFile`), so bumping it would
   * make any older binary still in use — a parallel worktree build, a
   * long-running MCP server — move the registry aside and start empty.
   */
  version: 1;
  /**
   * Data revision — which one-time registry data migrations have run. Absent
   * means 1 (none). Advanced only by the migration itself and carried through
   * every flush (`mergeRegistryDelta`); a file created from scratch is born at
   * the latest revision. Revision 2 = the env-pin cleanup of bd
   * tea-rags-mcp-h4l6k (`migrateRegistryEnvPins`).
   */
  revision?: number;
  /**
   * Best measured embedding throughput optima, keyed by
   * `embeddingThroughputOptimumKey` — ONE section shared by every project
   * (bd tea-rags-mcp-auoxk): throughput is a property of the embedding
   * configuration, not of the project that measured it. Written per key under
   * the cross-process CAS, each write reconciled against the record on disk
   * (`applyEmbeddingThroughputOptimumWrites`); identities it lacks are lifted
   * from legacy per-entry records on read (`liftEmbeddingThroughputOptima`).
   * An older build reads the file fine but drops this key on its next write;
   * the per-entry records an older build keeps writing are then lifted back.
   */
  embeddingThroughputOptima?: Record<string, EmbeddingThroughputOptimum>;
  collections: Record<string, CollectionEntry>;
}

/** Wire shape returned by list_projects MCP tool. */
export type ProjectInfo = CollectionEntry;

/**
 * The registry surface a module outside the owning domain may depend on.
 *
 * The concrete `CollectionRegistry` lives in `domains/maintenance/registry/`;
 * the ingest pipeline only records an entry after an indexing run and receives
 * the instance by DI, so it types that parameter with this port instead of
 * reaching into a sibling domain.
 */
export interface CollectionRegistryPort {
  record: (entry: RecordEntryInput) => void;
  /**
   * The stored throughput optimum for this embedding identity
   * (`embeddingThroughputOptimumKey`) from the registry-level section — a
   * machine-wide fact about the embedding configuration, not about one
   * project. Optional: a registry that cannot answer leaves every run starting
   * at the configured ceiling.
   */
  readEmbeddingThroughputOptimum?: (
    endpointUrl: string,
    model: string,
    provider?: string,
  ) => EmbeddingThroughputOptimum | undefined;
  /**
   * Persist a run's settled optima into the registry-level section (bd
   * tea-rags-mcp-auoxk), each reconciled against the record currently on disk.
   */
  recordEmbeddingThroughputOptima?: (writes: readonly EmbeddingThroughputOptimumWrite[]) => void;
  /** The last run's producer-starvation verdict for this collection, if it recorded one. */
  readEmbeddingProducerStarvation?: (collectionName: string) => EmbeddingProducerStarvation | undefined;
}

/**
 * How a path becomes the collection it belongs to: the registry's entry when
 * one claims the path, the deterministic path hash otherwise
 * (bd tea-rags-mcp-dxa9w).
 *
 * The rule itself is `api/internal/collection-resolver.ts`
 * (`createPathCollectionResolver`), which consults the registry and throws
 * api-layer errors. Its TYPE lives here so the collaborators that receive it by
 * DI — the ingest pipeline, the status module, the drift reporter — can name
 * the contract they are handed instead of each redeclaring its shape, without
 * any of them reaching into the api layer.
 */
export type PathCollectionResolver = (path: string) => Promise<CollectionAlias>;

// ── Registry env vocabulary (relocated from
// domains/maintenance/registry/env-groups.ts, bd tea-rags-mcp-0qaht.36) ──
// The stable layers (`api/public`, `bootstrap`) re-export/consume these
// without reaching into the registry domain; the domain modules re-export
// them unchanged for their own consumers. The group TABLE
// (`REGISTRY_ENV_GROUPS`) is domain behavior and stays there.

/**
 * What a change to one env group invalidates in an EXISTING index.
 *
 * The classes are the drift remedy lattice read backwards: `chunk-set` moves
 * chunk point ids (nothing short of `--force` is coherent), each
 * `enrichment:<trajectory>` rewrites that trajectory's payload in place
 * (`--force-enrichments <trajectory>`), and `runtime` describes only HOW the
 * run executes — endpoints, pool sizes, batch sizes, timeouts, DuckDB limits.
 * Changing a `runtime` value produces byte-identical indexed data, so it is
 * never drift.
 */
export type EnvConsequence = "chunk-set" | "enrichment:git" | "enrichment:codegraph" | "runtime";

/** One alias family: the canonical env name plus its deprecated spellings. */
export interface RegistryEnvGroup {
  canonical: string;
  aliases: readonly string[];
  /** What a change to this value invalidates in an existing index. */
  consequence: EnvConsequence;
}

// ── Registry seed-picking port (relocated from
// domains/maintenance/registry/env-resolution.ts, bd tea-rags-mcp-0qaht.36) ──

/** Structural subset of CollectionRegistry used by env seed picking — keeps tests fake-friendly. */
export interface RegistryLookup {
  findByName: (name: string) => CollectionEntry | null;
  findByPath: (path: string) => CollectionEntry | null;
  list: () => CollectionEntry[];
}

// ── Qdrant backend vocabulary (relocated from
// domains/maintenance/registry/{qdrant-backend-resolution,errors}.ts,
// bd tea-rags-mcp-0qaht.36) ──

/** The registry facts an unresolvable-backend report quotes back to the operator. */
export interface RegistryQdrantBackendClaim {
  name: string | null;
  collectionName: string;
  qdrantUrl: string;
  teaRagsVersion?: string;
}

/**
 * The backend an entry resolves to.
 *
 * `embedded` carries no address on purpose: the daemon rebinds an ephemeral
 * port on restart, so the only durable way to name it is the marker the worker
 * re-resolves through `ensureDaemon`.
 */
export type RegistryQdrantBackend =
  | { kind: "embedded" }
  | { kind: "external"; url: string }
  /** No address on record (recovered stub) — the caller seeds nothing. */
  | { kind: "unaddressed" };
