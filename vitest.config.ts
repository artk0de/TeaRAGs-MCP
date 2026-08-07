import { defineConfig } from "vitest/config";

const isCI = !!process.env.CI;
const coverageRun = process.argv.some((arg) => arg.includes("coverage"));
// Retry is the one concession that stays environment-gated: it hides a genuinely
// flaky product path, so a dev running `npx vitest` should see the first failure.
// The pre-commit hook and CI both run with --coverage, and v8 instrumentation
// slows worker spawn (ChunkerPool, enrichment pool, codegraph factory) and
// fs.watch delivery (collection-registry) on top of everything below.
const resilient = isCI || coverageRun;

/**
 * Wall-clock budget per test and per hook (bd tea-rags-mcp-lzks3).
 *
 * These were vitest's defaults (5s test / 10s hook) for a plain `npx vitest run`
 * and only widened under CI/coverage. That gate was wrong: what stretches a test
 * here is not the runner, it is THIS SUITE's own fan-out, which is identical in
 * every invocation. vitest fans out to one file-worker per core on the premise
 * that a test file occupies one runnable process; ~160 tests in this suite break
 * that premise — they spend their time waiting on OS processes the suite spawns
 * itself (child_process.fork'ed chunker/blame/walk workers, each dlopening
 * tree-sitter, plus real `git`). Measured on a 12-core machine: 12 file-workers
 * + up to 20 forked workers + up to 10 concurrent `git`, load average 28-40.
 *
 * Measured cost of that contention, same tests serial vs in the full run:
 * median 2.7x, p90 5.5x, p99 9.5x, max 9.6x. The most expensive test costs
 * 3.2s with no contention, so the budget has to clear 3.2s x 9.6 = 31s. At the
 * old 5s a third of the real-process tests were already over budget on a GREEN
 * run (client-catfile: 1.0s serial, 7.0s in-suite) and survived only because
 * execFileSync blocks the event loop, which keeps vitest's timer from firing.
 * Whichever test lost the scheduler's coin flip failed, so the failing set
 * differed every run and every one of them passed in isolation.
 *
 * 30s is not a hang budget being relaxed — a hang is unbounded and still trips
 * it. It is the smallest budget the measured stretch admits, and it is the
 * figure the suite already used in ~15 hand-written per-test overrides.
 */
const WALL_CLOCK_BUDGET_MS = 30_000;

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // One budget for every invocation — see WALL_CLOCK_BUDGET_MS above. hookTimeout
    // was never set at all, so real-git fixture setups ran against vitest's 10s
    // default even on CI; that is what timed out blame-cache's beforeAll while its
    // per-test `}, 30000)` overrides looked like they had the file covered.
    testTimeout: WALL_CLOCK_BUDGET_MS,
    hookTimeout: WALL_CLOCK_BUDGET_MS,
    ...(resilient && { retry: 2 }),
    // Local: use all CPU cores for faster runs
    ...(!isCI && { pool: "forks" }),
    // Give worker_threads (ChunkerPool) time to terminate before fork exits
    teardownTimeout: resilient ? 10_000 : 5_000,
    // Detect hanging async operations (timers, promises, connections)
    reporters: isCI ? ["default", "hanging-process"] : ["default"],
    // Setup file mocks tree-sitter native modules to prevent crashes
    setupFiles: ["./tests/vitest.setup.ts"],
    // Tripwire: fail the run if any test moved the real worktree's git HEAD
    // (real-git fixtures committing against a broken cwd). See the file header.
    globalSetup: ["./tests/worktree-head-guard.ts"],
    exclude: [
      "**/node_modules/**",
      "**/build/**",
      "**/dist/**",
      "**/.worktrees/**",
      "**/.claude/worktrees/**",
      // Exclude integration tests - they require real external services
      "**/tests/integration/**",
      "**/__integration__/**",
      // Exclude website tests — require website/node_modules (@docusaurus/tsconfig)
      "**/tests/website/**",
      // Exclude legacy integration test files
      "test-*.mjs",
      "test-*.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: isCI ? ["json", "lcov"] : ["text", "json", "lcov", "html"],
      exclude: [
        "node_modules/",
        "build/",
        "dist/",
        "**/*.test.ts",
        "**/*.spec.ts",
        "vitest.config.ts",
        "commitlint.config.js",
        "src/index.ts",
        "scripts/**",
        "tests/**/__fixtures__/**",
        "tests/integration/**",
        // Re-export files (no executable code to test)
        "src/core/domains/ingest/pipeline/index.ts",
        "src/core/adapters/qdrant/filters/index.ts",
        "src/mcp/prompts/index.ts",
        "src/core/adapters/duckdb/daemon/index.ts",
        "src/core/infra/graph/index.ts",
        // I/O-heavy runtime (child process spawn, HTTP download — tested via integration)
        "src/core/adapters/qdrant/embedded/daemon.ts",
        "src/core/adapters/qdrant/embedded/download.ts",
        "src/core/adapters/qdrant/embedded/types.ts",
        // Codegraph daemon process entrypoint (unix-socket server + spawn-on-demand
        // runtime; same I/O-heavy category as the qdrant daemon above — validated by
        // build + full suite, exercised end-to-end via integration, not unit-covered).
        "src/core/adapters/duckdb/daemon/entry.ts",
        // Enrichment worker thread entry (Phase 2 unified-enrichment-worker-pool):
        // worker_threads runtime that dynamic-imports trajectory provider factories
        // in-thread. Covered by `tests/core/domains/ingest/pipeline/enrichment/infra/
        // worker.test.ts` via real worker spawn against fixture provider modules —
        // the spawned worker process is not visible to the in-process coverage
        // collector (same category as chunker/infra/worker.ts and daemon/entry.ts).
        "src/core/domains/ingest/pipeline/enrichment/infra/worker.ts",
        // Abstract-only error base classes (no logic, just class declaration)
        "src/core/adapters/errors.ts",
        "src/core/adapters/embeddings/errors.ts",
        // Error re-export files (no logic, just re-export from parent)
        "src/core/domains/trajectory/git/errors.ts",
        "src/core/domains/trajectory/static/errors.ts",
        // Type-only + re-export (no executable logic)
        "src/core/domains/explore/strategies/types.ts",
        // Barrel re-exports (no executable logic)
        "src/core/api/index.ts",
        "src/core/domains/explore/strategies/index.ts",
        "src/core/domains/ingest/pipeline/index.ts",
        "src/core/domains/trajectory/index.ts",
        "src/bootstrap/config/index.ts",
        "src/mcp/resources/index.ts",
        // Deprecated re-export (backward compat shim)
        "src/core/domains/ingest/pipeline/infra/runtime.ts",
        // Type-only files (no executable code to test)
        "src/core/types.ts",
        "src/core/domains/ingest/pipeline/enrichment/types.ts",
        "src/core/domains/ingest/pipeline/enrichment/trajectory/git/types.ts",
        "src/core/domains/ingest/pipeline/types.ts",
        "src/core/domains/ingest/pipeline/chunker/hooks/types.ts",
        // Barrel re-exports (no logic, just re-export)
        "src/core/domains/ingest/pipeline/chunker/hooks/*/index.ts",
        // ALL barrel files (pure re-export glue, no executable logic). Broad
        // glob supersedes the individual index.ts entries above — per the
        // barrel-files.md convention every domain-boundary index.ts is a
        // re-export surface, not testable code.
        "**/index.ts",
        // Declarative language-definition config — LANGUAGE_DEFINITIONS is data
        // with lazy `() => import("tree-sitter-x")` thunks, not branching logic.
        "src/core/domains/ingest/pipeline/chunker/config.ts",
        // Codegraph DuckDB daemon — unix-socket server/client + process
        // lifecycle (I/O-heavy, same category as the qdrant daemon; validated
        // end-to-end via build + integration, not unit-covered). Supersedes the
        // individual daemon/index.ts + daemon/entry.ts entries above.
        "src/core/adapters/duckdb/daemon/**",
        // I/O-heavy bootstrap (DI wiring, path resolution, transport — tested via integration)
        "src/bootstrap/transport/**",
        "src/bootstrap/factory.ts",
        "src/bootstrap/paths.ts",
        // MCP tool handlers and infra (I/O glue — tested via integration)
        "src/mcp/tools/**",
        "src/mcp/format.ts",
        "src/mcp/register.ts",
        "src/mcp/prompts/register.ts",
        // CLI entrypoint (I/O, like src/index.ts)
        "src/cli/index.ts",
        // Test utilities (not production code)
        "tests/**/test-helpers.ts",
        // Test helper directories — mocks/fakes/fixtures for tests, not
        // production code (e.g. tests/core/__helpers__/codegraph-pool.ts, the
        // in-memory codegraph pool fake from the DuckDB-daemon slice). These
        // leak into the coverage denominator otherwise; excluding them matches
        // the test-helpers.ts exclusion above.
        "tests/**/__helpers__/**",
      ],
      thresholds: {
        // Global thresholds
        lines: 97,
        functions: 97,
        branches: 87,
        // statements lowered from 96.9 → 96.2 by explicit user override:
        // codegraph slice added many defensive null-guards in walker/provider
        // for partial-parse AST shapes (tree-sitter ERROR nodes) that valid
        // OSS fixtures don't trigger. Restore to 96.9 once integration tests
        // with malformed-input fixtures land (follow-up bead).
        statements: 96.2,
        // File-specific thresholds
        "src/core/adapters/qdrant/client.ts": {
          lines: 90,
          functions: 100,
          branches: 80,
          statements: 90,
        },
        "src/core/adapters/embeddings/openai.ts": {
          lines: 100,
          functions: 100,
          branches: 90,
          statements: 100,
        },
      },
    },
  },
});
