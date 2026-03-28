# Benchmark Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand `npm run tune` to benchmark 7 additional performance parameters
using real project files, add git trajectory benchmarks, and abstract embedding
provider for ONNX support.

**Architecture:** New benchmark functions in `benchmarks/lib/benchmarks.mjs`
follow the existing pattern (`{param, time, rate, error}` return shape). A new
`files.mjs` helper collects source files from user-specified `--path`. Provider
abstraction in `provider.mjs` enables Ollama/ONNX selection. New phases are
appended to `tune.mjs` after existing phases.

**Tech Stack:** Node.js ESM (.mjs), ChunkerPool (worker_threads), SHA256
hashing, git CLI, existing `linearSteppingSearch`/`StoppingDecision` helpers.

**Spec:** `docs/superpowers/specs/2026-03-27-benchmark-expansion-design.md`
**Epic:** tea-rags-mcp-lpw3

---

### Task 1: File collector — `benchmarks/lib/files.mjs`

**Files:**

- Create: `benchmarks/lib/files.mjs`

Collects source files from a target project directory, respecting `.gitignore`.
Used by all Phase 1 and Phase 2 benchmarks.

- [ ] **Step 1: Create `files.mjs`**

```javascript
// benchmarks/lib/files.mjs
import { execSync } from "child_process";
import { readFileSync, statSync } from "fs";
import { extname, join } from "path";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".rb",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".swift",
  ".kt",
  ".vue",
  ".svelte",
  ".md",
]);

/**
 * Collect source files from a project directory using git ls-files.
 * Respects .gitignore. Falls back to find if not a git repo.
 *
 * @param {string} projectPath - Absolute path to project
 * @param {Object} options
 * @param {number} options.maxFiles - Max files to collect (default: 500)
 * @returns {{ path: string, size: number }[]}
 */
export function collectSourceFiles(projectPath, { maxFiles = 500 } = {}) {
  let filePaths;
  try {
    const output = execSync(
      "git ls-files --cached --others --exclude-standard",
      {
        cwd: projectPath,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    filePaths = output.trim().split("\n").filter(Boolean);
  } catch {
    throw new Error(`Not a git repository: ${projectPath}`);
  }

  const files = [];
  for (const rel of filePaths) {
    if (!SOURCE_EXTENSIONS.has(extname(rel).toLowerCase())) continue;
    const abs = join(projectPath, rel);
    try {
      const stat = statSync(abs);
      if (stat.isFile() && stat.size > 0 && stat.size < 1_000_000) {
        files.push({ path: abs, relativePath: rel, size: stat.size });
      }
    } catch {
      continue;
    }
    if (files.length >= maxFiles) break;
  }

  return files;
}

/**
 * Pre-read file contents into memory (isolate disk I/O from benchmark).
 * @param {{ path: string }[]} files
 * @returns {{ path: string, content: string, language: string }[]}
 */
export function preloadFiles(files) {
  return files.map((f) => ({
    path: f.path,
    content: readFileSync(f.path, "utf-8"),
    language: detectLanguage(extname(f.path)),
  }));
}

function detectLanguage(ext) {
  const map = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".rb": "ruby",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".cs": "c_sharp",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".swift": "swift",
    ".kt": "kotlin",
    ".vue": "vue",
    ".svelte": "svelte",
    ".md": "markdown",
  };
  return map[ext.toLowerCase()] || "text";
}
```

- [ ] **Step 2: Verify import works**

Run:
`node -e "import('./benchmarks/lib/files.mjs').then(m => console.log(Object.keys(m)))"`
Expected: `[ 'collectSourceFiles', 'preloadFiles' ]`

- [ ] **Step 3: Commit**

```bash
git add benchmarks/lib/files.mjs
git commit -m "feat(scripts): add file collector for benchmark corpus"
```

---

### Task 2: Add `--path` argument to config

**Files:**

- Modify: `benchmarks/lib/config.mjs`

- [ ] **Step 1: Parse `--path` argument**

Add after line 13 (`export const isFullMode = ...`):

```javascript
// Parse --path argument for project directory (used by pipeline benchmarks)
function parsePathArg() {
  const idx = process.argv.indexOf("--path");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return process.cwd();
}

export const PROJECT_PATH = parsePathArg();
```

- [ ] **Step 2: Add test values for new parameters**

Add after `TEST_VALUES` object (after line 65):

```javascript
export const PIPELINE_TEST_VALUES = {
  CHUNKER_POOL_SIZE: (() => {
    const cpus = (await import("os")).default.cpus().length;
    return [1, 2, 4, Math.min(8, cpus), cpus].filter((v, i, a) => a.indexOf(v) === i);
  }),
  FILE_CONCURRENCY: [10, 25, 50, 100, 200],
  IO_CONCURRENCY: [10, 25, 50, 100, 200],
  DELETE_FLUSH_TIMEOUT_MS: [250, 500, 1000, 2000, 5000],
  MIN_BATCH_RATIO: [0.125, 0.25, 0.5, 0.75],
};

export const GIT_TEST_VALUES = {
  CHUNK_CONCURRENCY: [2, 5, 10, 20, 40],
  LOG_DEPTHS_MONTHS: [3, 6, 12, 24],
};
```

Note: `CHUNKER_POOL_SIZE` is a function because `os.cpus()` is dynamic. Call it
at benchmark time:
`const values = await PIPELINE_TEST_VALUES.CHUNKER_POOL_SIZE;`

Actually, since config.mjs is not async, use sync approach instead:

```javascript
import { cpus } from "os";

export const PIPELINE_TEST_VALUES = {
  CHUNKER_POOL_SIZE: [1, 2, 4, Math.min(8, cpus().length), cpus().length]
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b),
  FILE_CONCURRENCY: [10, 25, 50, 100, 200],
  IO_CONCURRENCY: [10, 25, 50, 100, 200],
  DELETE_FLUSH_TIMEOUT_MS: [250, 500, 1000, 2000, 5000],
  MIN_BATCH_RATIO: [0.125, 0.25, 0.5, 0.75],
};

export const GIT_TEST_VALUES = {
  CHUNK_CONCURRENCY: [2, 5, 10, 20, 40],
  LOG_DEPTHS_MONTHS: [3, 6, 12, 24],
};
```

- [ ] **Step 3: Verify**

Run:
`node -e "import('./benchmarks/lib/config.mjs').then(m => console.log('PATH:', m.PROJECT_PATH, 'POOL:', m.PIPELINE_TEST_VALUES.CHUNKER_POOL_SIZE))"`
Expected: Shows cwd and array of pool sizes

- [ ] **Step 4: Commit**

```bash
git add benchmarks/lib/config.mjs
git commit -m "feat(scripts): add --path arg and test values for new benchmark params"
```

---

### Task 3: Benchmark functions — CHUNKER_POOL_SIZE

**Files:**

- Modify: `benchmarks/lib/benchmarks.mjs`

- [ ] **Step 1: Add `benchmarkChunkerPoolSize` function**

Add at end of file before `generatePoints`:

```javascript
/**
 * Benchmark chunker pool size (worker thread count for AST parsing).
 *
 * @param {{ path: string, content: string, language: string }[]} files - Preloaded files
 * @param {number} poolSize - Worker count to test
 * @returns {Promise<{poolSize: number, time: number, rate: number, error: string|null}>}
 */
export async function benchmarkChunkerPoolSize(files, poolSize) {
  const { ChunkerPool } =
    await import("../build/core/domains/ingest/pipeline/chunker/infra/pool.js");
  const chunkerConfig = {
    chunkSize: 2500,
    chunkOverlap: 300,
    maxChunkSize: 5000,
  };

  try {
    const pool = new ChunkerPool(poolSize, chunkerConfig);

    const start = Date.now();
    await Promise.all(
      files.map((f) => pool.processFile(f.path, f.content, f.language)),
    );
    const time = Date.now() - start;

    await pool.shutdown();

    const rate = Math.round((files.length * 1000) / time);
    return { poolSize, time, rate, error: null };
  } catch (error) {
    return { poolSize, time: 0, rate: 0, error: error.message };
  }
}
```

- [ ] **Step 2: Verify import path exists**

Run: `ls build/core/domains/ingest/pipeline/chunker/infra/pool.js` Expected:
File exists (run `npm run build` first if needed)

- [ ] **Step 3: Commit**

```bash
git add benchmarks/lib/benchmarks.mjs
git commit -m "feat(scripts): add benchmarkChunkerPoolSize function"
```

---

### Task 4: Benchmark functions — FILE_CONCURRENCY and IO_CONCURRENCY

**Files:**

- Modify: `benchmarks/lib/benchmarks.mjs`

- [ ] **Step 1: Add `benchmarkFileConcurrency` function**

Add after `benchmarkChunkerPoolSize`:

```javascript
/**
 * Benchmark file read concurrency (simulates file-processor parallel reads).
 * Reads files + extracts imports (CPU+IO workload).
 *
 * @param {{ path: string }[]} files - File paths to read
 * @param {number} concurrency - Parallel operations
 * @returns {Promise<{concurrency: number, time: number, rate: number, error: string|null}>}
 */
export async function benchmarkFileConcurrency(files, concurrency) {
  const { readFile } = await import("fs/promises");

  async function processOne(file) {
    const content = await readFile(file.path, "utf-8");
    // Simulate import extraction (CPU work similar to real pipeline)
    const lines = content.split("\n");
    const imports = lines.filter((l) => /^\s*(import|require|from)\b/.test(l));
    return { size: content.length, imports: imports.length };
  }

  try {
    const start = Date.now();

    // Bounded concurrency — same pattern as parallelLimit()
    const results = [];
    let index = 0;
    async function worker() {
      while (index < files.length) {
        const i = index++;
        results[i] = await processOne(files[i]);
      }
    }
    await Promise.all(
      Array(Math.min(concurrency, files.length))
        .fill(null)
        .map(() => worker()),
    );

    const time = Date.now() - start;
    const rate = Math.round((files.length * 1000) / time);
    return { concurrency, time, rate, error: null };
  } catch (error) {
    return { concurrency, time: 0, rate: 0, error: error.message };
  }
}
```

- [ ] **Step 2: Add `benchmarkIoConcurrency` function**

Add after `benchmarkFileConcurrency`:

```javascript
/**
 * Benchmark I/O concurrency (simulates cache sync: read + SHA256 hash).
 *
 * @param {{ path: string }[]} files - File paths to hash
 * @param {number} concurrency - Parallel operations
 * @returns {Promise<{concurrency: number, time: number, rate: number, error: string|null}>}
 */
export async function benchmarkIoConcurrency(files, concurrency) {
  const { readFile } = await import("fs/promises");
  const { createHash } = await import("crypto");

  async function hashOne(file) {
    const content = await readFile(file.path);
    return createHash("sha256").update(content).digest("hex");
  }

  try {
    const start = Date.now();

    const results = [];
    let index = 0;
    async function worker() {
      while (index < files.length) {
        const i = index++;
        results[i] = await hashOne(files[i]);
      }
    }
    await Promise.all(
      Array(Math.min(concurrency, files.length))
        .fill(null)
        .map(() => worker()),
    );

    const time = Date.now() - start;
    const rate = Math.round((files.length * 1000) / time);
    return { concurrency, time, rate, error: null };
  } catch (error) {
    return { concurrency, time: 0, rate: 0, error: error.message };
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add benchmarks/lib/benchmarks.mjs
git commit -m "feat(scripts): add benchmarkFileConcurrency and benchmarkIoConcurrency"
```

---

### Task 5: Benchmark functions — DELETE_FLUSH_TIMEOUT and MIN_BATCH_SIZE

**Files:**

- Modify: `benchmarks/lib/benchmarks.mjs`

- [ ] **Step 1: Add `benchmarkDeleteFlushTimeout`**

Add after `benchmarkIoConcurrency`:

```javascript
/**
 * Benchmark delete flush timeout with partial batches.
 * Simulates scenario where delete queue has < batchSize items
 * and must wait for timeout before flushing.
 *
 * @param {Object} qdrant - QdrantManager instance
 * @param {Object[]} points - Pre-generated test points
 * @param {number} timeoutMs - Flush timeout to test
 * @param {number} optimalDeleteBatch - Optimal delete batch size
 * @param {number} optimalDeleteConc - Optimal delete concurrency
 * @returns {Promise<{timeoutMs, time, rate, error}>}
 */
export async function benchmarkDeleteFlushTimeout(
  qdrant,
  points,
  timeoutMs,
  optimalDeleteBatch,
  optimalDeleteConc,
) {
  const collection = `tune_dft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  createdCollections.add(collection);

  try {
    await qdrant.createCollection(
      collection,
      config.EMBEDDING_DIMENSION,
      "Cosine",
    );

    // Insert all points
    for (let i = 0; i < points.length; i += 256) {
      const batch = points.slice(i, i + 256);
      await qdrant.addPointsOptimized(collection, batch, {
        wait: i + 256 >= points.length,
        ordering: "weak",
      });
    }

    // Delete with partial batches: use 30% of optimalDeleteBatch to trigger timeout path
    const partialBatch = Math.max(1, Math.round(optimalDeleteBatch * 0.3));
    const pointIds = points.map((p) => p.id);

    const start = Date.now();
    const queue = [];
    for (let i = 0; i < pointIds.length; i += partialBatch) {
      queue.push(pointIds.slice(i, i + partialBatch));
    }

    // Process with concurrency, adding timeout delay between batches
    // to simulate real accumulator behavior
    let idx = 0;
    async function worker() {
      while (idx < queue.length) {
        const batch = queue[idx++];
        if (batch) {
          await qdrant.client.delete(collection, { points: batch, wait: true });
          // Simulate flush timeout wait (scaled down for benchmark)
          if (batch.length < optimalDeleteBatch) {
            await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 100)));
          }
        }
      }
    }
    await Promise.all(
      Array(Math.min(optimalDeleteConc, queue.length))
        .fill(null)
        .map(() => worker()),
    );

    const time = Date.now() - start;
    const rate = Math.round((pointIds.length * 1000) / time);
    return { timeoutMs, time, rate, error: null };
  } catch (error) {
    return { timeoutMs, time: 0, rate: 0, error: error.message };
  } finally {
    try {
      await qdrant.deleteCollection(collection);
      createdCollections.delete(collection);
    } catch {}
  }
}
```

- [ ] **Step 2: Add `benchmarkMinBatchSize`**

```javascript
/**
 * Benchmark embedding min batch size (tail flush latency).
 * Measures how long it takes to embed a partial batch at different sizes.
 *
 * @param {Object} embeddings - Embedding provider
 * @param {string[]} texts - Test texts (full corpus)
 * @param {number} ratio - Ratio of optimalBatchSize (0.125, 0.25, 0.5, 0.75)
 * @param {number} optimalBatchSize - Optimal batch size from embedding calibration
 * @returns {Promise<{ratio, minBatchSize, latencyMs, error}>}
 */
export async function benchmarkMinBatchSize(
  embeddings,
  texts,
  ratio,
  optimalBatchSize,
) {
  const minBatchSize = Math.max(1, Math.round(optimalBatchSize * ratio));

  try {
    // Measure latency of embedding a partial batch (tail scenario)
    const tailTexts = texts.slice(0, minBatchSize);

    const runs = 3;
    const times = [];
    for (let i = 0; i < runs; i++) {
      const start = Date.now();
      await embeddings.embedBatch(tailTexts);
      times.push(Date.now() - start);
    }

    const latencyMs = median(times);
    return { ratio, minBatchSize, latencyMs, error: null };
  } catch (error) {
    return { ratio, minBatchSize: 0, latencyMs: 0, error: error.message };
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add benchmarks/lib/benchmarks.mjs
git commit -m "feat(scripts): add benchmarkDeleteFlushTimeout and benchmarkMinBatchSize"
```

---

### Task 6: Benchmark functions — Git trajectory

**Files:**

- Modify: `benchmarks/lib/benchmarks.mjs`

- [ ] **Step 1: Add `benchmarkGitChunkConcurrency`**

Add after `benchmarkMinBatchSize`:

```javascript
/**
 * Benchmark git chunk-level churn concurrency.
 * Runs chunk churn analysis on real repo files with varying semaphore limits.
 *
 * @param {string} repoPath - Path to git repository
 * @param {string[]} filePaths - Relative paths of files to analyze
 * @param {number} concurrency - Semaphore limit
 * @returns {Promise<{concurrency, time, rate, filesProcessed, error}>}
 */
export async function benchmarkGitChunkConcurrency(
  repoPath,
  filePaths,
  concurrency,
) {
  try {
    const { execSync } = await import("child_process");

    // Simulate chunk churn analysis: for each file, run git log with pathspec
    const start = Date.now();
    let processed = 0;

    let idx = 0;
    async function worker() {
      while (idx < filePaths.length) {
        const file = filePaths[idx++];
        if (!file) continue;
        try {
          execSync(
            `git log --oneline --follow --since="6 months ago" -- "${file}"`,
            {
              cwd: repoPath,
              encoding: "utf-8",
              maxBuffer: 5 * 1024 * 1024,
              timeout: 30000,
            },
          );
          processed++;
        } catch {
          // Timeout or error — skip file
        }
      }
    }
    await Promise.all(
      Array(Math.min(concurrency, filePaths.length))
        .fill(null)
        .map(() => worker()),
    );

    const time = Date.now() - start;
    const rate = time > 0 ? Math.round((processed * 1000) / time) : 0;
    return { concurrency, time, rate, filesProcessed: processed, error: null };
  } catch (error) {
    return {
      concurrency,
      time: 0,
      rate: 0,
      filesProcessed: 0,
      error: error.message,
    };
  }
}

/**
 * Measure git log duration at different history depths.
 *
 * @param {string} repoPath - Path to git repository
 * @param {number} months - History depth in months
 * @returns {Promise<{months, durationMs, entries, error}>}
 */
export async function measureGitLogDuration(repoPath, months) {
  try {
    const { execSync } = await import("child_process");

    const since = `${months} months ago`;
    const start = Date.now();
    const output = execSync(
      `git log --numstat --since="${since}" --format="%H"`,
      {
        cwd: repoPath,
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: 120000,
      },
    );
    const durationMs = Date.now() - start;
    const entries = output
      .split("\n")
      .filter((l) => /^[0-9a-f]{40}$/.test(l.trim())).length;

    return { months, durationMs, entries, error: null };
  } catch (error) {
    return { months, durationMs: 0, entries: 0, error: error.message };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add benchmarks/lib/benchmarks.mjs
git commit -m "feat(scripts): add git trajectory benchmark functions"
```

---

### Task 7: Update output — new env vars

**Files:**

- Modify: `benchmarks/lib/output.mjs`

- [ ] **Step 1: Add new vars to `generateEnvContent`**

After the `QDRANT_DELETE_CONCURRENCY` line in the template string, add:

```javascript
// After line: QDRANT_DELETE_CONCURRENCY=${optimal.QDRANT_DELETE_CONCURRENCY}
// Add:

# Pipeline concurrency
${optimal.INGEST_TUNE_CHUNKER_POOL_SIZE != null ? `INGEST_TUNE_CHUNKER_POOL_SIZE=${optimal.INGEST_TUNE_CHUNKER_POOL_SIZE}` : "# INGEST_TUNE_CHUNKER_POOL_SIZE=<skipped>"}
${optimal.INGEST_TUNE_FILE_CONCURRENCY != null ? `INGEST_TUNE_FILE_CONCURRENCY=${optimal.INGEST_TUNE_FILE_CONCURRENCY}` : "# INGEST_TUNE_FILE_CONCURRENCY=<skipped>"}
${optimal.INGEST_TUNE_IO_CONCURRENCY != null ? `INGEST_TUNE_IO_CONCURRENCY=${optimal.INGEST_TUNE_IO_CONCURRENCY}` : "# INGEST_TUNE_IO_CONCURRENCY=<skipped>"}
${optimal.QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS != null ? `QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS=${optimal.QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS}` : "# QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS=<skipped>"}
${optimal.EMBEDDING_TUNE_MIN_BATCH_SIZE != null ? `EMBEDDING_TUNE_MIN_BATCH_SIZE=${optimal.EMBEDDING_TUNE_MIN_BATCH_SIZE}` : "# EMBEDDING_TUNE_MIN_BATCH_SIZE=<skipped>"}
```

- [ ] **Step 2: Add new vars to `printSummary`**

After the Qdrant deletion section, add:

```javascript
if (optimal.INGEST_TUNE_CHUNKER_POOL_SIZE != null) {
  console.log(`  ${c.dim}# Pipeline${c.reset}`);
  console.log(
    `  INGEST_TUNE_CHUNKER_POOL_SIZE    = ${c.green}${c.bold}${optimal.INGEST_TUNE_CHUNKER_POOL_SIZE}${c.reset}`,
  );
  console.log(
    `  INGEST_TUNE_FILE_CONCURRENCY     = ${c.green}${c.bold}${optimal.INGEST_TUNE_FILE_CONCURRENCY}${c.reset}`,
  );
  console.log(
    `  INGEST_TUNE_IO_CONCURRENCY       = ${c.green}${c.bold}${optimal.INGEST_TUNE_IO_CONCURRENCY}${c.reset}`,
  );
  console.log();
}
if (optimal.QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS != null) {
  console.log(
    `  QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS = ${c.green}${c.bold}${optimal.QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS}${c.reset}`,
  );
}
if (optimal.EMBEDDING_TUNE_MIN_BATCH_SIZE != null) {
  console.log(
    `  EMBEDDING_TUNE_MIN_BATCH_SIZE    = ${c.green}${c.bold}${optimal.EMBEDDING_TUNE_MIN_BATCH_SIZE}${c.reset}`,
  );
}
```

- [ ] **Step 3: Add new vars to `printUsage`**

After the existing `-e` lines, add conditionals for new vars.

- [ ] **Step 4: Commit**

```bash
git add benchmarks/lib/output.mjs
git commit -m "feat(scripts): add new params to benchmark output"
```

---

### Task 8: Integrate Phase 1 into `tune.mjs`

**Files:**

- Modify: `benchmarks/tune.mjs`

- [ ] **Step 1: Add imports**

At top of `tune.mjs`, add:

```javascript
import {
  benchmarkChunkerPoolSize,
  benchmarkDeleteFlushTimeout,
  benchmarkFileConcurrency,
  benchmarkIoConcurrency,
  benchmarkMinBatchSize,
} from "./lib/benchmarks.mjs";
import { PIPELINE_TEST_VALUES, PROJECT_PATH } from "./lib/config.mjs";
import { collectSourceFiles, preloadFiles } from "./lib/files.mjs";
```

- [ ] **Step 2: Add pipeline benchmark section after embedding calibration**

After the `EMBEDDING_CONCURRENCY` is set (around line 242), before the Qdrant
batch size phase, add:

```javascript
// ============ PHASE: PIPELINE BENCHMARKS ============

// Collect project files for pipeline benchmarks
let projectFiles = null;
let preloadedFiles = null;

try {
  console.log(
    `\n${c.dim}Collecting source files from ${PROJECT_PATH}...${c.reset}`,
  );
  projectFiles = collectSourceFiles(PROJECT_PATH);

  if (projectFiles.length < 50) {
    console.log(
      `  ${c.yellow}⚠${c.reset} Only ${projectFiles.length} files found (minimum 50 recommended)`,
    );
    console.log(
      `  ${c.dim}Skipping pipeline benchmarks. Use --path <project> with a larger codebase.${c.reset}\n`,
    );
  } else {
    console.log(
      `  ${c.green}✓${c.reset} Found ${projectFiles.length} source files\n`,
    );
    preloadedFiles = preloadFiles(projectFiles);
  }
} catch (err) {
  console.log(`  ${c.yellow}⚠${c.reset} ${err.message}`);
  console.log(`  ${c.dim}Skipping pipeline benchmarks.${c.reset}\n`);
}

if (preloadedFiles && preloadedFiles.length >= 50) {
  // ---- CHUNKER_POOL_SIZE ----
  printHeader(
    "Pipeline: Chunker Pool Size",
    "Finding optimal INGEST_TUNE_CHUNKER_POOL_SIZE",
  );

  // Warmup run
  console.log(`  ${c.dim}Warmup...${c.reset}`);
  await benchmarkChunkerPoolSize(preloadedFiles, 2);

  const poolDecision = new StoppingDecision();
  for (const size of PIPELINE_TEST_VALUES.CHUNKER_POOL_SIZE) {
    process.stdout.write(
      `  Testing CHUNKER_POOL_SIZE=${c.bold}${size.toString().padStart(2)}${c.reset} `,
    );
    const result = await benchmarkChunkerPoolSize(preloadedFiles, size);
    const decision = poolDecision.addResult(result);
    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(
        `${bar(result.rate, poolDecision.bestRate)} ${formatRate(result.rate, "files/s")} ${c.dim}(${result.time}ms)${c.reset}`,
      );
    }
    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }
  const bestPool = poolDecision.getBest();
  optimal.INGEST_TUNE_CHUNKER_POOL_SIZE = bestPool?.poolSize || 4;
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: INGEST_TUNE_CHUNKER_POOL_SIZE=${optimal.INGEST_TUNE_CHUNKER_POOL_SIZE}${c.reset}`,
  );

  // ---- FILE_CONCURRENCY ----
  printHeader(
    "Pipeline: File Concurrency",
    "Finding optimal INGEST_TUNE_FILE_CONCURRENCY",
  );

  const fileDecision = new StoppingDecision();
  for (const conc of PIPELINE_TEST_VALUES.FILE_CONCURRENCY) {
    process.stdout.write(
      `  Testing FILE_CONCURRENCY=${c.bold}${conc.toString().padStart(3)}${c.reset} `,
    );
    const result = await benchmarkFileConcurrency(projectFiles, conc);
    const decision = fileDecision.addResult(result);
    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(
        `${bar(result.rate, fileDecision.bestRate)} ${formatRate(result.rate, "files/s")} ${c.dim}(${result.time}ms)${c.reset}`,
      );
    }
    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }
  const bestFile = fileDecision.getBest();
  optimal.INGEST_TUNE_FILE_CONCURRENCY = bestFile?.concurrency || 50;
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: INGEST_TUNE_FILE_CONCURRENCY=${optimal.INGEST_TUNE_FILE_CONCURRENCY}${c.reset}`,
  );

  // ---- IO_CONCURRENCY ----
  printHeader(
    "Pipeline: I/O Concurrency",
    "Finding optimal INGEST_TUNE_IO_CONCURRENCY",
  );

  const ioDecision = new StoppingDecision();
  for (const conc of PIPELINE_TEST_VALUES.IO_CONCURRENCY) {
    process.stdout.write(
      `  Testing IO_CONCURRENCY=${c.bold}${conc.toString().padStart(3)}${c.reset} `,
    );
    const result = await benchmarkIoConcurrency(projectFiles, conc);
    const decision = ioDecision.addResult(result);
    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(
        `${bar(result.rate, ioDecision.bestRate)} ${formatRate(result.rate, "files/s")} ${c.dim}(${result.time}ms)${c.reset}`,
      );
    }
    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }
  const bestIo = ioDecision.getBest();
  optimal.INGEST_TUNE_IO_CONCURRENCY = bestIo?.concurrency || 50;
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: INGEST_TUNE_IO_CONCURRENCY=${optimal.INGEST_TUNE_IO_CONCURRENCY}${c.reset}`,
  );
}
```

- [ ] **Step 3: Add DELETE_FLUSH_TIMEOUT after existing delete phases**

After Phase 8 (delete concurrency), before cleanup:

```javascript
// ============ PHASE 9: DELETE_FLUSH_TIMEOUT_MS ============

printHeader(
  "Phase 9: Delete Flush Timeout",
  "Finding optimal QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS",
);

const dftDecision = new StoppingDecision();
for (const timeoutMs of PIPELINE_TEST_VALUES.DELETE_FLUSH_TIMEOUT_MS) {
  process.stdout.write(
    `  Testing DELETE_FLUSH_TIMEOUT_MS=${c.bold}${timeoutMs.toString().padStart(4)}${c.reset} `,
  );
  const result = await benchmarkDeleteFlushTimeout(
    qdrant,
    points,
    timeoutMs,
    optimal.QDRANT_DELETE_BATCH_SIZE,
    optimal.QDRANT_DELETE_CONCURRENCY,
  );
  const decision = dftDecision.addResult(result);
  if (result.error) {
    console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
  } else {
    console.log(
      `${bar(result.rate, dftDecision.bestRate)} ${formatRate(result.rate, "del/s")} ${c.dim}(${result.time}ms)${c.reset}`,
    );
  }
  if (decision.stop) {
    console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
    break;
  }
}
const bestDft = dftDecision.getBest();
optimal.QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS = bestDft?.timeoutMs || 1000;
console.log(
  `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS=${optimal.QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS}${c.reset}`,
);
```

- [ ] **Step 4: Add MIN_BATCH_SIZE after embedding calibration results**

After delete flush timeout, before cleanup:

```javascript
// ============ PHASE 10: EMBEDDING_MIN_BATCH_SIZE ============

printHeader(
  "Phase 10: Min Batch Size",
  "Finding optimal EMBEDDING_TUNE_MIN_BATCH_SIZE (tail latency)",
);

const minBatchResults = [];
for (const ratio of PIPELINE_TEST_VALUES.MIN_BATCH_RATIO) {
  const minSize = Math.max(1, Math.round(optimal.EMBEDDING_BATCH_SIZE * ratio));
  process.stdout.write(
    `  Testing MIN_BATCH_SIZE=${c.bold}${minSize.toString().padStart(4)}${c.reset} (${Math.round(ratio * 100)}% of batch) `,
  );
  const result = await benchmarkMinBatchSize(
    embeddings,
    qdrantTexts,
    ratio,
    optimal.EMBEDDING_BATCH_SIZE,
  );
  minBatchResults.push(result);

  if (result.error) {
    console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
  } else {
    console.log(`${c.dim}${result.latencyMs}ms${c.reset}`);
  }
}

// Pick smallest ratio where latency is within 20% of the minimum latency
const validResults = minBatchResults.filter((r) => !r.error);
if (validResults.length > 0) {
  const minLatency = Math.min(...validResults.map((r) => r.latencyMs));
  const acceptable = validResults.filter(
    (r) => r.latencyMs <= minLatency * 1.2,
  );
  const best = acceptable.reduce((a, b) => (a.ratio < b.ratio ? a : b));
  optimal.EMBEDDING_TUNE_MIN_BATCH_SIZE = best.minBatchSize;
} else {
  optimal.EMBEDDING_TUNE_MIN_BATCH_SIZE = Math.round(
    optimal.EMBEDDING_BATCH_SIZE * 0.5,
  );
}
console.log(
  `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: EMBEDDING_TUNE_MIN_BATCH_SIZE=${optimal.EMBEDDING_TUNE_MIN_BATCH_SIZE}${c.reset}`,
);
```

- [ ] **Step 5: Test run**

Run: `npm run tune -- --path /path/to/some/project 2>&1 | head -100` Expected:
See new pipeline phases executing with file collection

- [ ] **Step 6: Commit**

```bash
git add benchmarks/tune.mjs
git commit -m "feat(scripts): integrate pipeline + qdrant gap benchmarks into tune.mjs"
```

---

### Task 9: Integrate Phase 2 (git trajectory) into `tune.mjs`

**Files:**

- Modify: `benchmarks/tune.mjs`

- [ ] **Step 1: Add git benchmark imports**

Add to existing import from benchmarks.mjs:

```javascript
import {
  // ... existing imports ...
  benchmarkGitChunkConcurrency,
  measureGitLogDuration,
} from "./lib/benchmarks.mjs";
import { GIT_TEST_VALUES } from "./lib/config.mjs";
```

- [ ] **Step 2: Add git trajectory section before cleanup**

After Phase 10 (min batch size), before the cleanup section:

```javascript
// ============ GIT TRAJECTORY BENCHMARKS ============

if (projectFiles && projectFiles.length >= 50) {
  // ---- GIT_CHUNK_CONCURRENCY ----
  printHeader(
    "Git: Chunk Concurrency",
    "Finding optimal TRAJECTORY_GIT_CHUNK_CONCURRENCY",
  );

  // Select top 20 files by size (proxy for commit count without running git log)
  const gitTestFiles = [...projectFiles]
    .sort((a, b) => b.size - a.size)
    .slice(0, 20)
    .map((f) => f.relativePath);

  console.log(
    `  ${c.dim}Testing with ${gitTestFiles.length} files from ${PROJECT_PATH}${c.reset}\n`,
  );

  const gitDecision = new StoppingDecision();
  for (const conc of GIT_TEST_VALUES.CHUNK_CONCURRENCY) {
    process.stdout.write(
      `  Testing GIT_CHUNK_CONCURRENCY=${c.bold}${conc.toString().padStart(2)}${c.reset} `,
    );
    const result = await benchmarkGitChunkConcurrency(
      PROJECT_PATH,
      gitTestFiles,
      conc,
    );
    const decision = gitDecision.addResult(result);
    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(
        `${bar(result.rate, gitDecision.bestRate)} ${formatRate(result.rate, "files/s")} ${c.dim}(${result.time}ms, ${result.filesProcessed} files)${c.reset}`,
      );
    }
    if (decision.stop) {
      console.log(`\n  ${c.yellow}↳ Stopping: ${decision.reason}${c.reset}`);
      break;
    }
  }
  const bestGitConc = gitDecision.getBest();
  optimal.TRAJECTORY_GIT_CHUNK_CONCURRENCY = bestGitConc?.concurrency || 10;
  console.log(
    `\n  ${c.green}✓${c.reset} ${c.bold}Optimal: TRAJECTORY_GIT_CHUNK_CONCURRENCY=${optimal.TRAJECTORY_GIT_CHUNK_CONCURRENCY}${c.reset}`,
  );

  // ---- GIT_LOG_TIMEOUT (informational) ----
  printHeader(
    "Git: Log Duration",
    "Measuring git log duration at different depths",
  );

  for (const months of GIT_TEST_VALUES.LOG_DEPTHS_MONTHS) {
    process.stdout.write(`  Testing --since="${months} months ago" `);
    const result = await measureGitLogDuration(PROJECT_PATH, months);
    if (result.error) {
      console.log(`${c.red}ERROR${c.reset} ${c.dim}${result.error}${c.reset}`);
    } else {
      console.log(
        `${c.dim}${result.durationMs}ms (${result.entries} commits)${c.reset}`,
      );
    }
  }
  console.log(
    `\n  ${c.dim}ℹ Recommended: set TRAJECTORY_GIT_LOG_TIMEOUT_MS to 2× your target depth duration${c.reset}`,
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add benchmarks/tune.mjs
git commit -m "feat(scripts): integrate git trajectory benchmarks into tune.mjs"
```

---

### Task 10: Provider abstraction — `benchmarks/lib/provider.mjs`

**Files:**

- Create: `benchmarks/lib/provider.mjs`
- Modify: `benchmarks/tune.mjs`
- Modify: `benchmarks/benchmark-embeddings.mjs`

- [ ] **Step 1: Create provider.mjs**

```javascript
// benchmarks/lib/provider.mjs
import { config } from "./config.mjs";

/**
 * Create embedding provider based on EMBEDDING_PROVIDER env var.
 * Supports: "ollama" (default), "onnx"
 *
 * @returns {Promise<Object>} Provider with embedBatch(), getDimensions(), checkHealth()
 */
export async function createEmbeddingProvider() {
  const provider = process.env.EMBEDDING_PROVIDER || "ollama";

  if (provider === "onnx") {
    const { OnnxEmbeddings } =
      await import("../build/core/adapters/embeddings/onnx.js");
    const onnx = new OnnxEmbeddings(config.EMBEDDING_MODEL);
    if ("initialize" in onnx) {
      await onnx.initialize();
    }
    return { provider: onnx, name: "onnx" };
  }

  const { OllamaEmbeddings } =
    await import("../build/core/adapters/embeddings/ollama.js");
  const ollama = new OllamaEmbeddings(
    config.EMBEDDING_MODEL,
    config.EMBEDDING_DIMENSION,
    undefined,
    config.EMBEDDING_BASE_URL,
  );
  return { provider: ollama, name: "ollama" };
}

/**
 * Check connectivity for the configured provider.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function checkProviderConnectivity() {
  const provider = process.env.EMBEDDING_PROVIDER || "ollama";

  if (provider === "onnx") {
    // ONNX is local, just check if model exists
    try {
      const { OnnxEmbeddings } =
        await import("../build/core/adapters/embeddings/onnx.js");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `ONNX not available: ${e.message}` };
    }
  }

  // Ollama: existing check
  try {
    const response = await fetch(`${config.EMBEDDING_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      return { ok: false, error: `Ollama HTTP ${response.status}` };

    const { models } = await response.json();
    const modelNames = (models || []).map((m) =>
      m.name.replace(/:latest$/, ""),
    );
    const target = config.EMBEDDING_MODEL.replace(/:latest$/, "");
    if (!modelNames.some((n) => n === target || n === config.EMBEDDING_MODEL)) {
      return {
        ok: false,
        error: `Model "${config.EMBEDDING_MODEL}" not found`,
      };
    }
    return { ok: true };
  } catch (e) {
    if (e.cause?.code === "ECONNREFUSED") {
      return {
        ok: false,
        error: `Cannot connect to Ollama at ${config.EMBEDDING_BASE_URL}`,
      };
    }
    return { ok: false, error: e.message };
  }
}
```

- [ ] **Step 2: Update tune.mjs to use provider abstraction**

Replace the `OllamaEmbeddings` import and direct instantiation with:

```javascript
import {
  checkProviderConnectivity,
  createEmbeddingProvider,
} from "./lib/provider.mjs";
```

Replace the Ollama connectivity check + `new OllamaEmbeddings(...)` block with:

```javascript
const embeddingCheck = await checkProviderConnectivity();
if (!embeddingCheck.ok) {
  console.log(`  ${c.red}✗${c.reset} ${embeddingCheck.error}`);
  process.exit(1);
}

const { provider: embeddings, name: providerName } =
  await createEmbeddingProvider();
console.log(`  ${c.green}✓${c.reset} Embedding provider: ${providerName}`);
```

- [ ] **Step 3: Update benchmark-embeddings.mjs similarly**

Replace direct `OllamaEmbeddings` import with `createEmbeddingProvider` usage.

- [ ] **Step 4: Test with Ollama**

Run: `npm run tune 2>&1 | head -30` Expected: Shows "Embedding provider:
ollama", works as before

- [ ] **Step 5: Commit**

```bash
git add benchmarks/lib/provider.mjs benchmarks/tune.mjs benchmarks/benchmark-embeddings.mjs
git commit -m "feat(scripts): abstract embedding provider for Ollama/ONNX support"
```

---

### Task 11: CLI executable — `tea-rags tune`

**Files:**

- Create: `src/cli/tune.ts`
- Modify: `package.json`

Currently benchmarks run via `node benchmarks/tune.mjs` — not available to users
who install tea-rags globally. Add a CLI entry point so `tea-rags tune` and
`npx tea-rags tune` work.

- [ ] **Step 1: Create CLI entry point**

```typescript
// src/cli/tune.ts
#!/usr/bin/env node

/**
 * CLI wrapper for the tuning benchmark.
 * Usage: tea-rags tune [--path <dir>] [--full]
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tunePath = join(__dirname, "../../benchmarks/tune.mjs");

// Forward all args after "tune" to the benchmark script
const args = process.argv.slice(2);
const child = spawn(process.execPath, [tunePath, ...args], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 1));
```

- [ ] **Step 2: Add bin entry to package.json**

Check current `bin` field in `package.json`. If it exists, add `tea-rags-tune`
entry. If `bin` points to a single file, convert to object form:

```json
{
  "bin": {
    "tea-rags": "./build/cli/main.js",
    "tea-rags-tune": "./build/cli/tune.js"
  }
}
```

Also add an npm script alias:

```json
{
  "scripts": {
    "tune": "node benchmarks/tune.mjs"
  }
}
```

(The `tune` script already exists — verify it's there.)

- [ ] **Step 3: Add subcommand routing (if main CLI exists)**

If `src/cli/main.ts` has subcommand routing, add `tune` subcommand:

```typescript
if (args[0] === "tune") {
  // Forward to tune script
  const tunePath = join(__dirname, "../../benchmarks/tune.mjs");
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [tunePath, ...args.slice(1)], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}
```

If no main CLI exists, the standalone `tea-rags-tune` binary is sufficient.

- [ ] **Step 4: Build and verify**

```bash
npm run build
node build/cli/tune.js --help  # or just runs the benchmark
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/tune.ts package.json
git commit -m "feat(cli): add tea-rags tune CLI executable"
```

---

### Task 12: End-to-end test run

**Files:** None (testing only)

- [ ] **Step 1: Run full benchmark with --path via npm**

```bash
npm run build && npm run tune -- --path /path/to/some/project
```

Expected: All phases run, output file includes new variables.

- [ ] **Step 2: Run via CLI executable**

```bash
node build/cli/tune.js --path /path/to/some/project
```

Expected: Same output as Step 1.

- [ ] **Step 3: Run without --path (fallback to cwd)**

```bash
npm run tune
```

Expected: Pipeline benchmarks run on cwd if enough files, or show skip message.

- [ ] **Step 4: Run embedding-only benchmark**

```bash
npm run benchmark-embeddings
```

Expected: Works with provider abstraction.

- [ ] **Step 5: Verify output file**

Check `tuned_environment_variables.env` contains all new variables.

- [ ] **Step 6: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(scripts): polish benchmark expansion"
```
