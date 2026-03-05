import type { EmbeddingProvider, EmbeddingResult } from "./base.js";

type Pipeline = (texts: string[], options: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>;

export const DEFAULT_ONNX_MODEL = "jinaai/jina-embeddings-v2-base-code-q8";
export const DEFAULT_ONNX_DIMENSIONS = 768;

const KNOWN_DTYPES = ["q4", "q8", "fp16", "fp32", "int8", "bnb4"] as const;

type Dtype = (typeof KNOWN_DTYPES)[number];

/** Parse "Xenova/model-name-q8" → { baseModel: "Xenova/model-name", dtype: "q8" } */
function parseModelSpec(model: string): { baseModel: string; dtype: Dtype | undefined } {
  const lastDash = model.lastIndexOf("-");
  if (lastDash === -1) return { baseModel: model, dtype: undefined };

  const suffix = model.slice(lastDash + 1);
  if (KNOWN_DTYPES.includes(suffix as Dtype)) {
    return { baseModel: model.slice(0, lastDash), dtype: suffix as Dtype };
  }
  return { baseModel: model, dtype: undefined };
}

const MIN_BATCH_SIZE = 4;
const INITIAL_BATCH_SIZE = 32;

export class OnnxEmbeddings implements EmbeddingProvider {
  private readonly model: string;
  private readonly dimensions: number;
  private readonly cacheDir: string | undefined;
  private extractor: Pipeline | null = null;
  private maxBatchSize: number | null = null;

  constructor(model = DEFAULT_ONNX_MODEL, dimensions = DEFAULT_ONNX_DIMENSIONS, cacheDir?: string) {
    this.model = model;
    this.dimensions = dimensions;
    this.cacheDir = cacheDir;
  }

  private async ensureLoaded(): Promise<Pipeline> {
    if (this.extractor) return this.extractor;

    const { baseModel, dtype } = parseModelSpec(this.model);

    try {
      const { pipeline, env } = await import("@huggingface/transformers");
      const resolvedCacheDir = process.env.HF_CACHE_DIR ?? this.cacheDir;
      if (resolvedCacheDir) {
        env.cacheDir = resolvedCacheDir;
      }
      const label = dtype ? `${baseModel} (${dtype})` : baseModel;
      console.error(`[ONNX] Loading model ${label}... (first time, may download ~70MB)`);
      console.error(`[ONNX] Cache dir: ${env.cacheDir}`);
      this.extractor = (await pipeline("feature-extraction", baseModel, {
        ...(dtype ? { dtype } : {}),
      })) as unknown as Pipeline;
      console.error(`[ONNX] Model loaded.`);
      return this.extractor;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Cannot find package") || message.includes("MODULE_NOT_FOUND")) {
        throw new Error(
          "Built-in ONNX embeddings require @huggingface/transformers.\n" +
            "Install: npm install @huggingface/transformers",
        );
      }
      if (message.includes("Unauthorized")) {
        const hasToken = !!process.env.HF_TOKEN;
        throw new Error(
          `Model "${baseModel}" requires HuggingFace authentication.\n\n${
            hasToken
              ? "HF_TOKEN is set but may be invalid or lack permissions.\n\n"
              : "HF_TOKEN is not set. Follow these steps:\n\n"
          }1. Create a HuggingFace account: https://huggingface.co/join\n` +
            `2. Generate a token with READ permission: https://huggingface.co/settings/tokens\n` +
            `3. Add HF_TOKEN to your MCP server env config (e.g. in ~/.claude.json):\n   "HF_TOKEN": "hf_your_token_here"\n` +
            `4. Restart the MCP server (/mcp reconnect tea-rags)\n\n` +
            `Or use a public model: EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2`,
        );
      }
      throw new Error(`Failed to load ONNX model "${this.model}": ${message}`);
    }
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const extractor = await this.ensureLoaded();
    const output = await extractor([text], { pooling: "mean", normalize: true });
    const vectors = output.tolist();
    return {
      embedding: vectors[0],
      dimensions: this.dimensions,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const extractor = await this.ensureLoaded();
    const batchSize = this.maxBatchSize ?? INITIAL_BATCH_SIZE;
    const results: EmbeddingResult[] = [];
    let i = 0;

    while (i < texts.length) {
      const currentBatch = this.maxBatchSize ?? batchSize;
      const chunk = texts.slice(i, i + currentBatch);
      try {
        const output = await extractor(chunk, { pooling: "mean", normalize: true });
        const vectors = output.tolist();
        for (const embedding of vectors) {
          results.push({ embedding, dimensions: this.dimensions });
        }
        i += chunk.length;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        const prev = this.maxBatchSize ?? chunk.length;
        if (prev <= MIN_BATCH_SIZE) throw error;
        this.maxBatchSize = Math.max(MIN_BATCH_SIZE, Math.floor(prev / 2));
        console.error(`[ONNX] Batch of ${prev} failed (${msg}), reducing to ${this.maxBatchSize}`);
      }
    }

    return results;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }
}
