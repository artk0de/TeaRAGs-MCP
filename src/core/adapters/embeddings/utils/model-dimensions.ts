/**
 * Provider-agnostic model → dimensions registry.
 *
 * Single source of truth for default embedding dimensions.
 * Quantization suffixes (-fp16, -fp32, -q8, etc.) are stripped before lookup
 * because they don't affect vector dimensionality.
 */

const MODEL_DIMENSIONS: Record<string, number> = {
  // ── OpenAI ──
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,

  // ── Cohere ──
  "embed-english-v3.0": 1024,
  "embed-multilingual-v3.0": 1024,
  "embed-english-light-v3.0": 384,
  "embed-multilingual-light-v3.0": 384,

  // ── Voyage ──
  "voyage-2": 1024,
  "voyage-large-2": 1536,
  "voyage-code-2": 1536,
  "voyage-code-3": 1024,
  "voyage-3-large": 1024,
  "voyage-lite-02-instruct": 1024,
  "voyage-4": 1024,
  "voyage-3.5": 1024,
  "voyage-4-lite": 512,
  "voyage-3.5-lite": 512,

  // ── Ollama ──
  // Widths below come from each model's own `/api/show` `*.embedding_length`,
  // never from a model card. Only add an entry you have measured — a wrong one
  // is worse than an absent one, because an absent one gets resolved from the
  // model itself and says so when it cannot be.
  //
  // Library models only (no user namespace). A `user/model` repack can be
  // re-uploaded under the same name with different weights, so an entry for one
  // rots silently; the eager resolve covers those without this table's help.
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "jina-embeddings-v2-base-code": 768,
  "unclemusclez/jina-embeddings-v2-base-code:latest": 768,
  "qwen3-embedding": 1024,
  "bge-m3": 1024,
  embeddinggemma: 768,

  // ── HuggingFace / ONNX ──
  "jinaai/jina-embeddings-v2-base-code": 768,
  "nomic-ai/nomic-embed-text-v1.5": 768,
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/bge-base-en-v1.5": 768,
  "Xenova/multilingual-e5-base": 768,
  "BAAI/bge-small-en-v1.5": 384,
};

/** Regex matching quantization suffixes: -fp16, -fp32, -q4, -q8, -q8_0, etc. */
const QUANT_SUFFIX = /-(fp16|fp32|q\d+[_\d]*)$/;

/**
 * Regex matching an Ollama tag: everything after the last `:`. Namespaces use
 * `/`, so a slash is never a tag boundary — `jinaai/model` keeps its namespace
 * while `mxbai-embed-large:latest` loses `:latest`.
 */
const OLLAMA_TAG = /:[^:/]+$/;

/** Strip quantization suffix (-fp16, -fp32, -q8, -q8_0, etc.) from a model name. */
export function stripQuantizationSuffix(model: string): string {
  return model.replace(QUANT_SUFFIX, "");
}

/**
 * Strip an Ollama tag (`:latest`, `:33m`, `:v1.5`) from a model name.
 *
 * The tag selects a weight variant, not a vector width, so it must not change
 * the dimension lookup. This matters because `ollama list` — and this project's
 * own setup docs — print names WITH the tag, while the registry keys are
 * canonical untagged names.
 */
export function stripOllamaTag(model: string): string {
  return model.replace(OLLAMA_TAG, "");
}

/**
 * Look up default dimensions for a known model.
 *
 * Tries the exact name first so an entry registered with its tag always wins,
 * then peels the variant markers that do not affect dimensionality:
 * quantization suffix, Ollama tag, and both together.
 * Returns `undefined` for unknown models.
 */
export function getModelDimensions(model: string): number | undefined {
  const candidates = [
    model,
    stripQuantizationSuffix(model),
    stripOllamaTag(model),
    stripQuantizationSuffix(stripOllamaTag(model)),
  ];
  for (const candidate of candidates) {
    const dimensions = MODEL_DIMENSIONS[candidate];
    if (dimensions !== undefined) return dimensions;
  }
  return undefined;
}

/**
 * The width a provider starts from before it can ask anyone: the operator's
 * configured value, then this table, then the provider's own default.
 *
 * Deliberately silent and synchronous — it runs in a constructor, where the
 * answer cannot yet be verified. The provider's REAL parameters come from the
 * model's own config (`resolveModelInfo`), which the composition root resolves
 * eagerly; `resolveEmbeddingModelParameters` is what reports a width that
 * survived as a guess. Warning here would fire before that resolve and cry wolf
 * on every model the provider is perfectly able to describe.
 */
export function resolveStartingDimensions(
  model: string,
  configured: number | undefined,
  providerDefault: number,
): number {
  if (configured !== undefined && configured > 0) return configured;
  return getModelDimensions(model) ?? providerDefault;
}
