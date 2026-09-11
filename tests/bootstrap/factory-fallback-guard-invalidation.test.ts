/**
 * Ollama failover ⇒ EmbeddingModelGuard invalidation, end to end through the
 * composition root (bd tea-rags-mcp-g5nmi).
 *
 * `resolveInfrastructure` arms `embeddings.onFallbackSwitch` BEFORE the guard
 * exists and reaches it through a slot, because the very first health check can
 * fire the hook while the guard binding is still in its temporal dead zone.
 * That ordering is invisible to every unit test of either side: the provider
 * does not know what a guard is, and the guard does not know an endpoint can
 * move under it. What breaks when the wiring is dropped is a 409 on every
 * search for the rest of the process — the canary verdict was measured against
 * the endpoint that answered, and a failover makes it describe a machine the
 * provider is no longer talking to.
 *
 * So this drives the real path: a real `OllamaEmbeddings` over a faked HTTP
 * layer, the real guard the factory builds, and the real runtime probe that
 * flips to the fallback. Only `setInterval` is faked, so the 30 s probe can be
 * reached without waiting for it while Bottleneck's own scheduling stays real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/bootstrap/config/index.js";
import { createAppContext } from "../../src/bootstrap/factory.js";
import type { OllamaEmbeddings as OllamaEmbeddingsType } from "../../src/core/adapters/embeddings/ollama.js";
import type { EmbeddingModelGuard as EmbeddingModelGuardType } from "../../src/core/adapters/qdrant/embedding-model-guard.js";
import { EMBEDDING_CANARY_TEXT, INDEXING_METADATA_ID } from "../../src/core/contracts/constants.js";

const PRIMARY_URL = "http://primary.invalid:11434";
const FALLBACK_URL = "http://fallback.invalid:11434";
const MODEL = "test-model";
const COLLECTION = "code_guarded";
/** `PRIMARY_PROBE_INTERVAL_MS` in ollama.ts — the recovery/detection probe's period. */
const PROBE_INTERVAL_MS = 30_000;
/** Deterministic canary vector: identical stored and fresh, so cosine is exactly 1. */
const CANARY_VECTOR = [1, 0, 0, 0];

// vi.hoisted: shared state the vi.mock factories below close over. vi.mock is
// hoisted above the imports, so these must be declared through vi.hoisted to be
// in scope at that point — the same idiom as the GitTrajectory spy in
// factory.test.ts.
const captured = vi.hoisted(() => ({
  embeddings: undefined as unknown,
  guard: undefined as unknown,
  primaryAlive: true,
}));
const qdrantSpies = vi.hoisted(() => ({ getPoint: vi.fn(), setPayload: vi.fn() }));

// The provider is the REAL OllamaEmbeddings — `resolveInfrastructure` arms the
// hook only for that class, so a plain stub would skip the wiring under test.
vi.mock("../../src/core/adapters/embeddings/factory.js", async () => {
  const { OllamaEmbeddings } = await import("../../src/core/adapters/embeddings/ollama.js");
  return {
    EmbeddingProviderFactory: {
      create: () => {
        const provider = new OllamaEmbeddings(MODEL, undefined, undefined, PRIMARY_URL, false, 999, FALLBACK_URL);
        captured.embeddings = provider;
        return provider;
      },
    },
  };
});

// The guard the factory builds never reaches AppContext — it is handed to the
// facades. Subclassing records the real instance without replacing it.
vi.mock("../../src/core/adapters/qdrant/embedding-model-guard.js", async (importOriginal) => {
  const mod = await (importOriginal as () => Promise<{ EmbeddingModelGuard: typeof EmbeddingModelGuardType }>)();
  const Original = mod.EmbeddingModelGuard;
  return {
    ...mod,
    EmbeddingModelGuard: class extends Original {
      constructor(...args: ConstructorParameters<typeof Original>) {
        super(...args);
        captured.guard = this;
      }
    },
  };
});

vi.mock("../../src/core/adapters/qdrant/client.js", () => ({
  QdrantManager: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.checkHealth = async () => Promise.resolve(true);
    this.url = "http://localhost:6333";
    this.getPoint = qdrantSpies.getPoint;
    this.setPayload = qdrantSpies.setPayload;
  }),
}));

// Heavy dependencies the wiring only has to construct — mirrors factory.test.ts.
vi.mock("../../src/core/api/internal/facades/ingest-facade.js", () => ({
  IngestFacade: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../../src/core/api/internal/facades/explore-facade.js", () => ({
  ExploreFacade: vi.fn().mockImplementation(function () {}),
}));
vi.mock("../../src/core/domains/explore/reranker.js", () => ({
  Reranker: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.setFilterPresetNames = vi.fn();
  }),
}));
vi.mock("../../src/core/domains/explore/rerank/presets/index.js", () => ({
  resolvePresets: vi.fn().mockReturnValue([]),
}));
vi.mock("../../src/core/domains/trajectory/static/index.js", () => ({
  StaticTrajectory: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.key = "static";
    this.payloadSignals = [];
    this.derivedSignals = [];
    this.filters = [];
    this.presets = [];
  }),
}));
vi.mock("../../src/core/domains/trajectory/git/rerank/derived-signals/index.js", () => ({
  gitDerivedSignals: [],
}));
vi.mock("../../src/core/domains/trajectory/git/rerank/presets/index.js", () => ({
  GIT_PRESETS: [],
}));
vi.mock("../../src/mcp/tools/index.js", () => ({ registerAllTools: vi.fn() }));
vi.mock("../../src/mcp/resources/index.js", () => ({ registerAllResources: vi.fn() }));
vi.mock("../../src/mcp/prompts/register.js", () => ({ registerAllPrompts: vi.fn() }));
vi.mock("../../src/mcp/prompts/index.js", () => ({ loadPromptsConfig: vi.fn() }));

vi.mock("../../src/bootstrap/config/index.js", async () => {
  const actual = await import("../../src/bootstrap/config/index.js");
  return {
    ...actual,
    getZodConfig: vi.fn().mockReturnValue({
      core: {
        debug: false,
        qdrantUrl: "http://localhost:6333",
        transportMode: "stdio",
        httpPort: 3000,
        requestTimeoutMs: 300000,
        promptsConfigFile: "/nonexistent/prompts.json",
      },
      embedding: {
        provider: "ollama",
        ollamaLegacyApi: false,
        ollamaNumGpu: 999,
        tune: { concurrency: 1, batchSize: 1024, batchTimeoutMs: 2000, retryAttempts: 3, retryDelayMs: 1000 },
      },
      ingest: { tune: { chunkerPoolSize: 4, fileConcurrency: 50, ioConcurrency: 50 } },
      trajectoryGit: {},
      vcs: { adapter: "git" },
      codegraph: {},
      qdrantTune: { deleteBatchSize: 500, deleteConcurrency: 8, deleteFlushTimeoutMs: 1000 },
      deprecations: [],
      flags: { userSetBatchSize: false },
    }),
  };
});

function makeConfig(): AppConfig {
  return {
    qdrantUrl: "http://localhost:6333",
    embeddingProvider: "ollama",
    transportMode: "stdio",
    httpPort: 3000,
    requestTimeoutMs: 300000,
    promptsConfigFile: "/nonexistent/prompts.json",
    ingestCode: {
      chunkSize: 2500,
      chunkOverlap: 300,
      supportedExtensions: [".ts"],
      ignorePatterns: [],
      enableHybridSearch: false,
    },
    exploreCode: { enableHybridSearch: false, defaultSearchLimit: 5 },
    trajectoryIngest: {},
    paths: {
      appData: "/tmp/test-tea-rags",
      snapshots: "/tmp/test-tea-rags/snapshots",
      logs: "/tmp/test-tea-rags/logs",
      models: "/tmp/test-tea-rags/models",
      daemonSocket: "/tmp/test-tea-rags/onnx.sock",
      daemonPid: "/tmp/test-tea-rags/onnx-daemon.pid",
    },
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * The two Ollama endpoints, plus a refusal for everything else (the Qdrant
 * version probe, which treats a non-OK answer as "skip"). `captured.primaryAlive`
 * is what a test flips to kill the primary mid-session.
 */
async function fakeFetch(input: string | URL): Promise<Response> {
  const url = typeof input === "string" ? input : input.href;
  if (url.startsWith(PRIMARY_URL) && !captured.primaryAlive) throw new Error("ECONNREFUSED");
  if (url.endsWith("/api/show")) {
    return jsonResponse({ model_info: { "bert.context_length": 512, "bert.embedding_length": CANARY_VECTOR.length } });
  }
  if (url.endsWith("/api/embed")) return jsonResponse({ embeddings: [CANARY_VECTOR] });
  if (url === `${PRIMARY_URL}/` || url === `${FALLBACK_URL}/`) return jsonResponse({});
  return jsonResponse({}, false);
}

describe("Ollama failover invalidates the model guard (bd tea-rags-mcp-g5nmi)", () => {
  beforeEach(() => {
    captured.primaryAlive = true;
    captured.embeddings = undefined;
    captured.guard = undefined;
    qdrantSpies.getPoint.mockReset();
    qdrantSpies.setPayload.mockReset();
    // The marker agrees with the configured model AND carries a canary equal to
    // what the fake endpoint embeds, so a clean verdict is reached and cached.
    qdrantSpies.getPoint.mockResolvedValue({
      id: INDEXING_METADATA_ID,
      payload: { embeddingModel: MODEL, canary: { text: EMBEDDING_CANARY_TEXT, vector: CANARY_VECTOR } },
    });
    qdrantSpies.setPayload.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    // Only the interval: the primary probe is the one clock this test drives.
    // Bottleneck schedules the canary embed on setTimeout, which must stay real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-checks the collection after the endpoint moves under a cached verdict", async () => {
    const ctx = await createAppContext(makeConfig());
    const embeddings = captured.embeddings as OllamaEmbeddingsType;
    const guard = captured.guard as EmbeddingModelGuardType;

    // The hook is the wiring under test: without it the rest cannot happen.
    expect(embeddings.onFallbackSwitch, "resolveInfrastructure never armed onFallbackSwitch").toBeDefined();
    expect(embeddings.getBaseUrl()).toBe(PRIMARY_URL);

    // Cold check reads the marker; the second is served from the cache — one
    // Qdrant read and one canary embed per collection per process.
    await guard.ensureMatch(COLLECTION);
    await guard.ensureMatch(COLLECTION);
    expect(qdrantSpies.getPoint).toHaveBeenCalledTimes(1);

    // The primary dies mid-session. The next probe detects it and fails over.
    captured.primaryAlive = false;
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS);
    expect(embeddings.getBaseUrl(), "the probe did not fail over to the fallback").toBe(FALLBACK_URL);

    // The cached verdict described the endpoint that just went away, so the
    // next check must measure the one now answering.
    await guard.ensureMatch(COLLECTION);
    expect(qdrantSpies.getPoint, "the failover left the stale verdict cached").toHaveBeenCalledTimes(2);

    ctx.cleanup?.();
  });
});
