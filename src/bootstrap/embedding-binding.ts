/**
 * The ONE construction path of an embedding provider and the model guard that
 * travels with it (bd tea-rags-mcp-b91f5).
 *
 * The process provider (built from the spawn env at startup) and every
 * per-collection provider (built from a project's registry env on first query,
 * `RegistryCollectionEmbeddingsResolver`) come out of here, so a registry-built
 * provider is wired exactly like the process one: the same failover
 * observability, the same recovery-wait reporting, the same eager init and
 * model-parameter discovery, and a guard measured against THIS provider's model.
 */

import type { EmbeddingProvider } from "../core/adapters/embeddings/base.js";
import { EmbeddingProviderFactory, type EmbeddingPaths } from "../core/adapters/embeddings/factory.js";
import { LlamaServerEmbeddings } from "../core/adapters/embeddings/llama-server/provider.js";
import { OllamaEmbeddings, type OllamaRecoveryWaitEvent } from "../core/adapters/embeddings/ollama.js";
import type { QdrantManager } from "../core/adapters/qdrant/client.js";
import { EmbeddingModelGuard } from "../core/adapters/qdrant/embedding-model-guard.js";
import type { EmbeddingConfig } from "../core/contracts/types/config.js";
import { pipelineLog } from "../core/domains/ingest/pipeline/infra/debug-logger.js";
import { armEmbeddingModelParameters } from "./embedding-parameters.js";
import type { PreparedCollectionEmbeddingBinding } from "./registry-collection-embeddings-resolver.js";

export interface EmbeddingBindingDeps {
  qdrant: QdrantManager;
  paths: EmbeddingPaths;
  /** Notified while a provider waits out an outage (CLI progress, over IPC). */
  onRecoveryWait?: (event: OllamaRecoveryWaitEvent) => void;
}

/**
 * Build a provider from `config` and the guard holding collections to its
 * model. The binding is usable at once; `ready` settles once the provider has
 * initialised and described its model — the process path awaits it before
 * anything reads `getDimensions()`.
 */
export function buildEmbeddingBinding(
  config: EmbeddingConfig,
  deps: EmbeddingBindingDeps,
): PreparedCollectionEmbeddingBinding {
  const embeddings = EmbeddingProviderFactory.create(config, deps.paths);

  // Filled once the guard below exists. The fallback hook can fire before that
  // — any provider call that decides the endpoint (an eager ONNX-style init,
  // model info for a fixed endpoint) may run first — so the handler reaches
  // the guard through a slot instead of closing over a binding that is still
  // in its temporal dead zone.
  const modelGuardSlot: { current?: EmbeddingModelGuard } = {};

  // Wire Ollama fallback observability into pipeline debug log
  if (embeddings instanceof OllamaEmbeddings) {
    embeddings.onFallbackSwitch = (event) => {
      const level = event.direction === "to-fallback" ? 1 : 0;
      pipelineLog.fallback(
        { component: "Ollama" },
        level,
        `${event.direction}: ${event.primaryUrl} → ${event.fallbackUrl} (${event.reason})`,
      );
      // The canary verdict is measured against whichever endpoint answered.
      // Keeping it across a switch would 409 every search for the rest of the
      // process, even once the provider is back on an endpoint that agrees
      // with the index. Drop it and let the next check re-measure.
      modelGuardSlot.current?.invalidateAll();
    };
    // Armed before the first request below, so a provider that is already
    // down at startup is reported as a wait from its first pause on.
    if (deps.onRecoveryWait) embeddings.onRecoveryWait = deps.onRecoveryWait;
  } else if (embeddings instanceof LlamaServerEmbeddings && deps.onRecoveryWait) {
    embeddings.onRecoveryWait = deps.onRecoveryWait;
  }

  // The provider is what lets the guard catch a model that kept its name and
  // changed its weights: it re-embeds the canary stored in the marker.
  const modelGuard = new EmbeddingModelGuard(
    deps.qdrant,
    embeddings.getModel(),
    embeddings.getDimensions(),
    embeddings,
  );
  modelGuardSlot.current = modelGuard;

  return { binding: { embeddings, modelGuard }, ready: prepareEmbeddings(embeddings, config.dimensions) };
}

async function prepareEmbeddings(embeddings: EmbeddingProvider, configuredDimensions?: number): Promise<void> {
  // Eagerly init ONNX to get calibrated batch size before pipeline config
  if ("initialize" in embeddings && typeof embeddings.initialize === "function") {
    await (embeddings as { initialize: () => Promise<void> }).initialize();
  }
  // Ask the model what it actually is before anything consumes getDimensions().
  // The constructor could only read a static table; the model's own config is
  // the authority. A provider that picks its endpoint lazily is asked once it
  // has picked it — asking here would force the pick at start (B3).
  await armEmbeddingModelParameters(embeddings, configuredDimensions);
}
