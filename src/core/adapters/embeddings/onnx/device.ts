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
