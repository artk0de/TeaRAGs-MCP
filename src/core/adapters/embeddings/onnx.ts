import type { EmbeddingProvider, EmbeddingResult } from "./base.js";

type Pipeline = (texts: string[], options: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>;

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

export class OnnxEmbeddings implements EmbeddingProvider {
  private readonly model: string;
  private readonly dimensions: number;
  private extractor: Pipeline | null = null;

  constructor(model = "Xenova/jina-embeddings-v2-base-code-q8", dimensions = 768) {
    this.model = model;
    this.dimensions = dimensions;
  }

  private async ensureLoaded(): Promise<Pipeline> {
    if (this.extractor) return this.extractor;

    const { baseModel, dtype } = parseModelSpec(this.model);

    try {
      const { pipeline } = await import("@huggingface/transformers");
      const label = dtype ? `${baseModel} (${dtype})` : baseModel;
      console.error(`[ONNX] Loading model ${label}... (first time, may download ~70MB)`);
      this.extractor = (await pipeline("feature-extraction", baseModel, {
        ...(dtype ? { dtype } : {}),
      })) as unknown as Pipeline;
      console.error(`[ONNX] Model loaded.`);
      return this.extractor;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Cannot find package") || message.includes("MODULE_NOT_FOUND")) {
        throw new Error(
          "Built-in ONNX embeddings require @huggingface/transformers. " +
            "Install: npm install @huggingface/transformers",
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
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    const vectors = output.tolist();

    return vectors.map((embedding: number[]) => ({
      embedding,
      dimensions: this.dimensions,
    }));
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }
}
