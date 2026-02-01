/**
 * Benchmark Configuration
 */

export const config = {
  QDRANT_URL: process.env.QDRANT_URL || "http://localhost:6333",
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL || "http://localhost:11434",
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || "unclemusclez/jina-embeddings-v2-base-code:latest",
  // EMBEDDING_DIMENSION is auto-detected from model if not provided
  EMBEDDING_DIMENSION: process.env.EMBEDDING_DIMENSION ? parseInt(process.env.EMBEDDING_DIMENSION, 10) : undefined,
};

export const CRITERIA = {
  DEGRADATION_THRESHOLD: 0.20,      // 20% drop from best = stop
  CONSECUTIVE_DEGRADATIONS: 3,      // 3 drops in a row = stop
  TEST_TIMEOUT_MS: 45000,           // 45s max per single test
  ERROR_RATE_THRESHOLD: 0.10,       // >10% errors = stop
  NO_IMPROVEMENT_THRESHOLD: 0.15,   // <15% improvement = stop
  WARMUP_RUNS: 2,                   // Warmup for Qdrant tests
  TEST_RUNS: 3,                     // Test runs for accuracy
  EMBEDDING_WARMUP_RUNS: 5,         // More warmup for GPU to reach stable state
  EMBEDDING_WARMUP_SAMPLES: 256,    // Larger warmup batches for GPU (target 85-90% utilization)
};

// Smart stepping parameters (binary search-like, doubles until drop then tries midpoint)
export const SMART_STEPPING = {
  EMBEDDING_BATCH_SIZE: { start: 32, max: 8192 },
  CODE_BATCH_SIZE: { start: 64, max: 8192 },
};

// Fixed test values for parameters where smart stepping doesn't apply
export const TEST_VALUES = {
  EMBEDDING_CONCURRENCY: [1, 2, 4, 8, 16],
  QDRANT_BATCH_ORDERING: ["weak", "medium", "strong"],
  QDRANT_FLUSH_INTERVAL_MS: [100, 250, 500, 1000],
  QDRANT_DELETE_BATCH_SIZE: [100, 250, 500, 750, 1000, 1500, 2000],
  QDRANT_DELETE_CONCURRENCY: [2, 4, 8, 12, 16],
};

// Sample size for tuning benchmark (can be increased for more accurate results)
export const SAMPLE_SIZE = parseInt(process.env.TUNE_SAMPLE_SIZE || "4096", 10);

// Project sizes for time estimation (in lines of code)
export const PROJECT_SIZES = [
  { name: "Small CLI tool", loc: 10_000 },
  { name: "Medium library", loc: 50_000 },
  { name: "Large library", loc: 100_000 },
  { name: "Enterprise app", loc: 500_000 },
  { name: "Large codebase", loc: 1_000_000 },
  { name: "VS Code", loc: 3_500_000 },
  { name: "Kubernetes", loc: 5_000_000 },
  { name: "Linux kernel", loc: 10_000_000 },
];

// Average chunk size in characters (for estimation)
// Default CODE_CHUNK_SIZE is 2500 chars, average line is ~60-80 chars
// So roughly 30-40 LoC per chunk (using 35 as middle estimate)
export const AVG_CHUNK_CHARS = 2500;
export const AVG_LOC_PER_CHUNK = 35;

// Benchmark uses same CODE_CHUNK_SIZE as main system for realistic GPU load
// Default 2500 chars - matches real indexing workload
export const CODE_CHUNK_SIZE = parseInt(process.env.CODE_CHUNK_SIZE || "2500", 10);

// Number of samples per batch size test (smaller = faster, but less accurate)
// 256 samples provides good balance of speed and accuracy
export const BATCH_TEST_SAMPLES = parseInt(process.env.BATCH_TEST_SAMPLES || "256", 10);
