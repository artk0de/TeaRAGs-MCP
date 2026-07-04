# Trajectory Enrichment Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Decompose god objects (`git-log-reader` 1122 lines,
`git-metadata-service` 776 lines) into clean `EnrichmentProvider` interface +
generic coordinator + git as first concrete implementation.

**Architecture:** Three-layer separation — `adapters/git/` (basic git
operations), `trajectory/enrichment/` (generic framework + interface),
`trajectory/enrichment/git/` (git enrichment implementation). Payload structure
uses `{provider.key}.{file|chunk}.{metric}` nesting for level-based filtering.

**Design doc:** `docs/plans/2026-02-24-trajectory-enrichment-redesign.md`

---

## Task 1: Delete `git-metadata-service.ts` + deprecated types

Deprecated blame-per-file algorithm. Removing dead code first simplifies the
rest.

**Files:**

- Delete: `src/core/ingest/trajectory/git/git-metadata-service.ts` (776 lines)
- Delete: `tests/code/git/git-metadata-service.test.ts` (671 lines)
- Modify: `src/core/ingest/trajectory/git/types.ts` — remove deprecated types
- Modify: `src/core/ingest/trajectory/git/index.ts` — remove re-exports if any

**Step 1: Verify no live imports of git-metadata-service**

```bash
npx rg "git-metadata-service" --type ts -l
```

Expected: only the file itself, its test, and possibly `index.ts`. No production
consumers.

**Step 2: Delete files**

```bash
rm src/core/ingest/trajectory/git/git-metadata-service.ts
rm tests/code/git/git-metadata-service.test.ts
```

**Step 3: Remove deprecated types from `types.ts`**

Remove these interfaces from `src/core/ingest/trajectory/git/types.ts`:

- `GitChunkMetadata` (lines 110-120)
- `BlameLineData` (lines 125-131)
- `BlameCache` (lines 136-140)
- `BlameCacheFile` (lines 145-150)
- `GitMetadataOptions` (lines 163-168)

Keep: `CommitInfo`, `FileChurnData`, `GitFileMetadata`, `ChunkChurnOverlay`,
`GitRepoInfo`

**Step 4: Run tests**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: all tests pass (minus the 44 deleted tests)

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete deprecated git-metadata-service and blame types"
```

---

## Task 2: Create `EnrichmentProvider` interface + `enrichment/utils.ts`

**Files:**

- Create: `src/core/ingest/trajectory/enrichment/types.ts`
- Create: `src/core/ingest/trajectory/enrichment/utils.ts`
- Modify: `src/core/ingest/trajectory/git/git-log-reader.ts` — re-export
  `extractTaskIds` from utils

**Step 1: Write test for extractTaskIds in new location**

Create `tests/code/enrichment/utils.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { extractTaskIds } from "../../../src/core/ingest/trajectory/enrichment/utils.js";

describe("extractTaskIds", () => {
  it("extracts JIRA-style IDs", () => {
    expect(extractTaskIds("fix: resolve TD-1234 issue")).toEqual(["TD-1234"]);
  });

  it("extracts GitHub-style IDs", () => {
    expect(extractTaskIds("closes #123")).toEqual(["#123"]);
  });

  it("extracts Azure DevOps IDs", () => {
    expect(extractTaskIds("AB#456 done")).toEqual(["AB#456"]);
  });

  it("extracts GitLab MR IDs", () => {
    expect(extractTaskIds("merged !789")).toEqual(["!789"]);
  });

  it("returns empty for empty input", () => {
    expect(extractTaskIds("")).toEqual([]);
  });

  it("extracts multiple IDs", () => {
    const result = extractTaskIds("TD-1 #2 AB#3 !4");
    expect(result).toContain("TD-1");
    expect(result).toContain("#2");
    expect(result).toContain("AB#3");
    expect(result).toContain("!4");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/code/enrichment/utils.test.ts
```

Expected: FAIL — module not found

**Step 3: Create `enrichment/types.ts` — EnrichmentProvider interface**

```typescript
// src/core/ingest/trajectory/enrichment/types.ts

import type { ChunkLookupEntry } from "../../../types.js";

/**
 * EnrichmentProvider — interface for trajectory enrichment providers.
 *
 * Each provider computes metadata at two levels:
 * - file-level: prefetched at T=0, applied as chunks arrive
 * - chunk-level: computed post-flush, applied as overlays
 *
 * Payload is written to Qdrant as { [key].file.{metric} } and { [key].chunk.{metric} }.
 */
export interface EnrichmentProvider {
  /** Namespace key for Qdrant payload: { [key].file: ..., [key].chunk: ... } */
  readonly key: string; // "git", "codegraph", "complexity"

  /** File-level enrichment (prefetch at T=0, or backfill for specific paths) */
  buildFileMetadata(
    root: string,
    options?: { paths?: string[] },
  ): Promise<Map<string, Record<string, unknown>>>;

  /** Chunk-level enrichment (post-flush) */
  buildChunkMetadata(
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): Promise<Map<string, Map<string, Record<string, unknown>>>>;
}
```

**Step 4: Create `enrichment/utils.ts` — extractTaskIds**

Move `extractTaskIds` from `git-log-reader.ts` (lines 48-79) to new file:

```typescript
// src/core/ingest/trajectory/enrichment/utils.ts

/**
 * Extract task IDs from commit message text.
 * Supports JIRA (TD-1234), GitHub (#123), Azure DevOps (AB#123), GitLab (!123).
 *
 * Provider-agnostic — works with any VCS commit message format.
 */
export function extractTaskIds(text: string): string[] {
  if (!text) return [];

  const taskIds = new Set<string>();

  // JIRA/Linear style: ABC-123
  const jiraPattern = /\b([A-Z]{2,10}-\d{1,6})\b/g;
  let match;
  while ((match = jiraPattern.exec(text)) !== null) {
    taskIds.add(match[1]);
  }

  // GitHub style: #123 (not preceded by &)
  const githubPattern = /(?:^|[^&])#(\d{1,7})\b/g;
  while ((match = githubPattern.exec(text)) !== null) {
    taskIds.add(`#${match[1]}`);
  }

  // Azure DevOps: AB#123
  const azurePattern = /\bAB#(\d{1,7})\b/g;
  while ((match = azurePattern.exec(text)) !== null) {
    taskIds.add(`AB#${match[1]}`);
  }

  // GitLab MR: !123
  const gitlabPattern = /!(\d{1,7})\b/g;
  while ((match = gitlabPattern.exec(text)) !== null) {
    taskIds.add(`!${match[1]}`);
  }

  return Array.from(taskIds);
}
```

**Step 5: Update git-log-reader.ts to re-export from utils**

Replace the `extractTaskIds` function in `git-log-reader.ts` (lines 48-79) with:

```typescript
// Re-export from enrichment utils (canonical location)
export { extractTaskIds } from "../enrichment/utils.js";
```

Keep the `computeFileMetadata` function referencing the re-exported
`extractTaskIds`.

**Step 6: Run all tests**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL tests pass (existing tests use `extractTaskIds` from
`git-log-reader.js` via re-export)

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: create EnrichmentProvider interface and extract extractTaskIds to utils"
```

---

## Task 3: Extract pure metrics → `enrichment/git/metrics.ts`

Module-level pure functions that compute git-specific metrics.

**Files:**

- Create: `src/core/ingest/trajectory/enrichment/git/metrics.ts`
- Modify: `src/core/ingest/trajectory/git/git-log-reader.ts` — re-export from
  new location

**Step 1: Create `enrichment/git/metrics.ts`**

Move from `git-log-reader.ts`:

- `isBugFixCommit` (lines 30-34) — stays non-exported (internal to git
  enrichment)
- `overlaps` (lines 40-42) — exported
- `computeFileMetadata` (lines 84-196) — exported

```typescript
// src/core/ingest/trajectory/enrichment/git/metrics.ts

import type { FileChurnData, GitFileMetadata } from "../../git/types.js";
import { extractTaskIds } from "../utils.js";

const BUG_FIX_PATTERN = /\b(fix|bug|hotfix|patch|resolve[sd]?|defect)\b/i;
const MERGE_SUBJECT = /^Merge\b/i;

/**
 * Check if a commit is a bug fix based on its message.
 * Skips merge commits.
 */
export function isBugFixCommit(body: string): boolean {
  const subject = body.split("\n")[0];
  if (MERGE_SUBJECT.test(subject)) return false;
  return BUG_FIX_PATTERN.test(body);
}

/**
 * Check if a hunk range overlaps with a chunk range.
 * Both ranges are inclusive: [start, end].
 */
export function overlaps(
  hunkStart: number,
  hunkEnd: number,
  chunkStart: number,
  chunkEnd: number,
): boolean {
  return hunkStart <= chunkEnd && hunkEnd >= chunkStart;
}

/**
 * Compute churn metrics for a single file from its commit history.
 */
export function computeFileMetadata(
  churnData: FileChurnData,
  currentLineCount: number,
): GitFileMetadata {
  // ... exact copy of lines 84-196 from git-log-reader.ts
  // (full function body — too long to repeat in plan, copy verbatim)
}
```

Note: copy the FULL `computeFileMetadata` body from `git-log-reader.ts:84-196`.
Update it to import `extractTaskIds` from `../utils.js` instead of local
reference.

**Step 2: Update `git-log-reader.ts` — replace functions with re-exports**

Remove the function bodies for `isBugFixCommit`, `overlaps`,
`computeFileMetadata` (lines 21-196) and replace with:

```typescript
// Re-exports from canonical locations
export { extractTaskIds } from "../enrichment/utils.js";
export {
  computeFileMetadata,
  isBugFixCommit,
  overlaps,
} from "../enrichment/git/metrics.js";
```

Keep `MAX_FILE_LINES_DEFAULT` constant (used by `_buildChunkChurnMapUncached`).

**Step 3: Run all tests**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL tests pass — consumers import from `git-log-reader.js` which
re-exports.

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: extract pure metrics to enrichment/git/metrics.ts"
```

---

## Task 4: Create `adapters/git/` — basic git operations layer

Extract low-level git primitives that are NOT enrichment-specific.

**Files:**

- Create: `src/core/adapters/git/types.ts`
- Create: `src/core/adapters/git/parsers.ts`
- Create: `src/core/adapters/git/client.ts`
- Modify: `src/core/ingest/trajectory/git/git-log-reader.ts` — import from
  adapters

**Step 1: Create `adapters/git/types.ts`**

```typescript
// src/core/adapters/git/types.ts

/**
 * Basic git data types used across the application.
 */

/** Raw numstat entry from `git log --numstat` */
export interface RawNumstatEntry {
  added: number;
  deleted: number;
  filePath: string;
}
```

Note: `CommitInfo` stays in `trajectory/git/types.ts` — it's enrichment-specific
(contains `body` for task ID extraction). The adapter layer only needs raw
numstat data.

**Step 2: Create `adapters/git/parsers.ts`**

Extract from `git-log-reader.ts`:

- `parseNumstatOutput` (lines 521-573) — pure function, parses CLI output
- `parsePathspecOutput` (lines 754-799) — pure function, parses CLI output

These are private methods on `GitLogReader` but have no `this` dependencies.
Extract as standalone functions.

```typescript
// src/core/adapters/git/parsers.ts

import type {
  CommitInfo,
  FileChurnData,
} from "../../ingest/trajectory/git/types.js";

/**
 * Parse `git log --numstat --format=%x00...` output into FileChurnData map.
 */
export function parseNumstatOutput(stdout: string): Map<string, FileChurnData> {
  // ... exact copy of lines 521-573 from git-log-reader.ts
}

/**
 * Parse `git log --numstat --format=%x00...` output with pathspec filtering.
 * Returns commit + changed files pairs.
 */
export function parsePathspecOutput(
  stdout: string,
): { commit: CommitInfo; changedFiles: string[] }[] {
  // ... exact copy of lines 754-799 from git-log-reader.ts
}
```

**Step 3: Create `adapters/git/client.ts`**

Extract basic git operations:

- `execFileAsync` (promisified `execFile`)
- `getHead` (lines 280-287) — resolve HEAD SHA
- `resolveRepoRoot` (from `enrichment-module.ts:296-305`) — find git root
- `withTimeout` (lines 261-277) — generic utility, but used only by git code
- `buildCliArgs` (lines 293-299) — build `git log` args
- isomorphic-git wrappers: `buildViaIsomorphicGit` (309-367), `listAllFiles`
  (372-391), `diffTrees` (396-423), `enrichLineStats` (429-463),
  `readBlobAsString` (579-592)

```typescript
// src/core/adapters/git/client.ts

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";

import git from "isomorphic-git";

import type {
  CommitInfo,
  FileChurnData,
} from "../../ingest/trajectory/git/types.js";

const execFileAsync = promisify(execFile);

/** Shared isomorphic-git pack cache */
const isoGitCache: Record<string, unknown> = {};

/** Resolve HEAD SHA via isomorphic-git, fallback to CLI */
export async function getHead(repoRoot: string): Promise<string> {
  // ... lines 280-287
}

/** Resolve git repo root from a path */
export function resolveRepoRoot(absolutePath: string): string {
  // ... from enrichment-module.ts:296-305
}

/** Race a promise against a timeout */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  // ... lines 261-277
}

/** Build CLI args for `git log --numstat` */
export function buildCliArgs(sinceDate?: Date): string[] {
  // ... lines 293-299
}

/** Primary: isomorphic-git reads .git directory */
export async function buildViaIsomorphicGit(
  repoRoot: string,
  sinceDate?: Date,
): Promise<Map<string, FileChurnData>> {
  // ... lines 309-367 (replace this.cache with isoGitCache,
  //   this.listAllFiles → listAllFiles, this.diffTrees → diffTrees, etc.)
}

/** List all files in a commit tree */
export async function listAllFiles(
  repoRoot: string,
  commitOid: string,
): Promise<string[]> {
  // ... lines 372-391
}

/** Diff two commit trees */
export async function diffTrees(
  repoRoot: string,
  parentOid: string,
  commitOid: string,
): Promise<string[]> {
  // ... lines 396-423
}

/** Enrich file map with numstat line stats */
export async function enrichLineStats(
  repoRoot: string,
  fileMap: Map<string, FileChurnData>,
  sinceDate?: Date,
): Promise<void> {
  // ... lines 429-463
}

/** Read blob as UTF-8 string at a specific commit */
export async function readBlobAsString(
  repoRoot: string,
  commitOid: string,
  filepath: string,
): Promise<string> {
  // ... lines 579-592
}

/** Run CLI git log with --numstat */
export async function buildViaCli(
  repoRoot: string,
  sinceDate?: Date,
): Promise<Map<string, FileChurnData>> {
  // ... lines 509-515 — uses buildCliArgs + parseNumstatOutput from parsers
}
```

Important: `buildViaCli` imports `parseNumstatOutput` from `./parsers.js`.

**Step 4: Update `git-log-reader.ts` to use adapters**

Replace all extracted methods with imports from `adapters/git/client.js` and
`adapters/git/parsers.js`. The `GitLogReader` class shrinks to just the
high-level orchestration methods that remain.

At this point `git-log-reader.ts` should contain:

- Re-exports of `extractTaskIds`, `computeFileMetadata`, `overlaps`,
  `isBugFixCommit` (from Task 2/3)
- `GitLogReader` class with: `buildFileMetadataMap`,
  `buildFileMetadataForPaths`, `buildChunkChurnMap`,
  `_buildChunkChurnMapUncached`, `getCommitsByPathspec*`,
  `_getCommitsViaIsomorphicGit`
- Internal cache fields
- All low-level git ops delegated to `adapters/git/client.js`

**Step 5: Run all tests**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: ALL tests pass

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: extract basic git operations to adapters/git/ layer"
```

---

## Task 5: Extract `enrichment/git/cache.ts`

HEAD-based memoization extracted from `GitLogReader` class fields.

**Files:**

- Create: `src/core/ingest/trajectory/enrichment/git/cache.ts`
- Modify: `src/core/ingest/trajectory/git/git-log-reader.ts` — use external
  cache

**Step 1: Create `enrichment/git/cache.ts`**

```typescript
// src/core/ingest/trajectory/enrichment/git/cache.ts

import { getHead } from "../../../../adapters/git/client.js";
import type { ChunkChurnOverlay, FileChurnData } from "../../git/types.js";

/**
 * HEAD-based cache for git enrichment results.
 * Invalidates automatically when HEAD changes.
 */
export class GitEnrichmentCache {
  private readonly fileMetadataCache = new Map<
    string,
    { headSha: string; data: Map<string, FileChurnData> }
  >();
  private readonly chunkChurnCache = new Map<
    string,
    { headSha: string; data: Map<string, Map<string, ChunkChurnOverlay>> }
  >();

  async getFileMetadata(
    cacheKey: string,
    repoRoot: string,
  ): Promise<Map<string, FileChurnData> | null> {
    try {
      const headSha = await getHead(repoRoot);
      const cached = this.fileMetadataCache.get(cacheKey);
      if (cached?.headSha === headSha) return cached.data;
    } catch {
      // Not a git repo or HEAD unresolvable — skip cache
    }
    return null;
  }

  async setFileMetadata(
    cacheKey: string,
    repoRoot: string,
    data: Map<string, FileChurnData>,
  ): Promise<void> {
    try {
      const headSha = await getHead(repoRoot);
      this.fileMetadataCache.set(cacheKey, { headSha, data });
    } catch {
      // Non-fatal
    }
  }

  async getChunkChurn(
    repoRoot: string,
  ): Promise<Map<string, Map<string, ChunkChurnOverlay>> | null> {
    try {
      const headSha = await getHead(repoRoot);
      const cached = this.chunkChurnCache.get(repoRoot);
      if (cached?.headSha === headSha) return cached.data;
    } catch {
      // Skip cache
    }
    return null;
  }

  async setChunkChurn(
    repoRoot: string,
    data: Map<string, Map<string, ChunkChurnOverlay>>,
  ): Promise<void> {
    try {
      const headSha = await getHead(repoRoot);
      this.chunkChurnCache.set(repoRoot, { headSha, data });
    } catch {
      // Non-fatal
    }
  }
}
```

**Step 2: Update `git-log-reader.ts` — replace inline cache with
GitEnrichmentCache**

Replace the two cache map fields and their usage in
`buildFileMetadataMap`/`buildChunkChurnMap` with `GitEnrichmentCache` instance
calls.

**Step 3: Run tests**

```bash
npx tsc --noEmit && npx vitest run
```

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: extract git enrichment cache to enrichment/git/cache.ts"
```

---

## Task 6: Extract `enrichment/git/file-reader.ts`

File-level metadata building — the `buildFileMetadataMap` orchestration.

**Files:**

- Create: `src/core/ingest/trajectory/enrichment/git/file-reader.ts`
- Modify: `src/core/ingest/trajectory/git/git-log-reader.ts` — delegate to
  file-reader

**Step 1: Create `enrichment/git/file-reader.ts`**

Extract from `GitLogReader`:

- `buildFileMetadataMap` (lines 218-256) — main orchestration
- `buildFileMetadataForPaths` (lines 474-507) — backfill

Both use `adapters/git/client.ts` functions and `GitEnrichmentCache`.

```typescript
// src/core/ingest/trajectory/enrichment/git/file-reader.ts

import {
  buildViaCli,
  buildViaIsomorphicGit,
  withTimeout,
} from "../../../../adapters/git/client.js";
import { parseNumstatOutput } from "../../../../adapters/git/parsers.js";
import type { FileChurnData } from "../../git/types.js";
import type { GitEnrichmentCache } from "./cache.js";

/**
 * Build per-file FileChurnData from git history.
 * CLI `git log` primary, isomorphic-git fallback.
 */
export async function buildFileMetadataMap(
  repoRoot: string,
  cache: GitEnrichmentCache,
  maxAgeMonths?: number,
): Promise<Map<string, FileChurnData>> {
  // ... extract from lines 218-256, replacing this.* with function calls
}

/**
 * Fetch file-level metadata for specific files (no --since).
 * Used for backfill of files outside the main git log window.
 */
export async function buildFileMetadataForPaths(
  repoRoot: string,
  paths: string[],
  timeoutMs = 30000,
): Promise<Map<string, FileChurnData>> {
  // ... extract from lines 474-507
}
```

**Step 2: Update `GitLogReader` to delegate**

`GitLogReader.buildFileMetadataMap` → calls
`fileReader.buildFileMetadataMap(repoRoot, this.cache, maxAgeMonths)`
`GitLogReader.buildFileMetadataForPaths` → calls
`fileReader.buildFileMetadataForPaths(repoRoot, paths, timeoutMs)`

**Step 3: Run tests**

```bash
npx tsc --noEmit && npx vitest run
```

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: extract file-reader from git-log-reader"
```

---

## Task 7: Extract `enrichment/git/chunk-reader.ts`

The 267-line god method + supporting commit retrieval functions.

**Files:**

- Create: `src/core/ingest/trajectory/enrichment/git/chunk-reader.ts`
- Modify: `src/core/ingest/trajectory/git/git-log-reader.ts` — delegate

**Step 1: Create `enrichment/git/chunk-reader.ts`**

Extract from `GitLogReader`:

- `buildChunkChurnMap` (lines 606-641) — top-level with cache
- `_buildChunkChurnMapUncached` (lines 801-1068) — the 267-line god method
- `getCommitsByPathspec` (lines 656-670) — dispatcher
- `getCommitsByPathspecSingle` (lines 672-695) — single batch
- `getCommitsByPathspecBatched` (lines 701-752) — multi-batch
- `_getCommitsViaIsomorphicGit` (lines 1074-1121) — fallback
- `PATHSPEC_BATCH_SIZE` constant (line 654)

All `this.*` references replaced with:

- `this.readBlobAsString` → `readBlobAsString` from `adapters/git/client.js`
- `this.diffTrees` → `diffTrees` from `adapters/git/client.js`
- `this.cache` → `isoGitCache` from `adapters/git/client.js`
- `this.getHead` → `getHead` from `adapters/git/client.js`
- `this.parsePathspecOutput` → `parsePathspecOutput` from
  `adapters/git/parsers.js`
- `this.chunkChurnCache` → `GitEnrichmentCache` parameter

```typescript
// src/core/ingest/trajectory/enrichment/git/chunk-reader.ts

import * as fs from "node:fs";

import { structuredPatch } from "diff";
import git from "isomorphic-git";

import {
  diffTrees,
  readBlobAsString,
  withTimeout,
} from "../../../../adapters/git/client.js";
import { parsePathspecOutput } from "../../../../adapters/git/parsers.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import type {
  ChunkChurnOverlay,
  CommitInfo,
  FileChurnData,
} from "../../git/types.js";
import type { GitEnrichmentCache } from "./cache.js";
import { isBugFixCommit, overlaps } from "./metrics.js";

const MAX_FILE_LINES_DEFAULT = 10000;
const PATHSPEC_BATCH_SIZE = 500;

export async function buildChunkChurnMap(
  repoRoot: string,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  cache: GitEnrichmentCache,
  concurrency?: number,
  maxAgeMonths?: number,
  fileChurnDataMap?: Map<string, FileChurnData>,
): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
  // ... lines 606-641 logic, cache via GitEnrichmentCache
}

// ... all supporting functions extracted verbatim with this.* replaced
```

**Step 2: Update `GitLogReader` to delegate**

`GitLogReader.buildChunkChurnMap` → calls `chunkReader.buildChunkChurnMap(...)`

**Step 3: Run tests**

```bash
npx tsc --noEmit && npx vitest run
```

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: extract chunk-reader from git-log-reader (267-line god method)"
```

---

## Task 8: Create `GitEnrichmentProvider` → `enrichment/git/provider.ts`

Implements `EnrichmentProvider` interface — wires file-reader + chunk-reader.

**Files:**

- Create: `src/core/ingest/trajectory/enrichment/git/provider.ts`

**Step 1: Write test**

Create `tests/code/enrichment/git-provider.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { GitEnrichmentProvider } from "../../../../src/core/ingest/trajectory/enrichment/git/provider.js";

describe("GitEnrichmentProvider", () => {
  it("has key 'git'", () => {
    const provider = new GitEnrichmentProvider();
    expect(provider.key).toBe("git");
  });

  it("implements EnrichmentProvider interface", () => {
    const provider = new GitEnrichmentProvider();
    expect(typeof provider.buildFileMetadata).toBe("function");
    expect(typeof provider.buildChunkMetadata).toBe("function");
  });
});
```

**Step 2: Run test — should fail**

```bash
npx vitest run tests/code/enrichment/git-provider.test.ts
```

**Step 3: Create `enrichment/git/provider.ts`**

```typescript
// src/core/ingest/trajectory/enrichment/git/provider.ts

import type { ChunkLookupEntry } from "../../../../types.js";
import type { FileChurnData } from "../../git/types.js";
import type { EnrichmentProvider } from "../types.js";
import { GitEnrichmentCache } from "./cache.js";
import { buildChunkChurnMap } from "./chunk-reader.js";
import {
  buildFileMetadataForPaths,
  buildFileMetadataMap,
} from "./file-reader.js";
import { computeFileMetadata } from "./metrics.js";

/**
 * Git enrichment provider — computes file-level and chunk-level
 * git trajectory metrics for Qdrant payload enrichment.
 */
export class GitEnrichmentProvider implements EnrichmentProvider {
  readonly key = "git";
  private readonly cache = new GitEnrichmentCache();
  private lastFileResult: Map<string, FileChurnData> | null = null;

  async buildFileMetadata(
    root: string,
    options?: { paths?: string[] },
  ): Promise<Map<string, Record<string, unknown>>> {
    let rawData: Map<string, FileChurnData>;

    if (options?.paths) {
      rawData = await buildFileMetadataForPaths(root, options.paths);
    } else {
      rawData = await buildFileMetadataMap(root, this.cache);
    }

    this.lastFileResult = rawData;

    // Transform FileChurnData → Record<string, unknown> via computeFileMetadata
    // We need endLine for each file, but at prefetch time we don't have it yet.
    // Store raw data; coordinator will call computeFileMetadata when applying.
    const result = new Map<string, Record<string, unknown>>();
    for (const [path, churnData] of rawData) {
      // Store raw churn data as-is — applier will compute final metadata
      // with actual line count when applying per-file
      result.set(path, churnData as unknown as Record<string, unknown>);
    }
    return result;
  }

  async buildChunkMetadata(
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): Promise<Map<string, Map<string, Record<string, unknown>>>> {
    const chunkConcurrency = parseInt(
      process.env.GIT_CHUNK_CONCURRENCY ?? "10",
      10,
    );
    const chunkMaxAgeMonths = parseFloat(
      process.env.GIT_CHUNK_MAX_AGE_MONTHS ?? "6",
    );

    const rawResult = await buildChunkChurnMap(
      root,
      chunkMap,
      this.cache,
      chunkConcurrency,
      chunkMaxAgeMonths,
      this.lastFileResult ?? undefined,
    );

    // Transform ChunkChurnOverlay → Record<string, unknown>
    const result = new Map<string, Map<string, Record<string, unknown>>>();
    for (const [filePath, overlayMap] of rawResult) {
      const chunkEntries = new Map<string, Record<string, unknown>>();
      for (const [chunkId, overlay] of overlayMap) {
        chunkEntries.set(
          chunkId,
          overlay as unknown as Record<string, unknown>,
        );
      }
      result.set(filePath, chunkEntries);
    }
    return result;
  }
}
```

**Step 4: Run test — should pass**

```bash
npx vitest run tests/code/enrichment/git-provider.test.ts
```

**Step 5: Run all tests**

```bash
npx tsc --noEmit && npx vitest run
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: create GitEnrichmentProvider implementing EnrichmentProvider interface"
```

---

## Task 9: Generalize `applier.ts` — provider-agnostic payload writer

Replace hardcoded `{ git: metadata }` with `{ [provider.key]: { file: data } }`.

**Files:**

- Create: `src/core/ingest/trajectory/enrichment/applier.ts`
- Keep: `src/core/ingest/trajectory/enrichment/metadata-applier.ts` (unchanged
  for now — deleted in Task 12)

**Step 1: Write test for new applier**

Create `tests/code/enrichment/applier.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentApplier } from "../../../src/core/ingest/trajectory/enrichment/applier.js";

describe("EnrichmentApplier", () => {
  let mockQdrant: any;
  let applier: EnrichmentApplier;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
    };
    applier = new EnrichmentApplier(mockQdrant);
  });

  it("writes payload under { [key]: { file: data } } structure", async () => {
    await applier.applyFileMetadata(
      "test-collection",
      "git",
      new Map([["src/index.ts", { commitCount: 5 }]]),
      "/repo",
      [
        {
          chunkId: "chunk-1",
          chunk: { metadata: { filePath: "/repo/src/index.ts" }, endLine: 100 },
        } as any,
      ],
    );

    expect(mockQdrant.batchSetPayload).toHaveBeenCalledWith(
      "test-collection",
      expect.arrayContaining([
        expect.objectContaining({
          payload: { git: { file: { commitCount: 5 } } },
          points: ["chunk-1"],
        }),
      ]),
    );
  });

  it("tracks missed files for backfill", async () => {
    await applier.applyFileMetadata(
      "test-collection",
      "git",
      new Map(), // empty — no file metadata
      "/repo",
      [
        {
          chunkId: "chunk-1",
          chunk: {
            metadata: { filePath: "/repo/src/missing.ts" },
            endLine: 50,
          },
        } as any,
      ],
    );

    expect(applier.missedFiles).toBe(1);
    expect(applier.missedFileChunks.size).toBe(1);
  });
});
```

**Step 2: Run test — should fail**

```bash
npx vitest run tests/code/enrichment/applier.test.ts
```

**Step 3: Create `enrichment/applier.ts`**

Based on `metadata-applier.ts` but:

- `{ git: metadata }` → `{ [providerKey]: { file: data } }` for file-level
- `applyFileMetadata` takes `providerKey: string` and pre-computed
  `Map<string, Record<string, unknown>>`
- No `computeFileMetadata` call — provider returns ready payloads

```typescript
// src/core/ingest/trajectory/enrichment/applier.ts

import { relative } from "node:path";

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { pipelineLog } from "../../pipeline/debug-logger.js";
import type { ChunkItem } from "../../pipeline/types.js";

const BATCH_SIZE = 100;

export class EnrichmentApplier {
  matchedFiles = 0;
  missedFiles = 0;
  readonly missedPathSamples: string[] = [];
  readonly missedFileChunks = new Map<
    string,
    { chunkId: string; endLine: number }[]
  >();

  constructor(private readonly qdrant: QdrantManager) {}

  /**
   * Apply file-level metadata to a batch of chunks.
   * Payload written as { [providerKey]: { file: data } }.
   */
  async applyFileMetadata(
    collectionName: string,
    providerKey: string,
    fileMetadata: Map<string, Record<string, unknown>>,
    pathBase: string,
    items: ChunkItem[],
  ): Promise<void> {
    const applyStart = Date.now();

    // Group items by filePath
    const byFile = new Map<string, ChunkItem[]>();
    for (const item of items) {
      const fp = item.chunk.metadata.filePath;
      const existing = byFile.get(fp) || [];
      existing.push(item);
      byFile.set(fp, existing);
    }

    const operations: {
      payload: Record<string, unknown>;
      points: (string | number)[];
    }[] = [];

    for (const [filePath, fileItems] of byFile) {
      const relativePath = relative(pathBase, filePath);
      const data = fileMetadata.get(relativePath);
      if (!data) {
        this.missedFiles++;
        if (this.missedPathSamples.length < 10) {
          this.missedPathSamples.push(relativePath);
        }
        const existing = this.missedFileChunks.get(relativePath) || [];
        for (const item of fileItems) {
          existing.push({ chunkId: item.chunkId, endLine: item.chunk.endLine });
        }
        this.missedFileChunks.set(relativePath, existing);
        continue;
      }
      this.matchedFiles++;

      // Nested payload: { git: { file: { commitCount: 5, ... } } }
      const payload = { [providerKey]: { file: data } };

      for (const item of fileItems) {
        operations.push({ payload, points: [item.chunkId] });
      }
    }

    if (operations.length === 0) return;

    for (let i = 0; i < operations.length; i += BATCH_SIZE) {
      const batch = operations.slice(i, i + BATCH_SIZE);
      try {
        await this.qdrant.batchSetPayload(collectionName, batch);
      } catch (error) {
        if (process.env.DEBUG) {
          console.error("[EnrichmentApplier] batchSetPayload failed:", error);
        }
      }
    }

    pipelineLog.addStageTime("enrichApply", Date.now() - applyStart);
  }

  /**
   * Apply chunk-level metadata overlays.
   * Payload written as { [providerKey]: { chunk: data } }.
   */
  async applyChunkMetadata(
    collectionName: string,
    providerKey: string,
    chunkMetadata: Map<string, Map<string, Record<string, unknown>>>,
  ): Promise<number> {
    let batch: {
      payload: Record<string, unknown>;
      points: (string | number)[];
    }[] = [];
    let applied = 0;

    for (const [, overlayMap] of chunkMetadata) {
      for (const [chunkId, overlay] of overlayMap) {
        batch.push({
          payload: { [providerKey]: { chunk: overlay } },
          points: [chunkId],
        });

        if (batch.length >= BATCH_SIZE) {
          try {
            await this.qdrant.batchSetPayload(collectionName, batch);
            applied += batch.length;
          } catch (error) {
            if (process.env.DEBUG) {
              console.error("[EnrichmentApplier] chunk batch failed:", error);
            }
          }
          batch = [];
        }
      }
    }

    if (batch.length > 0) {
      try {
        await this.qdrant.batchSetPayload(collectionName, batch);
        applied += batch.length;
      } catch (error) {
        if (process.env.DEBUG) {
          console.error("[EnrichmentApplier] final chunk batch failed:", error);
        }
      }
    }

    return applied;
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/code/enrichment/applier.test.ts
```

Expected: PASS

**Step 5: Run all tests**

```bash
npx tsc --noEmit && npx vitest run
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: create generic EnrichmentApplier with nested payload structure"
```

---

## Task 10: Create `enrichment/coordinator.ts` — generic coordinator

Replace `EnrichmentModule` with provider-agnostic coordinator.

**Files:**

- Create: `src/core/ingest/trajectory/enrichment/coordinator.ts`

**Step 1: Write test for Coordinator**

Create `tests/code/enrichment/coordinator.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../src/core/ingest/trajectory/enrichment/coordinator.js";
import type { EnrichmentProvider } from "../../../src/core/ingest/trajectory/enrichment/types.js";

describe("EnrichmentCoordinator", () => {
  let mockQdrant: any;
  let mockProvider: EnrichmentProvider;
  let coordinator: EnrichmentCoordinator;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    mockProvider = {
      key: "git",
      buildFileMetadata: vi.fn().mockResolvedValue(new Map()),
      buildChunkMetadata: vi.fn().mockResolvedValue(new Map()),
    };
    coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
  });

  it("calls provider.buildFileMetadata on prefetch", () => {
    coordinator.prefetch("/repo", "test-col");
    expect(mockProvider.buildFileMetadata).toHaveBeenCalledWith("/repo");
  });

  it("has provider key accessible", () => {
    expect(coordinator.providerKey).toBe("git");
  });
});
```

**Step 2: Run test — should fail**

```bash
npx vitest run tests/code/enrichment/coordinator.test.ts
```

**Step 3: Create `enrichment/coordinator.ts`**

Same timing/queuing logic as `EnrichmentModule`, but:

- Constructor takes `EnrichmentProvider` instead of hardcoding `GitLogReader`
- Uses `EnrichmentApplier` with `provider.key` for payload nesting
- `resolveGitRepoRoot` → `resolveRepoRoot` from `adapters/git/client.js`
- `startChunkChurn` → `startChunkEnrichment` (generic name)
- `prefetchGitLog` → `prefetch` (generic name)

```typescript
// src/core/ingest/trajectory/enrichment/coordinator.ts

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Ignore } from "ignore";

import { resolveRepoRoot } from "../../../adapters/git/client.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type {
  ChunkLookupEntry,
  EnrichmentInfo,
  EnrichmentMetrics,
} from "../../../types.js";
import { INDEXING_METADATA_ID } from "../../constants.js";
import { pipelineLog } from "../../pipeline/debug-logger.js";
import type { ChunkItem } from "../../pipeline/types.js";
import { EnrichmentApplier } from "./applier.js";
import type { EnrichmentProvider } from "./types.js";

interface PendingBatch {
  collectionName: string;
  absolutePath: string;
  items: ChunkItem[];
}

/**
 * EnrichmentCoordinator — generic timing orchestrator for enrichment providers.
 *
 * Coordinates three phases:
 * 1. Prefetch: provider.buildFileMetadata (fire-and-forget at T=0)
 * 2. Per-batch: apply file metadata as chunks arrive
 * 3. Post-flush: provider.buildChunkMetadata overlays
 */
export class EnrichmentCoordinator {
  // ... same state fields as EnrichmentModule
  // ... but fileMetadata is Map<string, Record<string, unknown>>
  // ... and uses EnrichmentApplier + EnrichmentProvider

  get providerKey(): string {
    return this.provider.key;
  }

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly provider: EnrichmentProvider,
  ) {
    this.applier = new EnrichmentApplier(qdrant);
  }

  // Same public API shape as EnrichmentModule:
  // prefetch(absolutePath, collectionName?, ignoreFilter?)
  // onChunksStored(collectionName, absolutePath, items)
  // startChunkEnrichment(collectionName, absolutePath, chunkMap)
  // awaitCompletion(collectionName)
  // updateEnrichmentMarker(collectionName, info)

  // Implementation follows EnrichmentModule pattern but:
  // - calls this.provider.buildFileMetadata(root) instead of logReader.buildFileMetadataMap()
  // - calls this.provider.buildChunkMetadata(root, chunkMap) instead of runChunkChurn()
  // - calls this.applier.applyFileMetadata(col, provider.key, data, ...) instead of MetadataApplier
  // - calls this.applier.applyChunkMetadata(col, provider.key, data) for chunk overlays
}
```

Full implementation follows `enrichment-module.ts` logic (306 lines) adapted for
generic provider.

**Step 4: Run test — should pass**

```bash
npx vitest run tests/code/enrichment/coordinator.test.ts
```

**Step 5: Run all tests**

```bash
npx tsc --noEmit && npx vitest run
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: create generic EnrichmentCoordinator with provider interface"
```

---

## Task 11: Wire consumers to new coordinator

Replace `EnrichmentModule` with `EnrichmentCoordinator` +
`GitEnrichmentProvider`.

**Files:**

- Modify: `src/core/api/ingest-facade.ts`
- Modify: `src/core/ingest/pipeline/base.ts`
- Modify: `src/core/ingest/indexing.ts` (if needed)
- Modify: `src/core/ingest/reindexing.ts` (if needed)

**Step 1: Update `ingest-facade.ts`**

```typescript
// Replace:
import { EnrichmentModule } from "../ingest/trajectory/enrichment-module.js";
// With:
import { EnrichmentCoordinator } from "../ingest/trajectory/enrichment/coordinator.js";
import { GitEnrichmentProvider } from "../ingest/trajectory/enrichment/git/provider.js";

// In constructor:
// Replace: this.enrichment = new EnrichmentModule(qdrant);
// With:
const gitProvider = new GitEnrichmentProvider();
this.enrichment = new EnrichmentCoordinator(qdrant, gitProvider);
```

**Step 2: Update `pipeline/base.ts`**

```typescript
// Replace:
import type { EnrichmentModule } from "../trajectory/enrichment-module.js";
// With:
import type { EnrichmentCoordinator } from "../trajectory/enrichment/coordinator.js";

// In class:
// Replace: enrichment: EnrichmentModule
// With: enrichment: EnrichmentCoordinator

// In setupEnrichmentHooks:
// Replace: this.enrichment.prefetchGitLog(...)
// With: this.enrichment.prefetch(...)
// Replace: this.enrichment.startChunkChurn(...)
// With: this.enrichment.startChunkEnrichment(...)
```

**Step 3: Update `ingest-facade.ts` type**

```typescript
// private readonly enrichment: EnrichmentModule;
// → private readonly enrichment: EnrichmentCoordinator;
```

**Step 4: Run all tests**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: Some enrichment tests may fail due to constructor changes. Fix import
paths.

**Step 5: Update enrichment tests**

- `enrichment-module-streaming.test.ts`: change `new EnrichmentModule(qdrant)` →
  `new EnrichmentCoordinator(qdrant, mockProvider)`
- `enrichment-await.test.ts`: same change
- `enrichment-module.test.ts`: same change

**Step 6: Run all tests again**

```bash
npx tsc --noEmit && npx vitest run
```

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: wire EnrichmentCoordinator + GitEnrichmentProvider into pipeline"
```

---

## Task 12: Rename `ChunkChurnOverlay` fields + add `relativeChurn` for chunks

**Rationale:** With the new `{provider.key}.{file|chunk}.{metric}` payload
nesting, the `chunk` prefix on overlay fields is redundant — the nesting level
already indicates "chunk". Removing it makes field names symmetric with
file-level metrics. Also adds `relativeChurn` to chunk level (chunk lines
changed / chunk size).

**Breaking change for types:** `ChunkChurnOverlay` field names change.

**Files:**

- Modify: `src/core/ingest/trajectory/git/types.ts` — rename fields, add
  `relativeChurn`
- Modify: `src/core/ingest/trajectory/enrichment/git/metrics.ts` — update
  `computeChunkOverlay` output + add `relativeChurn` calculation
- Modify: `src/core/ingest/trajectory/git/git-log-reader.ts` — update
  `ChunkAccumulator` usage if needed (add `linesAdded`/`linesDeleted` to
  accumulator for relativeChurn)
- Modify: `src/core/types.ts` — update `git.chunk` type definition
- Modify: `src/core/search/reranker.ts` — update field references
- Modify: `tests/code/git/git-log-reader.test.ts` — update field assertions
- Modify: `tests/code/indexer/enrichment-module-streaming.test.ts` — update mock
  data
- Modify: `tests/core/search/reranker.test.ts` — update field references

**Step 1: Rename `ChunkChurnOverlay` fields**

In `types.ts`:

```typescript
export interface ChunkChurnOverlay {
  commitCount: number; // was: chunkCommitCount
  churnRatio: number; // was: chunkChurnRatio
  contributorCount: number; // was: chunkContributorCount
  bugFixRate: number; // was: chunkBugFixRate
  lastModifiedAt: number; // was: chunkLastModifiedAt
  ageDays: number; // was: chunkAgeDays
  relativeChurn: number; // NEW: chunk lines changed / chunk line count
}
```

**Step 2: Update `computeChunkOverlay` in `metrics.ts`**

- Rename output fields to match new interface
- Add `relativeChurn` calculation: needs `linesAdded + linesDeleted` from
  accumulator and `chunkLineCount` (endLine - startLine + 1) as input
- Extend `ChunkAccumulator` with `linesAdded: number; linesDeleted: number`

**Step 3: Update `git-log-reader.ts` hunk mapper**

- Track `linesAdded`/`linesDeleted` in accumulator during hunk mapping
- Pass `chunkLineCount` to `computeChunkOverlay`

**Step 4: Update all consumers**

Global rename across code + tests:

- `chunkCommitCount` → `commitCount` (in chunk context)
- `chunkChurnRatio` → `churnRatio`
- `chunkContributorCount` → `contributorCount`
- `chunkBugFixRate` → `bugFixRate`
- `chunkLastModifiedAt` → `lastModifiedAt`
- `chunkAgeDays` → `ageDays`

Reranker reads chunk fields from `git.chunk.{metric}` — no prefix needed.

**Step 5: Run all tests**

```bash
npx tsc --noEmit && npx vitest run
```

**Step 6: Commit**

```bash
git commit -m "refactor: rename ChunkChurnOverlay fields (drop chunk prefix) + add relativeChurn"
```

---

## Task 13: Update payload structure across all write + read paths

**Breaking change:** payload nesting changes from `git.commitCount` to
`git.file.commitCount`, and `git.chunkCommitCount` to `git.chunk.commitCount`.

**Files:**

- Modify: `src/core/ingest/pipeline/chunk-pipeline.ts:346-358` — inline git
  payload at upsert time
- Modify: `src/core/ingest/pipeline/types.ts:59` — `git?:` type definition in
  ChunkMetadata
- Modify: `src/core/types.ts:83,255` — `git?:` type in SearchResult and
  ChunkMetadata
- Modify: `src/core/search/search-module.ts` — `payload?.git` access
- Modify: `src/core/search/reranker.ts` — `git.ageDays`, `git.commitCount` etc.
- Modify: `src/mcp/tools/formatters/search-pipeline.ts` — `payload?.git`

**IMPORTANT:** `chunk-pipeline.ts:346-358` writes
`{ git: { lastModifiedAt, ... } }` at upsert time (inline, before enrichment).
This ALSO needs the nested structure:
`{ git: { file: { lastModifiedAt, ... } } }`. The enrichment path (applier) then
overwrites/merges with the same structure.

**Step 1: Update `reranker.ts`**

All references like `git?.ageDays` → `git?.file?.ageDays ?? git?.ageDays`
(backward-compat during transition).

Or cleaner: read from nested structure and fall back to flat for old indexes:

```typescript
function getGitMeta(payload: any): any {
  const git = payload?.git;
  // Support both new nested { file: { ageDays } } and old flat { ageDays }
  return git?.file ?? git;
}
```

Chunk fields: `git?.chunk?.commitCount` (already renamed without prefix in Task
12).

**Step 2: Update `search-module.ts`**

Same pattern — read `git.file` with fallback.

**Step 3: Update `search-pipeline.ts`**

Same pattern for metaOnly output.

**Step 4: Run all tests**

```bash
npx tsc --noEmit && npx vitest run
```

**Step 5: Commit**

```bash
git commit -m "feat: update search layer for nested git.file/git.chunk payload structure"
```

---

## Task 14: Delete old files + cleanup

Remove replaced modules now that new structure is wired.

**Files:**

- Delete: `src/core/ingest/trajectory/enrichment-module.ts` (replaced by
  coordinator)
- Delete: `src/core/ingest/trajectory/enrichment/chunk-churn.ts` (dissolved into
  coordinator + chunk-reader)
- Delete: `src/core/ingest/trajectory/enrichment/metadata-applier.ts` (replaced
  by applier.ts)
- Delete: `src/core/ingest/trajectory/git/git-log-reader.ts` (decomposed into
  adapters + enrichment/git/)
- Delete: `src/core/ingest/trajectory/git/index.ts` (dead barrel)
- Modify: `src/core/ingest/trajectory/git/types.ts` — ensure only active types
  remain, or move to `enrichment/git/types.ts`

**Step 1: Verify no remaining imports of deleted files**

```bash
npx rg "enrichment-module|chunk-churn|metadata-applier|git-log-reader|git/index" --type ts -l
```

Should show only: the files being deleted + their tests.

**Step 2: Move active types from `git/types.ts` to `enrichment/git/types.ts`**

Create `src/core/ingest/trajectory/enrichment/git/types.ts` with
`FileChurnData`, `GitFileMetadata`, `ChunkChurnOverlay`.

Keep `CommitInfo` and `GitRepoInfo` in `trajectory/git/types.ts` (they're basic
git types shared across layers).

Update imports in all new modules.

**Step 3: Delete old files**

```bash
rm src/core/ingest/trajectory/enrichment-module.ts
rm src/core/ingest/trajectory/enrichment/chunk-churn.ts
rm src/core/ingest/trajectory/enrichment/metadata-applier.ts
rm src/core/ingest/trajectory/git/git-log-reader.ts
rm src/core/ingest/trajectory/git/index.ts
```

**Step 4: Update test imports**

- `tests/code/git/git-log-reader.test.ts` → update imports to point to new
  module locations:
  - `computeFileMetadata` from `enrichment/git/metrics.js`
  - `overlaps`, `extractTaskIds` from respective modules
  - `GitLogReader` class no longer exists — tests need refactoring:
    - Private method tests like `(reader as any).parseNumstatOutput()` → import
      `parseNumstatOutput` from `adapters/git/parsers.js`
    - `(reader as any).buildViaIsomorphicGit()` → import from
      `adapters/git/client.js`
    - `reader.buildFileMetadataMap()` → import from
      `enrichment/git/file-reader.js`
    - `reader.buildChunkChurnMap()` → import from
      `enrichment/git/chunk-reader.js`

- `tests/code/indexer/enrichment-module-streaming.test.ts` → update to use
  `EnrichmentCoordinator`
- `tests/code/indexer/enrichment-module.test.ts` → update to use
  `EnrichmentCoordinator`
- `tests/code/indexer/enrichment-await.test.ts` → update to use
  `EnrichmentCoordinator`

**Step 5: Run tests**

```bash
npx tsc --noEmit && npx vitest run
```

This step will likely require multiple iterations to fix all import paths.

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete old god objects, wire all tests to new enrichment structure"
```

---

## Task 15: Final verification + cleanup

**Step 1: Type check**

```bash
npx tsc --noEmit
```

**Step 2: Full test suite**

```bash
npx vitest run
```

**Step 3: Verify directory structure matches design**

```bash
find src/core/adapters/git -name "*.ts" | sort
find src/core/ingest/trajectory/enrichment -name "*.ts" | sort
```

Expected:

```
src/core/adapters/git/client.ts
src/core/adapters/git/parsers.ts
src/core/adapters/git/types.ts
src/core/ingest/trajectory/enrichment/applier.ts
src/core/ingest/trajectory/enrichment/coordinator.ts
src/core/ingest/trajectory/enrichment/types.ts
src/core/ingest/trajectory/enrichment/utils.ts
src/core/ingest/trajectory/enrichment/git/cache.ts
src/core/ingest/trajectory/enrichment/git/chunk-reader.ts
src/core/ingest/trajectory/enrichment/git/file-reader.ts
src/core/ingest/trajectory/enrichment/git/metrics.ts
src/core/ingest/trajectory/enrichment/git/provider.ts
src/core/ingest/trajectory/enrichment/git/types.ts
```

**Step 4: Line count verification**

No individual file should exceed ~300 lines. The 1122-line god object is now
split across 7+ files.

**Step 5: Final commit**

```bash
git add -A
git commit -m "refactor: trajectory enrichment redesign complete — EnrichmentProvider interface + git implementation"
```

---

## Task 16: Audit git metric set — ROI for file-level, sufficiency for chunk-level

**Type:** Research / analysis task. No code changes — produces a decision
document.

**Problem:**

- **File-level metrics (GitFileMetadata):** 18 fields. Unclear ROI — which ones
  are actually used by reranker/search, and which are dead weight in Qdrant
  payload?
- **Chunk-level metrics (ChunkChurnOverlay):** 6 fields (after rename). Possibly
  insufficient:
  - No `taskIds` at chunk level — but task IDs are arguably MORE relevant
    per-chunk than per-file (which chunks were touched by ticket TD-1234?)
  - No `authors` list per chunk — only `contributorCount`
  - No `relativeChurn` per chunk (addressed in Task 12, but needs validation)
- **Symmetry question:** Should chunk metrics mirror file metrics where it makes
  sense, or remain a minimal overlay?

**Analysis steps:**

1. **Map file-level metric usage:** For each of 18 `GitFileMetadata` fields,
   find:
   - Is it read by reranker signals? (`reranker.ts`)
   - Is it exposed in search results? (`search-module.ts`, `search-pipeline.ts`)
   - Is it used in Qdrant filters? (documented in CLAUDE.md, used by consumers)
   - If none of the above → candidate for removal

2. **Map chunk-level metric usage:** Same analysis for overlay fields.

3. **Identify missing chunk metrics:**
   - `taskIds` — which tickets touched THIS chunk's lines? (available from
     accumulator's commit set → extract bodies → `extractTaskIds`)
   - `authors` — who modified THIS chunk? (available from accumulator's
     `authors` set)
   - `dominantAuthor` — who owns THIS chunk?
   - `linesAdded`/`linesDeleted` — raw churn per chunk

4. **Cost/benefit for each metric:**
   - Storage cost in Qdrant (payload size × chunk count)
   - Compute cost during enrichment
   - Query/filter value for consumers
   - Reranking signal value

5. **Produce decision:** Which metrics to keep, drop, or add. Update
   `GitFileMetadata`, `ChunkChurnOverlay`, `computeFileMetadata`,
   `computeChunkOverlay` accordingly.

**Output:** Decision document in `docs/plans/` or notes in the design doc.
Implementation in a follow-up task.

---

## Risk Areas

1. **119 tests in `git-log-reader.test.ts`** — most fragile part. Many test
   private methods via `(reader as any)`. After decomposition these become
   public functions, but import paths all change.

2. **27 tests in `enrichment-module-streaming.test.ts`** — test timing/queuing.
   Constructor changes from `new EnrichmentModule(qdrant)` to
   `new EnrichmentCoordinator(qdrant, provider)`.

3. **isomorphic-git `cache` object** — shared mutable state. Currently
   `this.cache` on `GitLogReader`. After extraction it becomes module-level
   `isoGitCache` in `adapters/git/client.ts`. Must be shared across all calls.

4. **Payload structure is breaking** — existing indexed data uses
   `git.commitCount`, new structure uses `git.file.commitCount`. Requires
   reindex after deployment. Search-side needs backward-compat fallback.

5. **`computeFileMetadata` call timing** — current `metadata-applier.ts:79`
   calls `computeFileMetadata(churnData, maxEndLine)` at apply time because it
   needs `maxEndLine` from chunk items. Two options:
   - **Option A (simpler):** Provider returns raw `FileChurnData`,
     coordinator/applier calls `computeFileMetadata` at apply time (couples
     applier to git-specific logic).
   - **Option B (cleaner):** Provider stores raw data internally,
     `buildFileMetadata` returns pre-computed `GitFileMetadata` with
     `currentLineCount=0`, then applier calls a provider
     `finalize(path, endLine)` method. This adds complexity.
   - **Recommended:** Option A with a git-specific transform callback passed to
     the applier. The applier accepts an optional
     `transform: (rawData, maxEndLine) => Record<string, unknown>` per-provider.
     Git provider passes `computeFileMetadata`. Other providers can pass
     identity.

## Notes

- `resolveGitRepoRoot` in `enrichment-module.ts:296-305` uses `execFileSync` —
  move to `adapters/git/client.ts` as `resolveRepoRoot`
- `chunk-pipeline.ts:346-358` writes inline `{ git: { ... } }` at upsert time —
  MUST be updated to `{ git: { file: { ... } } }` to match new nested structure.
  Also update the `git?:` type in `pipeline/types.ts:59` and `types.ts:83,255`
- `debug-logger.ts` has `"git"` as a `PipelineStage` — keep as-is (it's just a
  timing label)
