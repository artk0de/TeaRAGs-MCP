import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { chunkPointsFilter } from "../../../adapters/qdrant/service-points.js";
import {
  applyRegistryEnvEdit,
  canonicalRegistryEnvKeys,
  isIndexRecordedEnvKey,
  parseRegistryEnvBoolean,
  PROJECT_NAME_RE,
  REGISTRY_ENV_ALLOWLIST,
  registryQdrantBackendFields,
  type CollectionEntry,
  type CollectionRegistry,
  type ProjectInfo,
  type RegistryEnvEdit,
} from "../../../domains/maintenance/registry/index.js";
import { resolveCollectionName, validatePath, validatePathSync } from "../../../infra/collection-name.js";
import { ConfigError } from "../../../infra/errors.js";
import {
  InvalidParameterError,
  MissingArgumentError,
  PathDoesNotExistError,
  ProjectEnvKeyUnknownError,
  ProjectNameInvalidError,
  ProjectNameNotUniqueError,
  ProjectNotRegisteredError,
  ProjectPathAlreadyRegisteredError,
} from "../../errors.js";
import type { ProjectRegistryAddress, StaleProjectEntry, StaleProjectPruneReport } from "../../public/dto/registry.js";

export interface ProjectRegistryOpsDeps {
  registry: CollectionRegistry;
  qdrant?: QdrantManager;
  embeddings?: EmbeddingProvider;
  snapshotDir?: string;
  /**
   * Does this project directory exist? Seam for the stale sweep so its spec
   * needs no filesystem. Production leaves it out and gets `existsSync`.
   */
  pathExists?: (path: string) => boolean;
  /**
   * Refuse a project env value the config schema would reject at the next
   * index run — throws a `ConfigError`. The schema lives in `bootstrap`, which
   * this layer may not import, so the entry point injects it
   * (`assertRegistryEnvValueParses`). Left out, only key-level validation runs.
   */
  validateEnvValue?: (key: string, value: string) => void;
}

const REGISTRY_ENV_KEYS: ReadonlySet<string> = new Set(REGISTRY_ENV_ALLOWLIST);

/** The one address field a validated {@link ProjectRegistryAddress} carries. */
type RegistryAddressTarget = { kind: "name" | "path" | "collection"; value: string };

/** Exactly one of `name` / `path` / `collection`, non-empty — typed errors otherwise. */
function validateRegistryAddress(address: ProjectRegistryAddress): RegistryAddressTarget {
  const given = (["name", "path", "collection"] as const).flatMap((kind) => {
    const value = address[kind];
    return typeof value === "string" && value.length > 0 ? [{ kind, value }] : [];
  });
  if (given.length > 1) {
    throw new InvalidParameterError(
      given[1].kind,
      `${given.map((g) => g.kind).join(" and ")} are mutually exclusive — pass exactly one`,
    );
  }
  if (given.length === 0) throw new MissingArgumentError(["name, path or collection"]);
  return given[0];
}

/** Whether `candidate` is a versioned `<logical>_vN` generation of `logical`. */
function isGenerationOf(candidate: string, logical: string): boolean {
  return candidate.startsWith(`${logical}_v`) && /^\d+$/.test(candidate.slice(logical.length + 2));
}

export class ProjectRegistryOps {
  constructor(private readonly deps: ProjectRegistryOpsDeps) {}

  async register(input: {
    path: string;
    name: string;
    /** Project env to persist with the alias — see {@link ProjectRegistryOps#editEnv}. */
    env?: Readonly<Record<string, string>>;
  }): Promise<{ collectionName: string; alreadyIndexed: boolean }> {
    // Validated before anything is written: a rejected env registers nothing.
    const envEdit = input.env && Object.keys(input.env).length > 0 ? { set: input.env } : null;
    if (envEdit) this.validateEnvEdit(envEdit);
    const out = await this.registerAlias(input);
    if (envEdit) this.editEnv({ name: input.name, ...envEdit });
    return out;
  }

  /**
   * Set and/or unset keys of a registered project's env (bd tea-rags-mcp-5uk75)
   * — configuration, not an indexing run. The next run replays it registry-first
   * (`resolveRegistryEnv`), and its own `record()` stamps back the effective
   * value, so an edit holds until the ambient env of a run overrides it.
   *
   * Keys are any spelling of `REGISTRY_ENV_ALLOWLIST`, stored canonically;
   * `EMBEDDING_BASE_URL` / `EMBEDDING_FALLBACK_URL` / `CODEGRAPH_ENABLED` land
   * in their dedicated entry fields (`applyRegistryEnvEdit`). Persisted through
   * `CollectionRegistry#record`, the same CAS flush every writer uses.
   *
   * @throws ProjectNotRegisteredError — no entry carries `name`.
   * @throws ProjectEnvKeyUnknownError — a key outside the registry env vocabulary.
   * @throws InvalidParameterError — nothing to edit, an index-recorded key
   *   (`EMBEDDING_MODEL`, `QDRANT_URL`), an empty value, a non-boolean
   *   `CODEGRAPH_ENABLED`, or a value the config schema refuses.
   */
  editEnv(input: { name: string } & RegistryEnvEdit): CollectionEntry {
    const edit: RegistryEnvEdit = {
      ...(input.set ? { set: input.set } : {}),
      ...(input.unset ? { unset: input.unset } : {}),
    };
    this.validateEnvEdit(edit);
    const { registry } = this.deps;
    const entry = registry.findByName(input.name);
    if (!entry) {
      const available = registry
        .list()
        .map((e) => e.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0);
      throw new ProjectNotRegisteredError(input.name, available);
    }
    const { name: _name, autoUpdate: _autoUpdate, ...recordable } = applyRegistryEnvEdit(entry, edit);
    registry.record(recordable);
    return registry.get(entry.collectionName) ?? entry;
  }

  private validateEnvEdit(edit: RegistryEnvEdit): void {
    const setEntries = Object.entries(edit.set ?? {});
    const unsetKeys = edit.unset ?? [];
    if (setEntries.length === 0 && unsetKeys.length === 0) {
      throw new InvalidParameterError("env", "nothing to set or unset — pass at least one KEY=VALUE or KEY");
    }
    for (const key of [...setEntries.map(([key]) => key), ...unsetKeys]) {
      if (!REGISTRY_ENV_KEYS.has(key)) throw new ProjectEnvKeyUnknownError(key);
      if (isIndexRecordedEnvKey(key)) {
        throw new InvalidParameterError(
          key,
          "records what the index was built with and is written only by the index run — re-index with it exported instead",
        );
      }
    }
    for (const [key, value] of setEntries) {
      if (value.length === 0) {
        throw new InvalidParameterError(key, "empty value — unset the key to fall back to the default");
      }
      if (canonicalRegistryEnvKeys(key).includes("CODEGRAPH_ENABLED") && parseRegistryEnvBoolean(value) === undefined) {
        throw new InvalidParameterError(key, `'${value}' is not a boolean — use true, false, 1 or 0`);
      }
      this.validateEnvValue(key, value);
    }
  }

  private validateEnvValue(key: string, value: string): void {
    try {
      this.deps.validateEnvValue?.(key, value);
    } catch (err) {
      if (err instanceof ConfigError) {
        throw new InvalidParameterError(key, `'${value}' is refused by the config schema — ${err.hint}`);
      }
      throw err;
    }
  }

  private async registerAlias(input: {
    path: string;
    name: string;
  }): Promise<{ collectionName: string; alreadyIndexed: boolean }> {
    if (!input.name || input.name.length === 0) {
      throw new ProjectNameInvalidError(input.name, "empty");
    }
    if (input.name.length > 64) {
      throw new ProjectNameInvalidError(input.name, "tooLong");
    }
    if (!PROJECT_NAME_RE.test(input.name)) {
      throw new ProjectNameInvalidError(input.name, "regex");
    }
    if (!existsSync(resolve(input.path))) {
      throw new PathDoesNotExistError(input.path);
    }
    const realPath = await validatePath(input.path);

    // One path, one entry (bd tea-rags-mcp-dxa9w). Ask who CLAIMS this
    // directory before asking what it hashes to: a relocation leaves the
    // registry holding a collection the path no longer hashes to, so deriving
    // the name first would record a SECOND entry for the same directory and
    // split every path-addressed reader between the two, with nothing to say
    // which is right.
    //
    // The claimant decides the collection, and every outcome then falls out of
    // the code below unchanged: an UNNAMED entry is adopted by the `setName`
    // further down; the SAME name is the idempotent re-register; a DIFFERENT
    // name is the alias RENAME this method has always supported — an entry
    // holds one name, so renaming it cannot leave a path carrying two aliases.
    // All three end with exactly one entry on the directory.
    const claimant = this.deps.registry.findByPath(realPath);
    const collectionName = claimant?.collectionName ?? resolveCollectionName(realPath);

    // Alias-rename semantics: when the name is already held by a STALE
    // entry (its path no longer exists on disk), keep the existing
    // collection and just RE-POINT it at the new path. The physical Qdrant
    // collection, snapshot file, codegraph DB and chunksCount all stay
    // intact — only the registry's `path` field is updated. This preserves
    // every indexed datum across worktree churn (the original 2026-05-28
    // bug forced a full reindex per worktree). Subsequent path-based
    // callers (`resolveCollection({path: newPath})`) consult
    // `findByPath` and pick up the same collectionName, so the rename
    // stays transparent to the rest of the system.
    //
    // Live-live collisions (both paths still on disk) keep the original
    // ProjectNameNotUniqueError contract so users do not accidentally
    // relabel a working project's collection by re-registering its name.
    const conflicting = this.deps.registry.findByName(input.name);
    if (conflicting && conflicting.collectionName !== collectionName) {
      if (conflicting.path && !existsSync(resolve(conflicting.path))) {
        // ONE path, ONE entry (bd tea-rags-mcp-dxa9w). This is the only route
        // left by which a directory ends up carrying two entries: the stale
        // alias is re-pointed at a path some OTHER entry already holds, and
        // from then on `findByPath` answers with whichever the map yields
        // first. The re-point itself is untouched for the case it exists for —
        // a worktree that moved to a directory nothing claims.
        if (claimant) {
          throw new ProjectPathAlreadyRegisteredError(realPath, claimant);
        }
        this.deps.registry.updatePath(conflicting.collectionName, realPath);
        return { collectionName: conflicting.collectionName, alreadyIndexed: conflicting.chunksCount > 0 };
      }
      throw new ProjectNameNotUniqueError(input.name, conflicting.collectionName);
    }

    const existing = this.deps.registry.get(collectionName);

    // Rename-only fast path: entry is already populated (chunksCount > 0).
    // Skip Qdrant round-trip + record() — index_codebase owns enrichment
    // freshness; register_project is just about the alias. Calling record()
    // here would risk overwriting live data with a transient fallback if
    // Qdrant blips during the read.
    if (existing && existing.chunksCount > 0) {
      this.deps.registry.setName(collectionName, input.name);
      return { collectionName, alreadyIndexed: true };
    }

    // First register OR stub entry (chunksCount === 0, e.g. from
    // recoverFromQdrant or register-before-index): try to populate from live
    // Qdrant. Preserves the zkaz fix where re-register after index can
    // surface chunksCount / embeddingModel into a previously-empty entry.
    const enriched = await this.tryEnrichFromQdrant(collectionName, existing);

    this.deps.registry.record({
      collectionName,
      path: realPath,
      embeddingModel: enriched.embeddingModel,
      embeddingDimensions: enriched.embeddingDimensions,
      qdrantUrl: enriched.qdrantUrl,
      ...(enriched.qdrantEmbedded !== undefined ? { qdrantEmbedded: enriched.qdrantEmbedded } : {}),
      ...(enriched.embeddingBaseUrl !== undefined ? { embeddingBaseUrl: enriched.embeddingBaseUrl } : {}),
      ...(enriched.embeddingFallbackUrl !== undefined ? { embeddingFallbackUrl: enriched.embeddingFallbackUrl } : {}),
      indexedAt: enriched.indexedAt,
      teaRagsVersion: enriched.teaRagsVersion,
      chunksCount: enriched.chunksCount,
    });
    this.deps.registry.setName(collectionName, input.name);
    return { collectionName, alreadyIndexed: enriched.chunksCount > 0 };
  }

  private async tryEnrichFromQdrant(
    collectionName: string,
    existing: CollectionEntry | null,
  ): Promise<{
    chunksCount: number;
    embeddingModel: string;
    embeddingDimensions: number;
    qdrantUrl: string;
    qdrantEmbedded?: boolean;
    embeddingBaseUrl?: string;
    embeddingFallbackUrl?: string;
    indexedAt: string;
    teaRagsVersion: string;
  }> {
    // Capture embedding endpoints live from the wired provider — symmetric
    // with `qdrantUrl: qdrant.url` (read live, not from existing entry). When
    // the deps lack an embeddings provider (legacy bootstrap call), fall
    // back to the existing entry's persisted value so re-register on a
    // pre-fix entry does not erase the URL it already had on disk.
    // For registry persistence use CONFIGURED primary (getPrimaryBaseUrl);
    // never the post-failover active URL. Fall back to getBaseUrl when an
    // implementation doesn't expose the primary accessor (older provider).
    const liveEmbeddingBaseUrl = this.deps.embeddings?.getPrimaryBaseUrl?.() ?? this.deps.embeddings?.getBaseUrl?.();
    const liveEmbeddingFallbackUrl = this.deps.embeddings?.getFallbackBaseUrl?.();
    const fallback = {
      chunksCount: existing?.chunksCount ?? 0,
      embeddingModel: existing?.embeddingModel ?? "",
      embeddingDimensions: existing?.embeddingDimensions ?? 0,
      qdrantUrl: existing?.qdrantUrl ?? "",
      embeddingBaseUrl: liveEmbeddingBaseUrl ?? existing?.embeddingBaseUrl,
      embeddingFallbackUrl: liveEmbeddingFallbackUrl ?? existing?.embeddingFallbackUrl,
      indexedAt: existing?.indexedAt ?? "",
      teaRagsVersion: existing?.teaRagsVersion ?? "",
    };
    const { qdrant } = this.deps;
    if (!qdrant) return fallback;
    try {
      const exists = await qdrant.collectionExists(collectionName);
      if (!exists) return fallback;
    } catch {
      return fallback;
    }
    let { chunksCount } = fallback;
    try {
      // Chunks only — the indexing marker and schema metadata point are not
      // chunks, and status/metrics leave them out too (bd tea-rags-mcp-39xca.12).
      chunksCount = await qdrant.countPoints(collectionName, chunkPointsFilter());
    } catch {
      // keep fallback
    }
    let { embeddingDimensions } = fallback;
    try {
      const info = await qdrant.getCollectionInfo(collectionName);
      embeddingDimensions = info.vectorSize ?? embeddingDimensions;
    } catch {
      // keep fallback
    }
    let { embeddingModel, teaRagsVersion, indexedAt } = fallback;
    try {
      // Scroll the indexing-marker point (_type=indexing_metadata, one per
      // collection). Its payload carries embeddingModel, teaRagsVersion and
      // (after completion) indexedAt — set by storeIndexingMarker. Regular
      // code chunks do not.
      const markerFilter = { must: [{ key: "_type", match: { value: "indexing_metadata" } }] };
      const sample = await qdrant.scrollFiltered(collectionName, markerFilter, 1);
      const payload = (sample[0]?.payload ?? {}) as {
        embeddingModel?: unknown;
        teaRagsVersion?: unknown;
        indexedAt?: unknown;
        completedAt?: unknown;
      };
      const { embeddingModel: modelCandidate, teaRagsVersion: versionCandidate } = payload;
      if (typeof modelCandidate === "string" && modelCandidate.length > 0) {
        embeddingModel = modelCandidate;
      }
      if (typeof versionCandidate === "string" && versionCandidate.length > 0) {
        teaRagsVersion = versionCandidate;
      }
      // Prefer the explicit indexedAt; fall back to completedAt for markers
      // written by older versions that only had completedAt.
      const markerIndexedAt =
        typeof payload.indexedAt === "string" && payload.indexedAt.length > 0
          ? payload.indexedAt
          : typeof payload.completedAt === "string" && payload.completedAt.length > 0
            ? payload.completedAt
            : "";
      if (markerIndexedAt.length > 0) {
        indexedAt = markerIndexedAt;
      }
    } catch {
      // keep fallback
    }
    // Marker-derived value wins; otherwise stay honest. We do NOT stamp
    // new Date() to fake a timestamp the collection never had — `projects
    // info` renders empty indexedAt as "(unknown)". Audit #14.
    const resolvedIndexedAt = indexedAt.length > 0 ? indexedAt : fallback.indexedAt;
    return {
      chunksCount,
      embeddingModel,
      embeddingDimensions,
      ...registryQdrantBackendFields(qdrant),
      embeddingBaseUrl: fallback.embeddingBaseUrl,
      embeddingFallbackUrl: fallback.embeddingFallbackUrl,
      indexedAt: resolvedIndexedAt,
      teaRagsVersion,
    };
  }

  async list(): Promise<{ projects: ProjectInfo[] }> {
    return { projects: this.deps.registry.list() };
  }

  /**
   * Registry entries whose project directory is gone from disk, each carrying
   * the verdict on whether the sweep may remove it.
   *
   * An entry with an EMPTY or ABSENT path is not stale — `recoverFromQdrant`
   * writes those stubs precisely because no directory is known for them, so
   * there is no directory to miss, and a hand-edited or pre-`path` registry can
   * omit the field entirely (`loadRegistryFile` casts and never validates per
   * entry). `doctor` calls this on every run, so the diagnostic must not be the
   * thing that dies on the registry it is diagnosing.
   *
   * `prunable` is the rule, and it travels ON the entry so no consumer
   * re-derives it: a NAMED stale entry is recoverable — `register` re-points it
   * the moment its alias is registered at the new path, and that recovery is
   * the whole reason the re-point exists (a moved worktree keeps its index). A
   * NAMELESS one has no such route; nothing ever addresses it again.
   */
  listStale(): StaleProjectEntry[] {
    const exists = this.deps.pathExists ?? ((path: string): boolean => existsSync(resolve(path)));
    return this.deps.registry
      .list()
      .filter((entry) => typeof entry.path === "string" && entry.path.length > 0 && !exists(entry.path))
      .map((entry) => ({
        collectionName: entry.collectionName,
        name: entry.name,
        path: entry.path,
        chunksCount: entry.chunksCount,
        indexedAt: entry.indexedAt,
        prunable: entry.name === null,
        ...(entry.worktreeOf !== undefined ? { worktreeOf: entry.worktreeOf } : {}),
        ...(entry.worktreeName !== undefined ? { worktreeName: entry.worktreeName } : {}),
      }));
  }

  /**
   * Remove the stale entries nothing can recover — the ones `listStale` marked
   * `prunable`. Everything else it reports as kept, untouched.
   *
   * `stale` is a snapshot the caller already read: the CLI purges a footprint
   * per entry before the removal, and handing the same list back keeps the
   * printed sweep and the removals one read of the filesystem rather than two.
   * Omit it to read fresh.
   *
   * `blocked` names entries the caller wants left behind regardless: the CLI's
   * `--purge` puts an entry there when tearing down its footprint failed, so
   * the registry still points at what is left and the sweep can be retried.
   */
  pruneStale(options?: {
    blocked?: ReadonlySet<string>;
    stale?: readonly StaleProjectEntry[];
  }): StaleProjectPruneReport {
    const blocked = options?.blocked;
    const removed: StaleProjectEntry[] = [];
    const kept: StaleProjectEntry[] = [];
    for (const entry of options?.stale ?? this.listStale()) {
      if (!entry.prunable || blocked?.has(entry.collectionName) === true) {
        kept.push(entry);
        continue;
      }
      if (this.deps.registry.remove(entry.collectionName)) removed.push(entry);
      else kept.push(entry);
    }
    return { removed, kept };
  }

  /**
   * Remove the entry the address names. Idempotent: `removed: false` when
   * nothing claims it. Addressable by `path` because `index-codebase <path>`
   * registers WITHOUT an alias, and a name-only op left such an entry
   * impossible to remove (bd tea-rags-mcp-usbb5).
   */
  async unregister(input: ProjectRegistryAddress): Promise<{ removed: boolean }> {
    const entry = this.findEntry(input);
    if (!entry) return { removed: false };
    return { removed: this.deps.registry.remove(entry.collectionName) };
  }

  /**
   * The entry an address names, or null when nothing claims it. Validates the
   * address: exactly one of `name` / `path` / `collection`.
   *
   * A path is looked up by `resolveCollection`'s rule, not a new one: the plain
   * `resolve` spelling first (it is what a pre-canonicalization writer
   * recorded), then the realpath'd spelling `register` and `index-codebase`
   * record. Anything that finds the collection by path finds its entry here.
   */
  findEntry(address: ProjectRegistryAddress): CollectionEntry | null {
    const target = validateRegistryAddress(address);
    if (target.kind === "name") return this.deps.registry.findByName(target.value);
    if (target.kind === "collection") return this.deps.registry.get(target.value);
    const resolvedPath = resolve(target.value);
    const direct = this.deps.registry.findByPath(resolvedPath);
    if (direct) return direct;
    const canonicalPath = validatePathSync(resolvedPath);
    return canonicalPath === resolvedPath ? null : this.deps.registry.findByPath(canonicalPath);
  }

  /**
   * How to reach this entry's footprint once the entry itself is gone — what
   * the "collection still present" hint prints (bd tea-rags-mcp-usbb5).
   *
   * Never the name: an unregister removes it, so `--name X --purge` afterwards
   * finds nothing. The path when it still derives the collection (the common
   * case — `register` and `index-codebase` name a collection after its path),
   * the collection itself otherwise (a re-pointed alias, a worktree clone, a
   * recovered stub with no path). {@link unclaimedCollectionFor} reads this
   * address back to the same collection.
   */
  leftoverAddress(entry: CollectionEntry): { path: string } | { collection: string } {
    if (entry.path && resolveCollectionName(validatePathSync(entry.path)) === entry.collectionName) {
      return { path: entry.path };
    }
    return { collection: entry.collectionName };
  }

  /**
   * The collection an address names when NO registry entry claims it — the
   * leftover footprint a `--purge` after an unregister tears down. Null when
   * the address cannot name a collection (a name dies with its entry) or when
   * the collection, or the logical collection it is a generation of, is still
   * registered: that footprint is live data, never leftover.
   */
  unclaimedCollectionFor(address: ProjectRegistryAddress): string | null {
    const target = validateRegistryAddress(address);
    if (target.kind === "name") return null;
    const candidate =
      target.kind === "collection" ? target.value : resolveCollectionName(validatePathSync(target.value));
    const claimed = this.deps.registry
      .list()
      .some((entry) => candidate === entry.collectionName || isGenerationOf(candidate, entry.collectionName));
    return claimed ? null : candidate;
  }

  /**
   * Recover the project registry from live Qdrant state.
   *
   * Walks all collections in Qdrant and inserts an entry for each collection
   * not yet present in the registry. Best-effort: missing dimensions or
   * embedding model are tolerated and stored as defaults so the registry can
   * still be browsed by name. Used by `tea-rags doctor` to rebuild a
   * corrupted or wiped registry file from Qdrant + snapshots.
   */
  async recoverFromQdrant(): Promise<void> {
    const { qdrant } = this.deps;
    if (!qdrant) {
      throw new Error("recoverFromQdrant requires qdrant in deps");
    }
    const physicalCollectionNames = await qdrant.listCollections();
    for (const physicalCollectionName of physicalCollectionNames) {
      if (this.deps.registry.get(physicalCollectionName) !== null) continue;
      let dimensions = 0;
      try {
        const info = await qdrant.getCollectionInfo(physicalCollectionName);
        dimensions = info.vectorSize ?? 0;
      } catch {
        // ignore — fall back to default
      }
      let embeddingModel = "";
      let teaRagsVersion = "";
      let indexedAt = "";
      try {
        const markerFilter = { must: [{ key: "_type", match: { value: "indexing_metadata" } }] };
        const sample = await qdrant.scrollFiltered(physicalCollectionName, markerFilter, 1);
        const [first] = sample;
        const payload = (first?.payload ?? {}) as {
          embeddingModel?: unknown;
          teaRagsVersion?: unknown;
          indexedAt?: unknown;
          completedAt?: unknown;
        };
        const {
          embeddingModel: modelCandidate,
          teaRagsVersion: versionCandidate,
          indexedAt: indexedAtCandidate,
          completedAt: completedAtCandidate,
        } = payload;
        if (typeof modelCandidate === "string") {
          embeddingModel = modelCandidate;
        }
        if (typeof versionCandidate === "string") {
          teaRagsVersion = versionCandidate;
        }
        if (typeof indexedAtCandidate === "string" && indexedAtCandidate.length > 0) {
          indexedAt = indexedAtCandidate;
        } else if (typeof completedAtCandidate === "string") {
          indexedAt = completedAtCandidate;
        }
      } catch {
        // ignore — fall back to default
      }
      let chunksCount = 0;
      try {
        // Chunks only, same definition as the register path above (bd tea-rags-mcp-39xca.12).
        chunksCount = await qdrant.countPoints(physicalCollectionName, chunkPointsFilter());
      } catch {
        // ignore — keep 0
      }
      this.deps.registry.record({
        collectionName: physicalCollectionName,
        path: "",
        embeddingModel,
        embeddingDimensions: dimensions,
        // Sentinel + flag, symmetric with recordRegistryEntry — the daemon's
        // URL is an ephemeral port that goes stale on restart (tea-rags-mcp-jo5yj,
        // tea-rags-mcp-lzynm).
        ...registryQdrantBackendFields(qdrant),
        indexedAt,
        teaRagsVersion,
        chunksCount,
      });
    }
  }
}
