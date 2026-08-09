/**
 * Eager resolution of the embedding model's real parameters, run once at the
 * composition root before anything reads them.
 *
 * A provider's constructor is synchronous, so the width it reports at first is
 * whatever a static table could offer — and that table holds a few dozen names
 * while the world holds thousands. The model itself knows better: Ollama serves
 * its GGUF metadata over `/api/show`, ONNX reports from the session. Asking once,
 * here, is what turns a guess into a fact for every consumer downstream — the
 * model-mixing guard, the registry entry, every zero-vector artifact.
 *
 * Field report that motivated this (PR #2, sdrobov): a 1024-wide model absent
 * from the table was assumed 768-wide, the indexing marker was rejected by
 * Qdrant, and git enrichment produced zero signals across ~7,500 chunks while the
 * CLI reported a clean run. Nothing in the output hinted at a problem.
 */

import type { EmbeddingProvider } from "../core/adapters/embeddings/base.js";
import { getModelDimensions } from "../core/adapters/embeddings/utils/model-dimensions.js";

/**
 * Ask the provider what its model actually is, and report if nothing could tell
 * us. Never throws: an unreachable provider is a reason to fall back to the
 * configured width, not to refuse to start.
 *
 * The warning is unconditional rather than DEBUG-gated. The operator who needs
 * it is precisely the one running with default logging, and the failure it
 * predicts is silent by nature.
 */
export async function resolveEmbeddingModelParameters(
  embeddings: EmbeddingProvider,
  configuredDimensions: number | undefined,
): Promise<void> {
  const verified = await resolveQuietly(embeddings);
  if (verified) return;

  // Unverified is fine as long as something else vouches for the width.
  if (configuredDimensions !== undefined && configuredDimensions > 0) return;
  const model = embeddings.getModel();
  if (getModelDimensions(model) !== undefined) return;

  console.error(
    `[embedding] Could not confirm the vector width of "${model}": the provider reported no model info ` +
      `and the model is not in the dimension registry. Proceeding with a ${embeddings.getDimensions()}-dim assumption — ` +
      `set EMBEDDING_DIMENSIONS to pin it if that is wrong.`,
  );
}

/** Resolve model info, treating any provider failure as "could not tell us". */
async function resolveQuietly(embeddings: EmbeddingProvider): Promise<boolean> {
  try {
    return (await embeddings.resolveModelInfo?.()) !== undefined;
  } catch {
    return false;
  }
}
