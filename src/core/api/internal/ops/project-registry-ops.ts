import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import {
  PROJECT_NAME_RE,
  type CollectionEntry,
  type CollectionRegistry,
  type ProjectInfo,
} from "../../../infra/registry/index.js";
import { PathDoesNotExistError, ProjectNameInvalidError, ProjectNameNotUniqueError } from "../../errors.js";

export interface ProjectRegistryOpsDeps {
  registry: CollectionRegistry;
  qdrant?: QdrantManager;
  embeddings?: EmbeddingProvider;
  snapshotDir?: string;
}

export class ProjectRegistryOps {
  constructor(private readonly deps: ProjectRegistryOpsDeps) {}

  async register(input: { path: string; name: string }): Promise<{ collectionName: string; alreadyIndexed: boolean }> {
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
    const collectionName = resolveCollectionName(realPath);

    // Uniqueness check BEFORE any record() — prevents orphan-stub on conflict.
    const conflicting = this.deps.registry.findByName(input.name);
    if (conflicting && conflicting.collectionName !== collectionName) {
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
    indexedAt: string;
    teaRagsVersion: string;
  }> {
    const fallback = {
      chunksCount: existing?.chunksCount ?? 0,
      embeddingModel: existing?.embeddingModel ?? "",
      embeddingDimensions: existing?.embeddingDimensions ?? 0,
      qdrantUrl: existing?.qdrantUrl ?? "",
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
      chunksCount = await qdrant.countPoints(collectionName);
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
      qdrantUrl: qdrant.url,
      indexedAt: resolvedIndexedAt,
      teaRagsVersion,
    };
  }

  async list(): Promise<{ projects: ProjectInfo[] }> {
    return { projects: this.deps.registry.list() };
  }

  async unregister(input: { name: string }): Promise<{ removed: boolean }> {
    const entry = this.deps.registry.findByName(input.name);
    if (!entry) return { removed: false };
    return { removed: this.deps.registry.remove(entry.collectionName) };
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
    const collections = await qdrant.listCollections();
    for (const collectionName of collections) {
      if (this.deps.registry.get(collectionName) !== null) continue;
      let dimensions = 0;
      try {
        const info = await qdrant.getCollectionInfo(collectionName);
        dimensions = info.vectorSize ?? 0;
      } catch {
        // ignore — fall back to default
      }
      let embeddingModel = "";
      let teaRagsVersion = "";
      let indexedAt = "";
      try {
        const markerFilter = { must: [{ key: "_type", match: { value: "indexing_metadata" } }] };
        const sample = await qdrant.scrollFiltered(collectionName, markerFilter, 1);
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
        chunksCount = await qdrant.countPoints(collectionName);
      } catch {
        // ignore — keep 0
      }
      this.deps.registry.record({
        collectionName,
        path: "",
        embeddingModel,
        embeddingDimensions: dimensions,
        qdrantUrl: qdrant.url,
        indexedAt,
        teaRagsVersion,
        chunksCount,
      });
    }
  }
}
