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
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "jina-embeddings-v2-base-code": 768,
  "unclemusclez/jina-embeddings-v2-base-code:latest": 768,

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

/** Strip quantization suffix (-fp16, -fp32, -q8, -q8_0, etc.) from a model name. */
export function stripQuantizationSuffix(model: string): string {
  return model.replace(QUANT_SUFFIX, "");
}

/**
 * Look up default dimensions for a known model.
 * Tries exact match first, then strips quantization suffix and retries.
 * Returns `undefined` for unknown models.
 */
export function getModelDimensions(model: string): number | undefined {
  return MODEL_DIMENSIONS[model] ?? MODEL_DIMENSIONS[stripQuantizationSuffix(model)];
}
