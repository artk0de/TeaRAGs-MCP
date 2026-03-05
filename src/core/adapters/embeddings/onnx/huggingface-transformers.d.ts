/**
 * Ambient declaration for @huggingface/transformers (optional dependency).
 * When the package is installed, its own types take precedence.
 * When not installed, this prevents tsc from failing on dynamic import().
 */
declare module "@huggingface/transformers" {
  type Dtype = "int8" | "uint8" | "q4" | "q8" | "fp16" | "fp32" | "bnb4" | "auto" | "q4f16";

  interface PipelineOptions {
    dtype?: Dtype;
  }

  interface FeatureExtractionOutput {
    tolist(): number[][];
  }

  type FeatureExtractionPipeline = (
    texts: string[],
    options?: { pooling?: string; normalize?: boolean },
  ) => Promise<FeatureExtractionOutput>;

  export function pipeline(
    task: "feature-extraction",
    model: string,
    options?: PipelineOptions,
  ): Promise<FeatureExtractionPipeline>;
}
