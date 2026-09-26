/**
 * ONNX device detection.
 *
 * Resolves EMBEDDING_DEVICE config to a concrete device string
 * for @huggingface/transformers pipeline.
 *
 * Priority: explicit device > auto-detect (webgpu) > cpu fallback.
 * WebGPU maps to Metal (macOS), D3D12 (Windows), Vulkan (Linux).
 */

/** Resolve device string: explicit > webgpu > cpu */
export function detectDevice(requested?: string): string {
  // Explicit device — use as-is
  if (requested && requested !== "auto") return requested;

  // Auto-detect: try webgpu (Metal/D3D12/Vulkan), fallback to cpu
  // WebGPU availability is validated at pipeline creation time
  return "webgpu";
}

/** onnxruntime session graph-optimization level. */
export type GraphOptimizationLevel = "all" | "extended";

/**
 * Graph-optimization level for a (device, dtype) session.
 *
 * "all" everywhere it loads. The CPU provider on an fp16 model is the
 * exception: onnxruntime 1.24.3 aborts session init there
 * (`GetIndexFromName … InsertedPrecisionFreeCast_`, raised from
 * SimplifiedLayerNormFusion), while "extended" loads and embeds. Measured on
 * jina-embeddings-v2-base-code: cpu+fp16 fails at "all", loads at "extended";
 * cpu+fp32, cpu+q8 and webgpu+fp16 load at "all" (bd tea-rags-mcp-a3wk).
 */
export function graphOptimizationLevelFor(device: string, dtype: string | undefined): GraphOptimizationLevel {
  return device === "cpu" && dtype === "fp16" ? "extended" : "all";
}
