/**
 * RegistryCollectionEmbeddingsResolver — the embedding provider a collection is
 * embedded with, built from that collection's REGISTRY entry rather than from
 * the serving process's env (bd tea-rags-mcp-b91f5).
 *
 * A long-lived MCP server is spawned with one env for every project it serves.
 * Index runs already replay each project's registry stamp over it
 * (`ProjectIngestFactory`), but the query path embedded with the process
 * provider only, so a project indexed with another model was unsearchable —
 * the model guard rejected it. This resolver closes that gap with the SAME
 * resolution an index run uses: the entry's env replayed over the ambient env
 * under the process's ambient role (`ProjectIngestFactory#envForEntry`), parsed
 * by the same config parser, and the provider built by the same construction
 * path the process provider was (`buildEmbeddingBinding`).
 *
 * Bindings are cached by the parsed embedding config — provider kind, model,
 * endpoints and tuning — so every query of a project, and every project that
 * shares a configuration, reuses one provider with its endpoint pool and tuner.
 * The process binding is pre-seeded under its own identity: a project whose
 * stamp resolves to the server's config never gets a second provider.
 */

import type {
  CollectionEmbeddingBinding,
  CollectionEmbeddingsRequest,
  CollectionEmbeddingsResolver,
} from "../core/api/index.js";
import type { CollectionEntry } from "../core/api/public/index.js";
import type { EmbeddingConfig } from "../core/contracts/types/config.js";
import { isDebug } from "../core/infra/runtime.js";

/** A binding as constructed: usable at once, ready to embed once `ready` settles. */
export interface PreparedCollectionEmbeddingBinding {
  binding: CollectionEmbeddingBinding;
  /** Model preparation (eager init, model-parameter discovery). Rejects when the provider cannot start. */
  ready: Promise<void>;
}

export interface RegistryCollectionEmbeddingsResolverDeps {
  /** Registry entry of a collection, by its (alias) collection name. */
  registry: { get: (collectionName: string) => CollectionEntry | null };
  /** The env an index run of the entry's project resolves to — the one precedence rule. */
  envForEntry: (entry: CollectionEntry) => Record<string, string>;
  /** The embedding section of the config that env parses to. Throws on an unparseable env. */
  parseEmbeddingConfig: (env: Record<string, string>) => EmbeddingConfig;
  /** The one provider-construction path, shared with the process provider. */
  buildBinding: (config: EmbeddingConfig) => PreparedCollectionEmbeddingBinding;
  /**
   * The process binding and the config it was built from, captured BEFORE any
   * adaptive adjustment wrote into that config — a project parsing the same
   * env must land on the same identity.
   */
  ambient: { config: EmbeddingConfig; binding: CollectionEmbeddingBinding };
}

interface CachedCollectionEmbeddingBinding {
  binding: CollectionEmbeddingBinding;
  ready: Promise<void>;
}

export class RegistryCollectionEmbeddingsResolver implements CollectionEmbeddingsResolver {
  private readonly byIdentity = new Map<string, CachedCollectionEmbeddingBinding>();

  constructor(private readonly deps: RegistryCollectionEmbeddingsResolverDeps) {
    this.byIdentity.set(embeddingIdentityOf(deps.ambient.config), {
      binding: deps.ambient.binding,
      ready: Promise.resolve(),
    });
  }

  async forCollection(
    collectionName: string,
    request?: CollectionEmbeddingsRequest,
  ): Promise<CollectionEmbeddingBinding> {
    const config = this.configForCollection(collectionName);
    if (!config) return this.deps.ambient.binding;
    const identity = embeddingIdentityOf(config);
    const cached = this.cachedOrBuilt(identity, config);
    // A name-only caller reads the guard's model name, which the provider knew
    // at construction; preparation keeps running for the next caller that embeds.
    if (request?.embeds === false) return cached.binding;
    try {
      await cached.ready;
    } catch (error) {
      // A provider that could not start is not remembered: the next query retries.
      if (this.byIdentity.get(identity) === cached) this.byIdentity.delete(identity);
      throw error;
    }
    return cached.binding;
  }

  /**
   * The binding for an already-parsed embedding config — an ingest slice built
   * from a project's resolved env. Synchronous: the slice is built on the
   * request path, and the provider prepares itself in the background exactly
   * as the process provider's lazy parts do.
   */
  forEmbeddingConfig(config: EmbeddingConfig): CollectionEmbeddingBinding {
    return this.cachedOrBuilt(embeddingIdentityOf(config), config).binding;
  }

  private cachedOrBuilt(identity: string, config: EmbeddingConfig): CachedCollectionEmbeddingBinding {
    const cached = this.byIdentity.get(identity);
    if (cached) return cached;
    const prepared = this.deps.buildBinding(config);
    const entry = { binding: prepared.binding, ready: prepared.ready };
    // A background failure (ingest path) must not surface as an unhandled
    // rejection; `forCollection` still observes it through `entry.ready`.
    prepared.ready.catch(() => undefined);
    this.byIdentity.set(identity, entry);
    return entry;
  }

  /**
   * The embedding config of the collection's registry entry, or undefined when
   * the process default applies: no entry, an entry that never recorded its
   * model, or a stamp this build cannot resolve or parse. The last case
   * degrades rather than fails — this runs behind every search, and the model
   * guard still refuses a collection the default model did not build.
   */
  private configForCollection(collectionName: string): EmbeddingConfig | undefined {
    const entry = this.deps.registry.get(collectionName);
    if (!entry?.embeddingModel) return undefined;
    try {
      return this.deps.parseEmbeddingConfig(this.deps.envForEntry(entry));
    } catch (error) {
      if (isDebug()) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `[Embeddings] ${collectionName}: registry env does not resolve, using the process default — ${reason}`,
        );
      }
      return undefined;
    }
  }
}

/** Order-independent identity of a parsed embedding config. */
function embeddingIdentityOf(config: EmbeddingConfig): string {
  return JSON.stringify(sortKeys(config));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, sortKeys(v)]),
  );
}
