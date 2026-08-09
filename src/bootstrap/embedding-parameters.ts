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
 * us. Never throws and never stalls: a provider that is unreachable, broken, or
 * merely silent past `MODEL_INFO_BUDGET_MS` is a reason to fall back to the
 * configured width, not to refuse to start or to hold startup open.
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

/**
 * How long the composition root is willing to wait for a provider to describe
 * its model.
 *
 * The provider's own probe budget is sized for the index path, which can afford
 * to wait; this one runs on every MCP server start and every CLI command. A
 * refused connection fails instantly, but an endpoint that black-holes packets
 * does not — it sits until the full probe budget expires, on every bootstrap.
 * Measured `/api/show` latency against a LAN Ollama is 19–27ms, so a second is
 * a wide margin over a live host and a short one to lose to a dead route.
 */
export const MODEL_INFO_BUDGET_MS = 1000;

/**
 * Resolve model info within the startup budget, treating any provider failure —
 * and any silence past the budget — as "could not tell us".
 */
async function resolveQuietly(embeddings: EmbeddingProvider): Promise<boolean> {
  const pending = embeddings.resolveModelInfo?.();
  if (pending === undefined) return false;

  // Observe the outcome HERE rather than inside the race. When the budget wins,
  // this promise is left running, and an unobserved rejection would take the
  // process down. A late success is not wasted either: it still populates the
  // provider's cache, so the index path gets the answer for free.
  const answered = pending.then((info) => info !== undefined).catch(() => false);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, MODEL_INFO_BUDGET_MS);
  });

  try {
    return await Promise.race([answered, budget]);
  } finally {
    // Either the answer won and the timer is still armed, or the timer fired and
    // this is a no-op. Both leave nothing pending past the budget.
    clearTimeout(timer);
  }
}
