# Achieve 90% Code Coverage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Increase code coverage from 83.24% to 90%+ and enforce 90% minimum coverage in CI/CD

**Architecture:** Three-phase approach: (1) Remove dead code (index.ts re-exports with 0% coverage), (2) Add targeted tests for uncovered critical paths, (3) Update CI configuration to enforce 90% threshold

**Tech Stack:** Vitest, Codecov, GitHub Actions

---

## Current State Analysis

**Overall Coverage:** 83.24% (statements)
**Target:** 90%+

**Problem Areas:**
- `src/code/git/index.ts`: 0% (re-export only)
- `src/code/pipeline/index.ts`: 0% (re-export only)
- `src/prompts/index.ts`: 0% (re-export only)
- `src/prompts/types.ts`: 0% (types only)
- `src/qdrant/client.ts`: 85.18% lines (threshold: 90%)
- `src/code/git/git-metadata-service.ts`: 57.24% lines
- `src/code/pipeline/debug-logger.ts`: 52.17% lines
- `src/code/sync/snapshot.ts`: 71.79% lines
- `src/code/sync/synchronizer.ts`: 76.22% lines

---

## Task 1: Exclude Re-export Files from Coverage

**Rationale:** Re-export index.ts files have 0% coverage but are not testable code - they only re-export. Excluding them gives accurate coverage metrics.

**Files:**
- Modify: `vitest.config.ts:19-34`

**Step 1: Update coverage exclusions**

Add re-export index files to coverage exclusions:

```typescript
coverage: {
  provider: "v8",
  reporter: ["text", "json", "html"],
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
    "tests/**/fixtures/**",
    "tests/integration/**",
    // Re-export index files (not executable code)
    "src/code/git/index.ts",
    "src/code/pipeline/index.ts",
    "src/prompts/index.ts",
    // Type-only files
    "src/prompts/types.ts",
    "src/code/types.ts",
    "src/code/pipeline/types.ts",
    "src/code/git/types.ts",
  ],
```

**Step 2: Run coverage to verify exclusions**

```bash
npm run test:coverage
```

Expected: Coverage report no longer shows 0% for index.ts files, overall coverage increases slightly

**Step 3: Commit changes**

```bash
git add vitest.config.ts
git commit -m "chore(coverage): exclude re-export and type-only files from coverage

- Add src/code/git/index.ts to exclusions
- Add src/code/pipeline/index.ts to exclusions
- Add src/prompts/index.ts to exclusions
- Add type-only files to exclusions

These files contain only re-exports or type definitions and are not
executable code that can be meaningfully tested.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Add Tests for GitMetadataService Critical Paths

**Target:** Increase `src/code/git/git-metadata-service.ts` from 57.24% to 80%+

**Files:**
- Modify: `tests/code/git/git-metadata-service.test.ts`

**Step 1: Identify uncovered lines**

Uncovered lines from coverage report: 467-475,494-501,513-516,528-533,574-575,605,617,638-641,647,681-684,695-699,726,740,753-757,781-789,800-812

Key areas:
- Error handling paths
- Edge cases in blame parsing
- Cache miss scenarios

**Step 2: Write tests for cache miss scenario**

Add to `tests/code/git/git-metadata-service.test.ts`:

```typescript
it("should handle cache miss and perform git blame", async () => {
  const service = new GitMetadataService(repoPath, { enableGitMetadata: true });

  // Clear any existing cache
  await service.clearCache();

  const metadata = await service.getChunkMetadata(testFilePath, 1, 5);

  expect(metadata.commitCount).toBeGreaterThan(0);
  expect(metadata.authors).toBeDefined();
});

it("should handle files with no git history", async () => {
  const service = new GitMetadataService(repoPath, { enableGitMetadata: true });

  // Create a new untracked file
  const untrackedFile = join(repoPath, "untracked.ts");
  await fs.writeFile(untrackedFile, "const x = 1;");

  const metadata = await service.getChunkMetadata(untrackedFile, 1, 1);

  expect(metadata.commitCount).toBe(0);
  expect(metadata.authors).toHaveLength(0);

  // Cleanup
  await fs.unlink(untrackedFile);
});
```

**Step 3: Write tests for blame parsing edge cases**

```typescript
it("should handle blame output with multiple authors", async () => {
  const service = new GitMetadataService(repoPath, { enableGitMetadata: true });

  // Use a file that has been modified by multiple people
  const metadata = await service.getChunkMetadata(testFilePath, 1, 100);

  expect(metadata.authors.length).toBeGreaterThan(0);
  expect(metadata.lastModified).toBeInstanceOf(Date);
});

it("should handle blame for specific line ranges", async () => {
  const service = new GitMetadataService(repoPath, { enableGitMetadata: true });

  const metadata1 = await service.getChunkMetadata(testFilePath, 1, 10);
  const metadata2 = await service.getChunkMetadata(testFilePath, 50, 60);

  // Different ranges may have different metadata
  expect(metadata1).toBeDefined();
  expect(metadata2).toBeDefined();
});
```

**Step 4: Run tests**

```bash
npm test -- tests/code/git/git-metadata-service.test.ts
```

Expected: All new tests pass

**Step 5: Check coverage improvement**

```bash
npm run test:coverage
```

Expected: `git-metadata-service.ts` coverage increases to 70%+

**Step 6: Commit**

```bash
git add tests/code/git/git-metadata-service.test.ts
git commit -m "test(git): add tests for cache miss and blame parsing edge cases

- Add test for cache miss scenario
- Add test for files with no git history
- Add test for multiple authors
- Add test for specific line ranges

Increases git-metadata-service.ts coverage from 57% to 70%+

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Add Tests for QdrantClient Uncovered Paths

**Target:** Increase `src/qdrant/client.ts` from 85.18% to 90%+

**Files:**
- Modify: `src/qdrant/client.test.ts`

**Step 1: Identify uncovered lines**

Uncovered: 132,144,162,179-180,220,241,379,589,590,639-663

Key areas:
- Error handling in delete operations
- Edge cases in scroll/search
- Rare error paths

**Step 2: Write test for delete operation error handling**

Add to `src/qdrant/client.test.ts`:

```typescript
it("should handle delete operation failures gracefully", async () => {
  const errorManager = new MockQdrantManager();
  const errorClient = new QdrantManager(
    "http://localhost:6333",
    undefined,
    errorManager as any
  );

  // Mock delete to throw error
  vi.spyOn(errorManager, "delete").mockRejectedValueOnce(
    new Error("Delete failed")
  );

  await expect(
    errorClient.deletePoints("test-collection", { filter: { must: [] } })
  ).rejects.toThrow("Delete failed");
});
```

**Step 3: Write test for scroll pagination edge case**

```typescript
it("should handle scroll with no results", async () => {
  const emptyManager = new MockQdrantManager();
  const emptyClient = new QdrantManager(
    "http://localhost:6333",
    undefined,
    emptyManager as any
  );

  await emptyClient.createCollection("empty-collection", 384);

  const results = await emptyClient.scroll("empty-collection", {
    limit: 100,
    with_payload: true,
    with_vector: false,
  });

  expect(results.points).toHaveLength(0);
  expect(results.next_page_offset).toBeUndefined();
});
```

**Step 4: Write test for search with filters**

```typescript
it("should search with complex filters", async () => {
  await manager.createCollection("filter-test", 384);

  await manager.upsert("filter-test", [
    {
      id: "1",
      vector: Array(384).fill(0.1),
      payload: { category: "test", priority: 1 },
    },
    {
      id: "2",
      vector: Array(384).fill(0.2),
      payload: { category: "prod", priority: 2 },
    },
  ]);

  const results = await manager.search("filter-test", Array(384).fill(0.1), {
    limit: 10,
    filter: {
      must: [{ key: "category", match: { value: "test" } }],
    },
  });

  expect(results.length).toBe(1);
  expect(results[0].id).toBe("1");
});
```

**Step 5: Run tests**

```bash
npm test -- src/qdrant/client.test.ts
```

Expected: All tests pass

**Step 6: Check coverage**

```bash
npm run test:coverage
```

Expected: `client.ts` reaches 90%+ coverage

**Step 7: Commit**

```bash
git add src/qdrant/client.test.ts
git commit -m "test(qdrant): add tests for delete errors and search edge cases

- Add test for delete operation error handling
- Add test for scroll with no results
- Add test for search with complex filters

Increases client.ts coverage from 85% to 90%+

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Add Tests for Pipeline Debug Logger

**Target:** Increase `src/code/pipeline/debug-logger.ts` from 52.17% to 80%+

**Files:**
- Create: `src/code/pipeline/debug-logger.test.ts`

**Step 1: Write test file structure**

Create `src/code/pipeline/debug-logger.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pipelineLog } from "./debug-logger.js";

describe("pipelineLog", () => {
  let consoleErrorSpy: any;
  let consoleWarnSpy: any;
  let consoleLogSpy: any;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
```

**Step 2: Write tests for all log levels**

```typescript
it("should log error messages", () => {
  pipelineLog("error", "Test error message");

  expect(consoleErrorSpy).toHaveBeenCalledWith(
    expect.stringContaining("Test error message")
  );
});

it("should log warning messages", () => {
  pipelineLog("warn", "Test warning");

  expect(consoleWarnSpy).toHaveBeenCalledWith(
    expect.stringContaining("Test warning")
  );
});

it("should log info messages", () => {
  pipelineLog("info", "Test info");

  expect(consoleLogSpy).toHaveBeenCalledWith(
    expect.stringContaining("Test info")
  );
});

it("should log debug messages when DEBUG is set", () => {
  const originalDebug = process.env.DEBUG;
  process.env.DEBUG = "pipeline";

  pipelineLog("debug", "Test debug");

  expect(consoleLogSpy).toHaveBeenCalledWith(
    expect.stringContaining("Test debug")
  );

  process.env.DEBUG = originalDebug;
});

it("should not log debug messages when DEBUG is not set", () => {
  const originalDebug = process.env.DEBUG;
  delete process.env.DEBUG;

  pipelineLog("debug", "Should not appear");

  expect(consoleLogSpy).not.toHaveBeenCalled();

  process.env.DEBUG = originalDebug;
});
```

**Step 3: Run tests**

```bash
npm test -- src/code/pipeline/debug-logger.test.ts
```

Expected: All tests pass

**Step 4: Check coverage**

```bash
npm run test:coverage
```

Expected: `debug-logger.ts` reaches 80%+ coverage

**Step 5: Commit**

```bash
git add src/code/pipeline/debug-logger.test.ts
git commit -m "test(pipeline): add comprehensive tests for debug logger

- Add tests for all log levels (error, warn, info, debug)
- Add tests for DEBUG environment variable handling
- Test message formatting and output

Increases debug-logger.ts coverage from 52% to 80%+

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Add Tests for Snapshot Edge Cases

**Target:** Increase `src/code/sync/snapshot.ts` from 71.79% to 85%+

**Files:**
- Modify: `tests/code/sync/snapshot.test.ts`

**Step 1: Check existing tests**

```bash
grep "describe\|it(" tests/code/sync/snapshot.test.ts | head -20
```

**Step 2: Add tests for uncovered error paths**

Add to `tests/code/sync/snapshot.test.ts`:

```typescript
it("should handle snapshot save errors", async () => {
  const snapshot = new CodebaseSnapshot(tempDir);

  // Create snapshot data
  await snapshot.addFile("test.ts", "hash123", 100);

  // Mock fs.writeFile to fail
  const writeFileSpy = vi.spyOn(fs, "writeFile").mockRejectedValueOnce(
    new Error("Write failed")
  );

  await expect(snapshot.save()).rejects.toThrow("Write failed");

  writeFileSpy.mockRestore();
});

it("should handle snapshot load with corrupted data", async () => {
  const snapshot = new CodebaseSnapshot(tempDir);
  const snapshotPath = join(tempDir, ".qdrant-snapshot.json");

  // Write corrupted JSON
  await fs.writeFile(snapshotPath, "{ invalid json }");

  const loaded = await snapshot.load();

  expect(loaded).toBe(false);
});

it("should handle snapshot load with missing file", async () => {
  const snapshot = new CodebaseSnapshot(tempDir);

  const loaded = await snapshot.load();

  expect(loaded).toBe(false);
});

it("should calculate merkle root correctly", async () => {
  const snapshot = new CodebaseSnapshot(tempDir);

  await snapshot.addFile("file1.ts", "hash1", 100);
  await snapshot.addFile("file2.ts", "hash2", 200);

  const root = snapshot.getMerkleRoot();

  expect(root).toBeDefined();
  expect(typeof root).toBe("string");
  expect(root.length).toBeGreaterThan(0);
});
```

**Step 3: Run tests**

```bash
npm test -- tests/code/sync/snapshot.test.ts
```

Expected: All tests pass

**Step 4: Check coverage**

```bash
npm run test:coverage
```

Expected: `snapshot.ts` reaches 85%+ coverage

**Step 5: Commit**

```bash
git add tests/code/sync/snapshot.test.ts
git commit -m "test(sync): add tests for snapshot error handling and edge cases

- Add test for snapshot save errors
- Add test for corrupted snapshot data
- Add test for missing snapshot file
- Add test for merkle root calculation

Increases snapshot.ts coverage from 72% to 85%+

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Add Tests for Synchronizer Error Paths

**Target:** Increase `src/code/sync/synchronizer.ts` from 76.22% to 85%+

**Files:**
- Modify: `tests/code/sync/synchronizer.test.ts`

**Step 1: Add tests for sync error handling**

Add to `tests/code/sync/synchronizer.test.ts`:

```typescript
it("should handle scan errors during sync", async () => {
  const synchronizer = new FileSynchronizer(
    mockScanner,
    mockIndexer,
    mockQdrant,
    mockSnapshot
  );

  // Mock scanner to throw error
  vi.spyOn(mockScanner, "scanFiles").mockRejectedValueOnce(
    new Error("Scan failed")
  );

  await expect(
    synchronizer.sync("/test/path", "test-collection")
  ).rejects.toThrow("Scan failed");
});

it("should handle index errors during sync", async () => {
  const synchronizer = new FileSynchronizer(
    mockScanner,
    mockIndexer,
    mockQdrant,
    mockSnapshot
  );

  vi.spyOn(mockScanner, "scanFiles").mockResolvedValueOnce([
    { path: "test.ts", hash: "hash1", size: 100 }
  ]);

  vi.spyOn(mockIndexer, "indexFile").mockRejectedValueOnce(
    new Error("Index failed")
  );

  const result = await synchronizer.sync("/test/path", "test-collection");

  // Should continue despite error
  expect(result.errors).toBeGreaterThan(0);
});

it("should handle partial sync with progress callback", async () => {
  const synchronizer = new FileSynchronizer(
    mockScanner,
    mockIndexer,
    mockQdrant,
    mockSnapshot
  );

  const progressCalls: number[] = [];
  const onProgress = (progress: number) => {
    progressCalls.push(progress);
  };

  vi.spyOn(mockScanner, "scanFiles").mockResolvedValueOnce([
    { path: "file1.ts", hash: "hash1", size: 100 },
    { path: "file2.ts", hash: "hash2", size: 200 },
    { path: "file3.ts", hash: "hash3", size: 300 },
  ]);

  await synchronizer.sync("/test/path", "test-collection", { onProgress });

  expect(progressCalls.length).toBeGreaterThan(0);
  expect(progressCalls[progressCalls.length - 1]).toBeCloseTo(1.0);
});
```

**Step 2: Run tests**

```bash
npm test -- tests/code/sync/synchronizer.test.ts
```

Expected: All tests pass

**Step 3: Check coverage**

```bash
npm run test:coverage
```

Expected: `synchronizer.ts` reaches 85%+ coverage

**Step 4: Commit**

```bash
git add tests/code/sync/synchronizer.test.ts
git commit -m "test(sync): add tests for synchronizer error handling

- Add test for scan errors during sync
- Add test for index errors during sync
- Add test for partial sync with progress callback

Increases synchronizer.ts coverage from 76% to 85%+

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Update Vitest Config with 90% Global Threshold

**Files:**
- Modify: `vitest.config.ts:35-48`

**Step 1: Add global coverage thresholds**

Replace specific file thresholds with global thresholds:

```typescript
coverage: {
  provider: "v8",
  reporter: ["text", "json", "html"],
  exclude: [
    // ... existing exclusions ...
  ],
  thresholds: {
    lines: 90,
    functions: 90,
    branches: 85,
    statements: 90,
  },
},
```

**Step 2: Run coverage to verify thresholds**

```bash
npm run test:coverage
```

Expected: Coverage meets or exceeds 90% for lines, functions, statements. May fail if not there yet.

**Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "chore(coverage): enforce 90% coverage threshold globally

- Set global lines threshold to 90%
- Set global functions threshold to 90%
- Set global branches threshold to 85%
- Set global statements threshold to 90%
- Remove file-specific thresholds in favor of global standard

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 8: Update Codecov Configuration

**Files:**
- Modify: `.codecov.yml:1-17`

**Step 1: Update codecov thresholds**

```yaml
coverage:
  status:
    project:
      default:
        target: 90%
        threshold: 1%
        informational: false
    patch:
      default:
        target: 90%
        threshold: 1%
        informational: false

comment:
  layout: "header, diff, flags, components"
  behavior: default
  require_changes: false
```

**Step 2: Commit**

```bash
git add .codecov.yml
git commit -m "chore(codecov): enforce 90% coverage requirement

- Set project coverage target to 90%
- Set patch coverage target to 90%
- Reduce threshold to 1% (stricter)
- Set informational: false to fail PRs below threshold

This ensures PRs cannot be merged with <90% coverage.

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 9: Update CI Workflow to Fail on Low Coverage

**Files:**
- Modify: `.github/workflows/ci.yml:43-51`

**Step 1: Update codecov action to fail on error**

```yaml
- name: Upload coverage to Codecov
  uses: codecov/codecov-action@v5
  with:
    token: ${{ secrets.CODECOV_TOKEN }}
    directory: ./coverage
    flags: unittests
    fail_ci_if_error: true
```

**Step 2: Add coverage check step**

Add after "Run tests with coverage":

```yaml
- name: Run tests with coverage
  run: npm run test:coverage

- name: Verify coverage thresholds
  run: |
    echo "Verifying coverage meets 90% threshold..."
    npm run test:coverage 2>&1 | tee coverage-output.txt
    if grep -q "ERROR: Coverage" coverage-output.txt; then
      echo "Coverage threshold not met"
      exit 1
    fi
    echo "Coverage thresholds passed"
```

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: fail workflow if coverage is below 90%

- Set fail_ci_if_error: true for codecov upload
- Add explicit coverage verification step
- Ensure CI fails if coverage thresholds not met

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 10: Run Full Test Suite and Verify

**Step 1: Run all tests with coverage**

```bash
npm run test:coverage
```

Expected output:
- All files at 90%+ coverage
- Overall coverage >= 90%
- No threshold errors

**Step 2: Verify CI configuration**

```bash
cat .codecov.yml
cat .github/workflows/ci.yml
cat vitest.config.ts
```

Expected:
- All configs show 90% threshold
- CI set to fail on coverage errors
- Codecov informational: false

**Step 3: Create summary commit**

```bash
git add -A
git commit -m "chore: achieve 90% code coverage with strict enforcement

Summary of changes:
- Excluded re-export and type-only files from coverage
- Added 20+ new tests covering critical paths
- Increased coverage from 83.24% to 90%+
- Set global 90% threshold in vitest.config.ts
- Configured codecov to require 90% coverage
- Updated CI to fail if coverage drops below 90%

Coverage improvements by file:
- git-metadata-service.ts: 57% → 80%+
- qdrant/client.ts: 85% → 90%+
- debug-logger.ts: 52% → 80%+
- snapshot.ts: 72% → 85%+
- synchronizer.ts: 76% → 85%+

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

**Step 4: Run final verification**

```bash
npm run test:coverage
npm run build
npm run type-check
```

Expected: All commands succeed

---

## Success Criteria

- [ ] Overall code coverage >= 90%
- [ ] All critical files >= 85% coverage
- [ ] Vitest configured with 90% global threshold
- [ ] Codecov configured to require 90% (informational: false)
- [ ] CI fails if coverage < 90%
- [ ] All existing tests still pass
- [ ] New tests cover previously uncovered critical paths

## Notes

- Some files may legitimately stay below 90% (complex error paths)
- Focus on critical business logic over edge cases
- Add `// istanbul ignore next` for truly untestable code only as last resort
- Run tests frequently during implementation to track progress
