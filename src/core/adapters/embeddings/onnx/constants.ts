/**
 * Default GPU batch size — used as fallback if calibration fails.
 * Benchmarked optimal for WebGPU/Metal with jina-embeddings-v2 (768-dim).
 */
export const DEFAULT_GPU_BATCH_SIZE = 8;

/** Batch sizes to probe during calibration, ascending order */
export const PROBE_BATCH_SIZES = [1, 4, 8, 16, 32, 64, 128];

/** During probe: if msPerText > bestMsPerText * this, stop probing */
export const PROBE_PRESSURE_THRESHOLD = 1.5;

/** At runtime: if msPerText > rollingAvg * this, halve batch size */
export const RUNTIME_PRESSURE_THRESHOLD = 2.0;

/** At runtime: if msPerText < rollingAvg * this, double batch size */
export const RUNTIME_STABLE_THRESHOLD = 1.2;

/** Number of recent reports for rolling average */
export const ROLLING_WINDOW = 10;

/** Absolute minimum batch size (floor for adaptive reduction) */
export const MIN_BATCH_SIZE = 2;
