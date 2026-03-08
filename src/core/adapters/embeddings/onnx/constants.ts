/**
 * Maximum batch size for a single GPU inference call.
 * Larger batches are split into sub-batches of this size by the daemon.
 * Benchmarked optimal for WebGPU/Metal with jina-embeddings-v2 (768-dim).
 */
export const GPU_BATCH_SIZE = 8;
