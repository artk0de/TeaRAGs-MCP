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

// Check for --full flag
export const isFullMode = process.argv.includes("--full");

export const CRITERIA = {
  DEGRADATION_THRESHOLD: 0.20,      // 20% drop from best = stop
  CONSECUTIVE_DEGRADATIONS: 3,      // 3 drops in a row = stop
  TEST_TIMEOUT_MS: 45000,           // 45s max per single test
  ERROR_RATE_THRESHOLD: 0.10,       // >10% errors = stop
  NO_IMPROVEMENT_THRESHOLD: 0.15,   // <15% improvement = stop
  WARMUP_RUNS: 2,                   // Warmup for Qdrant tests
  TEST_RUNS: 3,                     // Test runs for accuracy
  EMBEDDING_WARMUP_SAMPLES: 512,    // GPU warmup samples
};

/**
 * Embedding Calibration Configuration
 *
 * KEY PRINCIPLE: FIXED sample count for ALL tests (apples-to-apples comparison)
 *
 * Quick mode (~2-3 min): Fast estimation for daily use
 * Full mode (~10-15 min): Precise calibration for initial setup
 */
export const EMBEDDING_CALIBRATION = isFullMode ? {
  // Full mode - comprehensive testing
  FIXED_SAMPLES: 8192,              // Same sample count for ALL tests
  RUNS: 3,                          // Multiple runs for median (noise reduction)
  BATCH_VALUES: [128, 256, 512, 1024, 2048, 4096],
  CONC_VALUES: [1, 2, 4, 8],
  VALIDATION_SAMPLES: 16384,        // Larger validation run
} : {
  // Quick mode - fast estimation
  FIXED_SAMPLES: 4096,              // Enough for GPU stabilization
  RUNS: 2,                          // Minimum for outlier detection
  BATCH_VALUES: [256, 1024, 4096],  // Logarithmic sampling
  CONC_VALUES: [1, 2, 4],           // Main concurrency range
  VALIDATION_SAMPLES: 8192,
};

// Smart stepping parameters (for Qdrant tests, NOT for embedding calibration)
export const SMART_STEPPING = {
  CODE_BATCH_SIZE: { start: 64, max: 8192 },
};

// Fixed test values for parameters where smart stepping doesn't apply
export const TEST_VALUES = {
  QDRANT_BATCH_ORDERING: ["weak", "medium", "strong"],
  QDRANT_FLUSH_INTERVAL_MS: [100, 250, 500, 1000],
  QDRANT_DELETE_BATCH_SIZE: [100, 250, 500, 750, 1000, 1500, 2000],
  QDRANT_DELETE_CONCURRENCY: [2, 4, 8, 12, 16],
};

// Sample size for tuning benchmark (used for Qdrant tests)
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
// Median chunk size in real collections is ~500 chars
// Based on real data: 3.5M LoC project → ~70K chunks at CODE_CHUNK_SIZE=2500
export const AVG_CHUNK_CHARS = 500;
export const AVG_LOC_PER_CHUNK = 50;

// Benchmark uses MEDIAN_CODE_CHUNK_SIZE from real collections for realistic GPU load
// Default 500 chars - matches median size in production collections
export const MEDIAN_CODE_CHUNK_SIZE = parseInt(process.env.MEDIAN_CODE_CHUNK_SIZE || "500", 10);
