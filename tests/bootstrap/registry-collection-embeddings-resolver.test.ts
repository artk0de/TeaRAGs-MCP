/**
 * RegistryCollectionEmbeddingsResolver — the registry, not the server env,
 * decides how a project's queries are embedded (bd tea-rags-mcp-b91f5).
 *
 * One MCP server config serves every registered project. Before this, the
 * server embedded every query with the ONE provider its spawn env described,
 * so a project indexed with another model could not be searched at all: the
 * model guard rejected it with INFRA_EMBEDDING_MODEL_MISMATCH. These tests run
 * the real precedence rule (`ProjectIngestFactory#envForEntry` → the "server"
 * role replay) and the real config parser, and fake only provider construction.
 */

import { describe, expect, it, vi } from "vitest";

import { parseAppConfigZod } from "../../src/bootstrap/config/parse.js";
import { ProjectIngestFactory } from "../../src/bootstrap/project-ingest-factory.js";
import { RegistryCollectionEmbeddingsResolver } from "../../src/bootstrap/registry-collection-embeddings-resolver.js";
import type { EmbeddingProvider } from "../../src/core/adapters/embeddings/base.js";
import { EmbeddingModelMismatchError } from "../../src/core/adapters/embeddings/errors.js";
import { EmbeddingModelGuard } from "../../src/core/adapters/qdrant/embedding-model-guard.js";
import type { CollectionEmbeddingBinding } from "../../src/core/api/internal/collection-embeddings.js";
import type { EmbeddingConfig } from "../../src/core/contracts/types/config.js";
import type { CollectionEntry } from "../../src/core/contracts/types/registry.js";

const MUNINN = "brokkai/Muninn-small";
const CODERANK = "nomic-ai/CodeRankEmbed";
const AMBIENT_MODEL = "jina-ambient";

/** The server's spawn env: a THIRD model, neither project's. */
const SERVER_ENV: Record<string, string> = {
  EMBEDDING_PROVIDER: "llama-server",
  EMBEDDING_MODEL: AMBIENT_MODEL,
  EMBEDDING_BASE_URL: "http://192.168.1.71:9000",
};

function entry(over: Partial<CollectionEntry>): CollectionEntry {
  return {
    collectionName: "code_x",
    path: "/repo/x",
    name: null,
    embeddingModel: MUNINN,
    embeddingDimensions: 384,
    qdrantUrl: "http://127.0.0.1:6333",
    indexedAt: "2026-10-01T00:00:00Z",
    teaRagsVersion: "1.45.1",
    chunksCount: 10,
    ...over,
  };
}

const TEA_RAGS = entry({
  collectionName: "code_tea",
  path: "/repo/tea-rags",
  embeddingModel: MUNINN,
  embeddingDimensions: 384,
  embeddingBaseUrl: "http://192.168.1.71:8091",
  embeddingFallbackUrl: "http://192.168.1.71:8092",
  env: { EMBEDDING_PROVIDER: "llama-server" },
});
const PIXBAR = entry({
  collectionName: "code_pix",
  path: "/repo/pixbar-tiles",
  embeddingModel: CODERANK,
  embeddingDimensions: 768,
  embeddingBaseUrl: "http://192.168.1.71:8081",
  embeddingFallbackUrl: "http://192.168.1.71:8082",
  env: { EMBEDDING_PROVIDER: "llama-server" },
});

/** A provider fake carrying the config it was built from. */
interface FakeProvider extends EmbeddingProvider {
  builtFrom: EmbeddingConfig;
}

function fakeProvider(config: EmbeddingConfig): FakeProvider {
  return {
    builtFrom: config,
    embed: vi.fn(async () => ({ embedding: [1, 0, 0], dimensions: 3 })),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: [1, 0, 0], dimensions: 3 }))),
    getDimensions: () => config.dimensions ?? 3,
    getModel: () => config.model ?? "",
  } as unknown as FakeProvider;
}

/** Qdrant fake whose collections each carry the marker of the model that built them. */
function markerQdrant(markers: Record<string, string>) {
  return {
    getPoint: vi.fn(async (collectionName: string) =>
      markers[collectionName] ? { id: 0, payload: { embeddingModel: markers[collectionName] } } : null,
    ),
    setPayload: vi.fn(async () => undefined),
  } as never;
}

function setup(entries: CollectionEntry[], markers: Record<string, string> = {}) {
  const qdrant = markerQdrant(markers);
  const ingest = new ProjectIngestFactory({
    registry: {
      findByName: () => null,
      findByPath: (p) => entries.find((e) => e.path === p) ?? null,
      list: () => entries,
    },
    processIngest: {} as never,
    buildIngest: () => ({}) as never,
    ambientEnv: SERVER_ENV,
    ambientEnvRole: "server",
  });
  const builds: EmbeddingConfig[] = [];
  const bindingOf = (config: EmbeddingConfig): CollectionEmbeddingBinding => {
    const embeddings = fakeProvider(config);
    return { embeddings, modelGuard: new EmbeddingModelGuard(qdrant, embeddings.getModel(), 3) };
  };
  const ambientConfig = parseAppConfigZod(SERVER_ENV).embedding;
  const ambient = bindingOf(ambientConfig);
  const resolver = new RegistryCollectionEmbeddingsResolver({
    registry: { get: (name) => entries.find((e) => e.collectionName === name) ?? null },
    envForEntry: (e) => ingest.envForEntry(e),
    parseEmbeddingConfig: (env) => parseAppConfigZod(env).embedding,
    buildBinding: (config) => {
      builds.push(config);
      return { binding: bindingOf(config), ready: Promise.resolve() };
    },
    ambient: { config: ambientConfig, binding: ambient },
  });
  return { resolver, ambient, builds };
}

const builtFrom = (binding: CollectionEmbeddingBinding): EmbeddingConfig =>
  (binding.embeddings as FakeProvider).builtFrom;

describe("RegistryCollectionEmbeddingsResolver", () => {
  it("embeds two collections each with its own registry model under one ambient env with a third model", async () => {
    const { resolver } = setup([TEA_RAGS, PIXBAR]);

    const tea = builtFrom(await resolver.forCollection("code_tea"));
    const pix = builtFrom(await resolver.forCollection("code_pix"));

    expect(tea).toMatchObject({
      provider: "llama-server",
      model: MUNINN,
      baseUrl: "http://192.168.1.71:8091",
      fallbackBaseUrl: "http://192.168.1.71:8092",
    });
    expect(pix).toMatchObject({
      provider: "llama-server",
      model: CODERANK,
      baseUrl: "http://192.168.1.71:8081",
      fallbackBaseUrl: "http://192.168.1.71:8082",
    });
  });

  it("guards each collection against its registry model — a divergent ambient env never raises", async () => {
    const { resolver } = setup([TEA_RAGS, PIXBAR], { code_tea: MUNINN, code_pix: CODERANK });

    for (const name of ["code_tea", "code_pix"]) {
      const { modelGuard } = await resolver.forCollection(name);
      await expect(modelGuard.ensureMatch(name, { nameOnly: true })).resolves.toBeUndefined();
    }
  });

  it("still raises when the index marker disagrees with the registry entry's model", async () => {
    const { resolver } = setup([PIXBAR], { code_pix: MUNINN });

    const { modelGuard } = await resolver.forCollection("code_pix");

    await expect(modelGuard.ensureMatch("code_pix", { nameOnly: true })).rejects.toBeInstanceOf(
      EmbeddingModelMismatchError,
    );
  });

  it("falls back to the ambient binding for a collection the registry does not know", async () => {
    const { resolver, ambient, builds } = setup([TEA_RAGS]);

    expect(await resolver.forCollection("code_unregistered")).toBe(ambient);
    expect(builds).toHaveLength(0);
  });

  it("falls back to the ambient binding for an entry that recorded no embedding model", async () => {
    const { resolver, ambient } = setup([entry({ collectionName: "code_legacy", embeddingModel: "" })]);

    expect(await resolver.forCollection("code_legacy")).toBe(ambient);
  });

  it("reuses the ambient binding for an entry whose resolved identity IS the ambient one", async () => {
    const { resolver, ambient, builds } = setup([
      entry({
        collectionName: "code_same",
        embeddingModel: AMBIENT_MODEL,
        env: { EMBEDDING_PROVIDER: "llama-server" },
      }),
    ]);

    expect(await resolver.forCollection("code_same")).toBe(ambient);
    expect(builds).toHaveLength(0);
  });

  it("builds one provider per resolved identity and reuses it across queries and collections", async () => {
    const twin = { ...PIXBAR, collectionName: "code_pix_worktree", path: "/repo/pixbar-tiles-wt" };
    const { resolver, builds } = setup([PIXBAR, twin]);

    const first = await resolver.forCollection("code_pix");
    const again = await resolver.forCollection("code_pix");
    const sibling = await resolver.forCollection("code_pix_worktree");

    expect(again).toBe(first);
    expect(sibling).toBe(first);
    expect(builds).toHaveLength(1);
  });

  it("concurrent first queries of one identity share a single build", async () => {
    const { resolver, builds } = setup([PIXBAR]);

    const [a, b] = await Promise.all([resolver.forCollection("code_pix"), resolver.forCollection("code_pix")]);

    expect(a).toBe(b);
    expect(builds).toHaveLength(1);
  });

  it("hands an ingest slice the binding of its parsed embedding config, cached by the same identity", async () => {
    const { resolver, builds } = setup([PIXBAR]);

    const queried = await resolver.forCollection("code_pix");
    const ingested = resolver.forEmbeddingConfig(builtFrom(queried));

    expect(ingested).toBe(queried);
    expect(builds).toHaveLength(1);
  });

  it("falls back to the ambient binding when the entry's env no longer parses", async () => {
    const broken = entry({ collectionName: "code_broken", env: { EMBEDDING_PROVIDER: "no-such-provider" } });
    const { resolver, ambient } = setup([broken]);

    expect(await resolver.forCollection("code_broken")).toBe(ambient);
  });

  it("retries a build whose preparation failed instead of caching the failure", async () => {
    const qdrant = markerQdrant({});
    let attempts = 0;
    const ambientConfig = parseAppConfigZod(SERVER_ENV).embedding;
    const ambientProvider = fakeProvider(ambientConfig);
    const resolver = new RegistryCollectionEmbeddingsResolver({
      registry: { get: (name) => (name === "code_pix" ? PIXBAR : null) },
      envForEntry: () => ({ ...SERVER_ENV, EMBEDDING_MODEL: CODERANK }),
      parseEmbeddingConfig: (env) => parseAppConfigZod(env).embedding,
      buildBinding: (config) => {
        attempts += 1;
        const embeddings = fakeProvider(config);
        return {
          binding: { embeddings, modelGuard: new EmbeddingModelGuard(qdrant, embeddings.getModel(), 3) },
          ready: attempts === 1 ? Promise.reject(new Error("model load failed")) : Promise.resolve(),
        };
      },
      ambient: {
        config: ambientConfig,
        binding: { embeddings: ambientProvider, modelGuard: new EmbeddingModelGuard(qdrant, AMBIENT_MODEL, 3) },
      },
    });

    await expect(resolver.forCollection("code_pix")).rejects.toThrow("model load failed");
    await expect(resolver.forCollection("code_pix")).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });

  it("hands a caller that embeds nothing the binding without waiting for the provider to prepare", async () => {
    // A name-only check (rank_chunks, find_symbol) must not wait out model
    // discovery on a slow or dead endpoint (bd tea-rags-mcp-xi2r9, B3).
    const qdrant = markerQdrant({ code_pix: CODERANK });
    const ambientConfig = parseAppConfigZod(SERVER_ENV).embedding;
    const ambientProvider = fakeProvider(ambientConfig);
    const resolver = new RegistryCollectionEmbeddingsResolver({
      registry: { get: (name) => (name === "code_pix" ? PIXBAR : null) },
      envForEntry: () => ({ ...SERVER_ENV, EMBEDDING_MODEL: CODERANK }),
      parseEmbeddingConfig: (env) => parseAppConfigZod(env).embedding,
      buildBinding: (config) => {
        const embeddings = fakeProvider(config);
        return {
          binding: { embeddings, modelGuard: new EmbeddingModelGuard(qdrant, embeddings.getModel(), 3) },
          ready: new Promise<void>(() => undefined),
        };
      },
      ambient: {
        config: ambientConfig,
        binding: { embeddings: ambientProvider, modelGuard: new EmbeddingModelGuard(qdrant, AMBIENT_MODEL, 3) },
      },
    });

    const binding = await resolver.forCollection("code_pix", { embeds: false });

    expect(binding.embeddings.getModel()).toBe(CODERANK);
    await expect(binding.modelGuard.ensureMatch("code_pix", { nameOnly: true })).resolves.toBeUndefined();
  });
});
