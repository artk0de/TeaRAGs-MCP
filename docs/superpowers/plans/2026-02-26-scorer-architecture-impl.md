# Scorer Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Refactor signal descriptors into class-based Scorer architecture with
metric decomposition, establishing a composable scoring system for search
reranking.

**Architecture:** Metrics decomposed into pure function extractors + assemblers
(Strategy + Assembler). SignalDescriptor interface renamed to Scorer, each
scorer becomes a class. CompositeScorer extends Scorer for cross-trajectory
scoring. Registration happens at two levels: trajectory-owned leaf scorers and
API-level composite scorers.

**Tech Stack:** TypeScript, Vitest, Qdrant payload types

**Terminology:**

- **Signal** = raw payload value stored in Qdrant (`git.file.commitCount`,
  `git.chunk.ageDays`)
- **Scorer** = class that reads signals and produces a normalized score (0-1)
  for reranking
- **CompositeScorer** = cross-trajectory scorer combining leaf scorers from
  multiple trajectories

---

## Task 1: Create Scorer and CompositeScorer interfaces

**Files:**

- Create: `src/core/api/scorer.ts`
- Test: `tests/core/api/scorer.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/api/scorer.test.ts
import { describe, expect, it } from "vitest";

import type { CompositeScorer, Scorer } from "../../../src/core/api/scorer.js";

describe("Scorer interface", () => {
  it("allows implementing a leaf scorer", () => {
    const scorer: Scorer = {
      name: "test",
      description: "Test scorer",
      defaultBound: 100,
      extract: () => 0.5,
    };
    expect(scorer.name).toBe("test");
    expect(scorer.extract({})).toBe(0.5);
  });

  it("allows implementing a composite scorer with dependencies", () => {
    const composite: CompositeScorer = {
      name: "composite",
      description: "Composite test",
      dependencies: ["recency", "churn"],
      bind: () => {},
      extract: () => 0.7,
    };
    expect(composite.dependencies).toEqual(["recency", "churn"]);
    expect(composite.extract({})).toBe(0.7);
  });

  it("CompositeScorer is assignable to Scorer", () => {
    const composite: CompositeScorer = {
      name: "composite",
      description: "Composite test",
      dependencies: ["a"],
      bind: () => {},
      extract: () => 0.3,
    };
    const scorer: Scorer = composite;
    expect(scorer.name).toBe("composite");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/scorer.test.ts` Expected: FAIL — cannot
resolve `../../../src/core/api/scorer.js`

**Step 3: Write minimal implementation**

```typescript
// src/core/api/scorer.ts
/**
 * Scorer interfaces — base contracts for search result scoring.
 *
 * Signal = raw payload value (what's stored in Qdrant).
 * Scorer = reads signals, produces normalized score (0-1) for reranking.
 * CompositeScorer = cross-trajectory scorer combining multiple leaf scorers.
 *
 * Scorer lives at core/api because it's cross-cutting:
 * trajectory providers implement it, search layer consumes it.
 */

export interface Scorer {
  readonly name: string;
  readonly description: string;
  readonly defaultBound?: number;
  readonly needsConfidence?: boolean;
  readonly confidenceField?: string;
  extract(payload: Record<string, unknown>): number;
}

export interface CompositeScorer extends Scorer {
  readonly dependencies: string[];
  bind(scorers: Map<string, Scorer>): void;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/api/scorer.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/core/api/scorer.ts tests/core/api/scorer.test.ts
git commit -m "feat: add Scorer and CompositeScorer interfaces in core/api"
```

---

## Task 2: Rename SignalDescriptor → Scorer in trajectory types

Rename `SignalDescriptor` → `Scorer` (re-exported from `core/api/scorer.ts`),
rename `TrajectoryQueryContract.signals` → `.scorers`, rename
`TrajectoryRegistry.getAllSignals()` → `.getAllScorers()`.

**Files:**

- Modify: `src/core/trajectory/types.ts`
- Modify: `src/core/api/trajectory-registry.ts`
- Modify: `src/core/trajectory/git/signals.ts`
- Modify: `tests/core/trajectory/types.test.ts`
- Modify: `tests/core/api/trajectory-registry.test.ts`
- Modify: `tests/core/trajectory/git/signals.test.ts`

**Step 1: Update `src/core/trajectory/types.ts`**

Remove `SignalDescriptor` interface. Re-export `Scorer` from
`core/api/scorer.ts`. Rename contract field `signals` → `scorers`. Keep
`SignalDescriptor` as deprecated type alias for backward compat during
migration.

```typescript
// In types.ts:
import type { Scorer } from "../api/scorer.js";

export type { Scorer };

// Deprecated alias — remove after all consumers migrated
export type SignalDescriptor = Scorer;

// Update TrajectoryQueryContract:
export interface TrajectoryQueryContract {
  readonly scorers: Scorer[];
  readonly filters: FilterDescriptor[];
  readonly presets: Record<string, ScoringWeights>;
  readonly payloadFields: FieldDoc[];
}
```

**Step 2: Update `src/core/api/trajectory-registry.ts`**

Rename `getAllSignals()` → `getAllScorers()`. Update import of
`SignalDescriptor` → `Scorer`.

**Step 3: Update `src/core/trajectory/git/signals.ts`**

Change import from `SignalDescriptor` to `Scorer`. Change
`export const gitSignals: SignalDescriptor[]` →
`export const gitScorers: Scorer[]`. Keep `gitSignals` as deprecated re-export.

**Step 4: Update tests**

- `tests/core/trajectory/types.test.ts` — update mock contract: `.signals` →
  `.scorers`
- `tests/core/api/trajectory-registry.test.ts` — `.signals` → `.scorers` in
  mocks, `getAllSignals()` → `getAllScorers()`
- `tests/core/trajectory/git/signals.test.ts` — import `gitScorers` instead of
  `gitSignals`

**Step 5: Run all tests**

Run:
`npx vitest run tests/core/trajectory tests/core/api/trajectory-registry.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/core/trajectory/types.ts src/core/api/trajectory-registry.ts \
  src/core/trajectory/git/signals.ts \
  tests/core/trajectory tests/core/api/trajectory-registry.test.ts
git commit -m "refactor: rename SignalDescriptor → Scorer, signals → scorers in contracts"
```

---

## Task 3: Decompose metric extractors from `computeFileMetadata`

Extract each metric computation into a pure function.

**Files:**

- Create: `src/core/trajectory/git/infra/metrics/extractors.ts`
- Create: `src/core/trajectory/git/infra/metrics/types.ts`
- Test: `tests/core/trajectory/git/infra/metrics/extractors.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/trajectory/git/infra/metrics/extractors.test.ts
import { describe, expect, it } from "vitest";

import type { CommitInfo } from "../../../../../../src/core/adapters/git/types.js";
import {
  computeBugFixRate,
  computeChangeDensity,
  computeChurnVolatility,
  computeDominantAuthor,
  computeRecencyWeightedFreq,
  computeRelativeChurn,
  computeTemporalMetrics,
  extractAllTaskIds,
} from "../../../../../../src/core/trajectory/git/infra/metrics/extractors.js";

const makeCommit = (overrides: Partial<CommitInfo> = {}): CommitInfo => ({
  sha: "abc123",
  author: "alice",
  authorEmail: "alice@example.com",
  timestamp: 1700000000,
  body: "feat: add feature",
  ...overrides,
});

describe("computeDominantAuthor", () => {
  it("returns author with most commits", () => {
    const commits = [
      makeCommit({ author: "alice", authorEmail: "a@x.com" }),
      makeCommit({ author: "alice", authorEmail: "a@x.com" }),
      makeCommit({ author: "bob", authorEmail: "b@x.com" }),
    ];
    const result = computeDominantAuthor(commits);
    expect(result.author).toBe("alice");
    expect(result.email).toBe("a@x.com");
    expect(result.pct).toBe(67);
    expect(result.authors).toEqual(["alice", "bob"]);
    expect(result.contributorCount).toBe(2);
  });

  it("returns unknown for empty commits", () => {
    const result = computeDominantAuthor([]);
    expect(result.author).toBe("unknown");
    expect(result.contributorCount).toBe(0);
  });
});

describe("computeTemporalMetrics", () => {
  it("computes age, timestamps, last commit hash", () => {
    const now = Date.now() / 1000;
    const commits = [
      makeCommit({ sha: "first", timestamp: now - 86400 * 30 }),
      makeCommit({ sha: "last", timestamp: now - 86400 }),
    ];
    const result = computeTemporalMetrics(commits);
    expect(result.lastCommitHash).toBe("last");
    expect(result.ageDays).toBe(1);
    expect(result.lastModifiedAt).toBeCloseTo(now - 86400, -1);
    expect(result.firstCreatedAt).toBeCloseTo(now - 86400 * 30, -1);
  });

  it("returns zeros for empty commits", () => {
    const result = computeTemporalMetrics([]);
    expect(result.ageDays).toBe(0);
    expect(result.lastCommitHash).toBe("");
  });
});

describe("computeRelativeChurn", () => {
  it("computes (added + deleted) / lineCount", () => {
    expect(computeRelativeChurn(100, 50, 200)).toBe(0.75);
  });

  it("returns 0 for zero lineCount", () => {
    expect(computeRelativeChurn(10, 5, 0)).toBe(0);
  });
});

describe("computeRecencyWeightedFreq", () => {
  it("sums exp(-0.1 * daysAgo) for each commit", () => {
    const now = Date.now() / 1000;
    const commits = [makeCommit({ timestamp: now })]; // 0 days ago
    const result = computeRecencyWeightedFreq(commits);
    expect(result).toBeCloseTo(1.0, 1);
  });
});

describe("computeChangeDensity", () => {
  it("computes commits / months", () => {
    const now = Date.now() / 1000;
    const commits = [
      makeCommit({ timestamp: now - 86400 * 60 }),
      makeCommit({ timestamp: now }),
    ];
    const result = computeChangeDensity(commits);
    expect(result).toBeCloseTo(1.0, 0); // 2 commits over ~2 months
  });
});

describe("computeChurnVolatility", () => {
  it("returns 0 for single commit", () => {
    expect(computeChurnVolatility([makeCommit()])).toBe(0);
  });

  it("returns 0 for equally spaced commits", () => {
    const commits = [
      makeCommit({ timestamp: 1000000 }),
      makeCommit({ timestamp: 1000000 + 86400 }),
      makeCommit({ timestamp: 1000000 + 86400 * 2 }),
    ];
    expect(computeChurnVolatility(commits)).toBe(0);
  });
});

describe("computeBugFixRate", () => {
  it("returns percentage of bug fix commits", () => {
    const commits = [
      makeCommit({ body: "fix: resolve bug" }),
      makeCommit({ body: "feat: add feature" }),
      makeCommit({ body: "fix: another bug" }),
      makeCommit({ body: "chore: cleanup" }),
    ];
    expect(computeBugFixRate(commits)).toBe(50);
  });
});

describe("extractAllTaskIds", () => {
  it("collects unique task IDs from all commits", () => {
    const commits = [
      makeCommit({ body: "feat: TD-123" }),
      makeCommit({ body: "fix: TD-456, TD-123" }),
    ];
    const result = extractAllTaskIds(commits);
    expect(result).toContain("TD-123");
    expect(result).toContain("TD-456");
    expect(result).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/trajectory/git/infra/metrics/extractors.test.ts`
Expected: FAIL — cannot resolve module

**Step 3: Write minimal implementation**

```typescript
// src/core/trajectory/git/infra/metrics/types.ts
export { type ChunkAccumulator } from "../metrics.js";
```

```typescript
// src/core/trajectory/git/infra/metrics/extractors.ts
/**
 * Pure metric extractor functions.
 *
 * Each function computes one metric family from commit data.
 * Stateless, no I/O — Strategy pattern for metric computation.
 */

import type { CommitInfo } from "../../../../adapters/git/types.js";
import { isBugFixCommit } from "../metrics.js";
import { extractTaskIds } from "../utils.js";

export interface AuthorshipResult {
  author: string;
  email: string;
  pct: number;
  authors: string[];
  contributorCount: number;
}

export interface TemporalResult {
  lastModifiedAt: number;
  firstCreatedAt: number;
  lastCommitHash: string;
  ageDays: number;
}

export function computeDominantAuthor(commits: CommitInfo[]): AuthorshipResult {
  if (commits.length === 0) {
    return {
      author: "unknown",
      email: "",
      pct: 0,
      authors: [],
      contributorCount: 0,
    };
  }
  const authorCounts = new Map<string, { count: number; email: string }>();
  for (const c of commits) {
    const existing = authorCounts.get(c.author);
    if (existing) {
      existing.count++;
    } else {
      authorCounts.set(c.author, { count: 1, email: c.authorEmail });
    }
  }
  let dominant = "";
  let dominantEmail = "";
  let maxCount = 0;
  for (const [author, data] of authorCounts) {
    if (data.count > maxCount) {
      maxCount = data.count;
      dominant = author;
      dominantEmail = data.email;
    }
  }
  return {
    author: dominant,
    email: dominantEmail,
    pct: Math.round((maxCount / commits.length) * 100),
    authors: Array.from(authorCounts.keys()),
    contributorCount: authorCounts.size,
  };
}

export function computeTemporalMetrics(commits: CommitInfo[]): TemporalResult {
  if (commits.length === 0) {
    return {
      lastModifiedAt: 0,
      firstCreatedAt: 0,
      lastCommitHash: "",
      ageDays: 0,
    };
  }
  const sorted = [...commits].sort((a, b) => a.timestamp - b.timestamp);
  const last = sorted[sorted.length - 1];
  const first = sorted[0];
  const nowSec = Date.now() / 1000;
  return {
    lastModifiedAt: last.timestamp,
    firstCreatedAt: first.timestamp,
    lastCommitHash: last.sha,
    ageDays: Math.max(0, Math.floor((nowSec - last.timestamp) / 86400)),
  };
}

export function computeRelativeChurn(
  linesAdded: number,
  linesDeleted: number,
  currentLineCount: number,
): number {
  const totalChurn = linesAdded + linesDeleted;
  const result = totalChurn / Math.max(currentLineCount, 1);
  return Math.round(result * 100) / 100;
}

export function computeRecencyWeightedFreq(commits: CommitInfo[]): number {
  const nowSec = Date.now() / 1000;
  const sum = commits.reduce((acc, c) => {
    const daysAgo = (nowSec - c.timestamp) / 86400;
    return acc + Math.exp(-0.1 * daysAgo);
  }, 0);
  return Math.round(sum * 100) / 100;
}

export function computeChangeDensity(commits: CommitInfo[]): number {
  if (commits.length === 0) return 0;
  const sorted = [...commits].sort((a, b) => a.timestamp - b.timestamp);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const spanMonths = Math.max(
    (last.timestamp - first.timestamp) / (86400 * 30),
    1,
  );
  return Math.round((commits.length / spanMonths) * 100) / 100;
}

export function computeChurnVolatility(commits: CommitInfo[]): number {
  if (commits.length <= 1) return 0;
  const sorted = [...commits].sort((a, b) => a.timestamp - b.timestamp);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i].timestamp - sorted[i - 1].timestamp) / 86400);
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance =
    gaps.reduce((sum, g) => sum + (g - mean) ** 2, 0) / gaps.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

export function computeBugFixRate(commits: CommitInfo[]): number {
  if (commits.length === 0) return 0;
  return Math.round(
    (commits.filter((c) => isBugFixCommit(c.body)).length / commits.length) *
      100,
  );
}

export function extractAllTaskIds(commits: CommitInfo[]): string[] {
  const allIds = new Set<string>();
  for (const c of commits) {
    for (const tid of extractTaskIds(c.body)) {
      allIds.add(tid);
    }
  }
  return Array.from(allIds);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/trajectory/git/infra/metrics/extractors.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/trajectory/git/infra/metrics/ tests/core/trajectory/git/infra/metrics/
git commit -m "feat: extract metric pure functions into extractors.ts"
```

---

## Task 4: Create file-level and chunk-level assemblers

Replace `computeFileMetadata()` and `computeChunkOverlay()` monoliths with
assemblers that call extractors.

**Files:**

- Create: `src/core/trajectory/git/infra/metrics/file-assembler.ts`
- Create: `src/core/trajectory/git/infra/metrics/chunk-assembler.ts`
- Test: `tests/core/trajectory/git/infra/metrics/file-assembler.test.ts`
- Test: `tests/core/trajectory/git/infra/metrics/chunk-assembler.test.ts`

**Step 1: Write the failing test for file assembler**

```typescript
// tests/core/trajectory/git/infra/metrics/file-assembler.test.ts
import { describe, expect, it } from "vitest";

import type { FileChurnData } from "../../../../../../src/core/adapters/git/types.js";
import { assembleFileMetadata } from "../../../../../../src/core/trajectory/git/infra/metrics/file-assembler.js";

describe("assembleFileMetadata", () => {
  it("composes all extractors into GitFileMetadata", () => {
    const now = Date.now() / 1000;
    const churnData: FileChurnData = {
      commits: [
        {
          sha: "a1",
          author: "alice",
          authorEmail: "a@x.com",
          timestamp: now - 86400 * 10,
          body: "feat: add",
        },
        {
          sha: "a2",
          author: "alice",
          authorEmail: "a@x.com",
          timestamp: now - 86400,
          body: "fix: bug",
        },
        {
          sha: "a3",
          author: "bob",
          authorEmail: "b@x.com",
          timestamp: now,
          body: "chore: cleanup",
        },
      ],
      linesAdded: 200,
      linesDeleted: 50,
    };
    const result = assembleFileMetadata(churnData, 300);

    expect(result.dominantAuthor).toBe("alice");
    expect(result.dominantAuthorEmail).toBe("a@x.com");
    expect(result.authors).toContain("alice");
    expect(result.authors).toContain("bob");
    expect(result.dominantAuthorPct).toBe(67);
    expect(result.commitCount).toBe(3);
    expect(result.linesAdded).toBe(200);
    expect(result.linesDeleted).toBe(50);
    expect(result.relativeChurn).toBeCloseTo(0.83, 1);
    expect(result.bugFixRate).toBe(33);
    expect(result.contributorCount).toBe(2);
    expect(result.lastCommitHash).toBe("a3");
  });

  it("returns zero-value metadata for empty commits", () => {
    const churnData: FileChurnData = {
      commits: [],
      linesAdded: 0,
      linesDeleted: 0,
    };
    const result = assembleFileMetadata(churnData, 100);
    expect(result.dominantAuthor).toBe("unknown");
    expect(result.commitCount).toBe(0);
    expect(result.bugFixRate).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/trajectory/git/infra/metrics/file-assembler.test.ts`
Expected: FAIL

**Step 3: Write file assembler**

```typescript
// src/core/trajectory/git/infra/metrics/file-assembler.ts
/**
 * File-level metadata assembler.
 *
 * Composes pure metric extractors into a complete GitFileMetadata object.
 * Replaces the monolithic computeFileMetadata() function.
 */

import type { FileChurnData } from "../../../../adapters/git/types.js";
import type { GitFileMetadata } from "../../types.js";
import {
  computeBugFixRate,
  computeChangeDensity,
  computeChurnVolatility,
  computeDominantAuthor,
  computeRecencyWeightedFreq,
  computeRelativeChurn,
  computeTemporalMetrics,
  extractAllTaskIds,
} from "./extractors.js";

export function assembleFileMetadata(
  churnData: FileChurnData,
  currentLineCount: number,
): GitFileMetadata {
  const { commits } = churnData;

  if (commits.length === 0) {
    return {
      dominantAuthor: "unknown",
      dominantAuthorEmail: "",
      authors: [],
      dominantAuthorPct: 0,
      lastModifiedAt: 0,
      firstCreatedAt: 0,
      lastCommitHash: "",
      ageDays: 0,
      commitCount: 0,
      linesAdded: churnData.linesAdded,
      linesDeleted: churnData.linesDeleted,
      relativeChurn: 0,
      recencyWeightedFreq: 0,
      changeDensity: 0,
      churnVolatility: 0,
      bugFixRate: 0,
      contributorCount: 0,
      taskIds: [],
    };
  }

  const authorship = computeDominantAuthor(commits);
  const temporal = computeTemporalMetrics(commits);

  return {
    dominantAuthor: authorship.author,
    dominantAuthorEmail: authorship.email,
    authors: authorship.authors,
    dominantAuthorPct: authorship.pct,
    lastModifiedAt: temporal.lastModifiedAt,
    firstCreatedAt: temporal.firstCreatedAt,
    lastCommitHash: temporal.lastCommitHash,
    ageDays: temporal.ageDays,
    commitCount: commits.length,
    linesAdded: churnData.linesAdded,
    linesDeleted: churnData.linesDeleted,
    relativeChurn: computeRelativeChurn(
      churnData.linesAdded,
      churnData.linesDeleted,
      currentLineCount,
    ),
    recencyWeightedFreq: computeRecencyWeightedFreq(commits),
    changeDensity: computeChangeDensity(commits),
    churnVolatility: computeChurnVolatility(commits),
    bugFixRate: computeBugFixRate(commits),
    contributorCount: authorship.contributorCount,
    taskIds: extractAllTaskIds(commits),
  };
}
```

**Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/trajectory/git/infra/metrics/file-assembler.test.ts`
Expected: PASS

**Step 5: Write chunk assembler test**

```typescript
// tests/core/trajectory/git/infra/metrics/chunk-assembler.test.ts
import { describe, expect, it } from "vitest";

import type { ChunkAccumulator } from "../../../../../../src/core/trajectory/git/infra/metrics.js";
import { assembleChunkOverlay } from "../../../../../../src/core/trajectory/git/infra/metrics/chunk-assembler.js";

describe("assembleChunkOverlay", () => {
  it("computes overlay from accumulator", () => {
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a", "b"]),
      authors: new Set(["alice"]),
      bugFixCount: 1,
      lastModifiedAt: Date.now() / 1000 - 86400,
      linesAdded: 20,
      linesDeleted: 5,
      commitTimestamps: [Date.now() / 1000 - 86400, Date.now() / 1000],
    };
    const result = assembleChunkOverlay(acc, 10, undefined, 50);
    expect(result.commitCount).toBe(2);
    expect(result.churnRatio).toBeCloseTo(0.2, 1);
    expect(result.contributorCount).toBe(1);
    expect(result.bugFixRate).toBe(50);
    expect(result.ageDays).toBeGreaterThanOrEqual(0);
    expect(result.relativeChurn).toBe(0.5); // 25/50
  });

  it("returns zero-value overlay for empty accumulator", () => {
    const acc: ChunkAccumulator = {
      commitShas: new Set(),
      authors: new Set(),
      bugFixCount: 0,
      lastModifiedAt: 0,
      linesAdded: 0,
      linesDeleted: 0,
      commitTimestamps: [],
    };
    const result = assembleChunkOverlay(acc, 10, undefined, 50);
    expect(result.commitCount).toBe(0);
    expect(result.churnRatio).toBe(0);
    expect(result.bugFixRate).toBe(0);
  });
});
```

**Step 6: Write chunk assembler**

```typescript
// src/core/trajectory/git/infra/metrics/chunk-assembler.ts
/**
 * Chunk-level overlay assembler.
 *
 * Replaces computeChunkOverlay() monolith with assembler pattern.
 */

import type { ChunkChurnOverlay } from "../../types.js";
import type { ChunkAccumulator } from "../metrics.js";

export function assembleChunkOverlay(
  acc: ChunkAccumulator,
  fileCommitCount: number,
  fileContributorCount?: number,
  chunkLineCount?: number,
): ChunkChurnOverlay {
  const nowSec = Date.now() / 1000;
  const commitCount = acc.commitShas.size;
  const totalCommitsForChunk = commitCount || 1;
  const totalChurn = acc.linesAdded + acc.linesDeleted;
  const lineCount = Math.max(chunkLineCount ?? 1, 1);

  const recencyWeightedFreq =
    acc.commitTimestamps.length > 0
      ? Math.round(
          acc.commitTimestamps.reduce((sum, ts) => {
            const daysAgo = (nowSec - ts) / 86400;
            return sum + Math.exp(-0.1 * daysAgo);
          }, 0) * 100,
        ) / 100
      : 0;

  let changeDensity = 0;
  if (acc.commitTimestamps.length > 0) {
    const minTs = Math.min(...acc.commitTimestamps);
    const maxTs = Math.max(...acc.commitTimestamps);
    const spanMonths = Math.max((maxTs - minTs) / (86400 * 30), 1);
    changeDensity =
      Math.round((acc.commitTimestamps.length / spanMonths) * 100) / 100;
  }

  return {
    commitCount,
    churnRatio:
      Math.round((commitCount / Math.max(fileCommitCount, 1)) * 100) / 100,
    contributorCount:
      fileContributorCount !== undefined
        ? Math.min(acc.authors.size, fileContributorCount)
        : acc.authors.size,
    bugFixRate:
      commitCount > 0
        ? Math.round((acc.bugFixCount / totalCommitsForChunk) * 100)
        : 0,
    lastModifiedAt: acc.lastModifiedAt,
    ageDays:
      acc.lastModifiedAt > 0
        ? Math.max(0, Math.floor((nowSec - acc.lastModifiedAt) / 86400))
        : 0,
    relativeChurn: Math.round((totalChurn / lineCount) * 100) / 100,
    recencyWeightedFreq,
    changeDensity,
  };
}
```

**Step 7: Run all assembler tests**

Run: `npx vitest run tests/core/trajectory/git/infra/metrics/` Expected: PASS

**Step 8: Commit**

```bash
git add src/core/trajectory/git/infra/metrics/ tests/core/trajectory/git/infra/metrics/
git commit -m "feat: add file and chunk assemblers using metric extractors"
```

---

## Task 5: Wire assemblers into consumers, deprecate old monoliths

Replace `computeFileMetadata()` and `computeChunkOverlay()` calls with assembler
calls. The old functions in `metrics.ts` become thin wrappers delegating to
assemblers.

**Files:**

- Modify: `src/core/trajectory/git/infra/metrics.ts` — delegate to assemblers
- Modify: `src/core/trajectory/git/infra/git-log-reader.ts` — update re-exports

**Step 1: Update `metrics.ts` to delegate**

```typescript
// In metrics.ts, replace computeFileMetadata body:
import { assembleChunkOverlay } from "./metrics/chunk-assembler.js";
import { assembleFileMetadata } from "./metrics/file-assembler.js";

export function computeFileMetadata(
  churnData: FileChurnData,
  currentLineCount: number,
): GitFileMetadata {
  return assembleFileMetadata(churnData, currentLineCount);
}

export function computeChunkOverlay(
  acc: ChunkAccumulator,
  fileCommitCount: number,
  fileContributorCount?: number,
  chunkLineCount?: number,
): ChunkChurnOverlay {
  return assembleChunkOverlay(
    acc,
    fileCommitCount,
    fileContributorCount,
    chunkLineCount,
  );
}
```

Keep `isBugFixCommit()`, `overlaps()`, and `ChunkAccumulator` in `metrics.ts` —
they are consumed directly by `chunk-reader.ts`.

**Step 2: Run full test suite for trajectory/git**

Run: `npx vitest run tests/core/trajectory/git/` Expected: PASS — all existing
tests still pass, behavior unchanged

**Step 3: Commit**

```bash
git add src/core/trajectory/git/infra/metrics.ts
git commit -m "refactor: delegate computeFileMetadata/computeChunkOverlay to assemblers"
```

---

## Task 6: Extract scorer helpers and create leaf scorer classes

Move helpers from `signals.ts` to `trajectory/git/scorers/_helpers.ts`. Create
14 scorer classes.

**Files:**

- Create: `src/core/trajectory/git/scorers/_helpers.ts`
- Create: `src/core/trajectory/git/scorers/recency.ts` (and 13 more)
- Create: `src/core/trajectory/git/scorers/index.ts`
- Test: `tests/core/trajectory/git/scorers/index.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/trajectory/git/scorers/index.test.ts
import { describe, expect, it } from "vitest";

import type { Scorer } from "../../../../../src/core/api/scorer.js";
import { gitScorers } from "../../../../../src/core/trajectory/git/scorers/index.js";

describe("git scorer classes", () => {
  it("exports array of 14 Scorer instances", () => {
    expect(Array.isArray(gitScorers)).toBe(true);
    expect(gitScorers).toHaveLength(14);
  });

  it("each scorer has required Scorer interface fields", () => {
    for (const s of gitScorers) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(typeof s.extract).toBe("function");
    }
  });

  it("each scorer is a class instance (not plain object)", () => {
    for (const s of gitScorers) {
      expect(s.constructor.name).not.toBe("Object");
    }
  });

  it("recency extracts from nested git.file.ageDays", () => {
    const recency = gitScorers.find((s) => s.name === "recency")!;
    expect(recency.extract({ git: { file: { ageDays: 0 } } })).toBe(1);
    expect(recency.extract({ git: { file: { ageDays: 365 } } })).toBe(0);
  });

  it("recency returns 1 when no git data (no backward compat)", () => {
    const recency = gitScorers.find((s) => s.name === "recency")!;
    expect(recency.extract({ git: { ageDays: 100 } })).toBe(1);
  });

  it("churn extracts commitCount normalized", () => {
    const churn = gitScorers.find((s) => s.name === "churn")!;
    expect(churn.extract({ git: { file: { commitCount: 50 } } })).toBe(1);
    expect(churn.extract({ git: { file: { commitCount: 0 } } })).toBe(0);
    expect(churn.extract({})).toBe(0);
  });

  it("ownership uses dominantAuthorPct when available", () => {
    const ownership = gitScorers.find((s) => s.name === "ownership")!;
    expect(
      ownership.extract({ git: { file: { dominantAuthorPct: 80 } } }),
    ).toBeCloseTo(0.8);
  });

  it("ownership falls back to 1/authors.length", () => {
    const ownership = gitScorers.find((s) => s.name === "ownership")!;
    expect(
      ownership.extract({ git: { file: { authors: ["a", "b"] } } }),
    ).toBeCloseTo(0.5);
    expect(ownership.extract({ git: { file: { authors: ["a"] } } })).toBe(1);
  });

  it("bugFix has needsConfidence=true and defaultBound=100", () => {
    const bugFix = gitScorers.find((s) => s.name === "bugFix")!;
    expect(bugFix.needsConfidence).toBe(true);
    expect(bugFix.defaultBound).toBe(100);
  });

  it("blockPenalty returns 1 for block chunks without chunk data", () => {
    const bp = gitScorers.find((s) => s.name === "blockPenalty")!;
    expect(bp.extract({ chunkType: "block" })).toBe(1);
    expect(bp.extract({ chunkType: "function" })).toBe(0);
  });

  it("blockPenalty returns 0 for block chunks with rich chunk data (alpha=1)", () => {
    const bp = gitScorers.find((s) => s.name === "blockPenalty")!;
    expect(
      bp.extract({
        chunkType: "block",
        git: { file: { commitCount: 10 }, chunk: { commitCount: 10 } },
      }),
    ).toBe(0);
  });

  it("chunkChurn extracts from git.chunk.commitCount", () => {
    const cc = gitScorers.find((s) => s.name === "chunkChurn")!;
    expect(cc.extract({ git: { chunk: { commitCount: 15 } } })).toBe(0.5);
    expect(cc.extract({ git: { chunk: { commitCount: 30 } } })).toBe(1);
  });

  it("knowledgeSilo returns 1 for single contributor, 0.5 for 2, 0 for 3+", () => {
    const ks = gitScorers.find((s) => s.name === "knowledgeSilo")!;
    expect(ks.extract({ git: { file: { contributorCount: 1 } } })).toBe(1);
    expect(ks.extract({ git: { file: { contributorCount: 2 } } })).toBe(0.5);
    expect(ks.extract({ git: { file: { contributorCount: 3 } } })).toBe(0);
  });

  it("burstActivity extracts recencyWeightedFreq", () => {
    const ba = gitScorers.find((s) => s.name === "burstActivity")!;
    expect(ba.extract({ git: { file: { recencyWeightedFreq: 10 } } })).toBe(1);
    expect(ba.extract({ git: { file: { recencyWeightedFreq: 5 } } })).toBe(0.5);
  });

  it("returns 0 for all scorers when payload is empty", () => {
    for (const s of gitScorers) {
      const val = s.extract({});
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it("scorers are assignable to Scorer interface", () => {
    const scorer: Scorer = gitScorers[0];
    expect(scorer.name).toBeTruthy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/trajectory/git/scorers/index.test.ts` Expected:
FAIL

**Step 3: Create `_helpers.ts`**

Copy helper functions from current `signals.ts`:

```typescript
// src/core/trajectory/git/scorers/_helpers.ts
/**
 * Shared payload accessor helpers for git scorers.
 */

interface GitLike {
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
  [key: string]: unknown;
}

function getGit(payload: Record<string, unknown>): GitLike | undefined {
  const { git } = payload;
  if (git && typeof git === "object") return git as GitLike;
  return undefined;
}

export function fileField(
  payload: Record<string, unknown>,
  field: string,
): unknown {
  const git = getGit(payload);
  if (!git) return undefined;
  if (git.file && typeof git.file === "object" && field in git.file) {
    return git.file[field];
  }
  return undefined;
}

export function fileNum(
  payload: Record<string, unknown>,
  field: string,
): number {
  const val = fileField(payload, field);
  return typeof val === "number" ? val : 0;
}

export function chunkNum(
  payload: Record<string, unknown>,
  field: string,
): number {
  const git = getGit(payload);
  if (!git) return 0;
  if (git.chunk && typeof git.chunk === "object" && field in git.chunk) {
    const val = git.chunk[field];
    return typeof val === "number" ? val : 0;
  }
  return 0;
}

export function hasChunkData(payload: Record<string, unknown>): boolean {
  const git = getGit(payload);
  if (!git) return false;
  if (git.chunk && typeof git.chunk === "object") {
    const { chunk } = git;
    return chunk.commitCount !== undefined;
  }
  return false;
}

export function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

export function computeAlpha(
  chunkCommitCount: number | undefined,
  fileCommitCount: number | undefined,
): number {
  if (chunkCommitCount === undefined || chunkCommitCount <= 0) return 0;
  if (fileCommitCount === undefined || fileCommitCount <= 0) return 0;
  return Math.min(1, chunkCommitCount / fileCommitCount);
}
```

**Step 4: Create 14 scorer classes**

Each scorer class in its own file, all following the same pattern. Example for
`recency.ts`:

```typescript
// src/core/trajectory/git/scorers/recency.ts
import type { Scorer } from "../../../api/scorer.js";
import { fileNum, normalize } from "./_helpers.js";

export class RecencyScorer implements Scorer {
  readonly name = "recency";
  readonly description =
    "Inverse of age: recently modified code scores higher (1 - ageDays/365)";
  readonly defaultBound = 365;

  extract(payload: Record<string, unknown>): number {
    return 1 - normalize(fileNum(payload, "ageDays"), this.defaultBound);
  }
}
```

Create all 14: `recency.ts`, `stability.ts`, `churn.ts`, `age.ts`,
`ownership.ts`, `bug-fix.ts`, `volatility.ts`, `density.ts`, `chunk-churn.ts`,
`relative-churn.ts`, `burst-activity.ts`, `knowledge-silo.ts`,
`chunk-relative-churn.ts`, `block-penalty.ts`.

Each mirrors the exact `extract()` logic from the current object literal in
`signals.ts`.

**Step 5: Create `index.ts`**

```typescript
// src/core/trajectory/git/scorers/index.ts
import type { Scorer } from "../../../api/scorer.js";
import { AgeScorer } from "./age.js";
import { BlockPenaltyScorer } from "./block-penalty.js";
import { BugFixScorer } from "./bug-fix.js";
import { BurstActivityScorer } from "./burst-activity.js";
import { ChunkChurnScorer } from "./chunk-churn.js";
import { ChunkRelativeChurnScorer } from "./chunk-relative-churn.js";
import { ChurnScorer } from "./churn.js";
import { DensityScorer } from "./density.js";
import { KnowledgeSiloScorer } from "./knowledge-silo.js";
import { OwnershipScorer } from "./ownership.js";
import { RecencyScorer } from "./recency.js";
import { RelativeChurnScorer } from "./relative-churn.js";
import { StabilityScorer } from "./stability.js";
import { VolatilityScorer } from "./volatility.js";

export const gitScorers: Scorer[] = [
  new RecencyScorer(),
  new StabilityScorer(),
  new ChurnScorer(),
  new AgeScorer(),
  new OwnershipScorer(),
  new BugFixScorer(),
  new VolatilityScorer(),
  new DensityScorer(),
  new ChunkChurnScorer(),
  new RelativeChurnScorer(),
  new BurstActivityScorer(),
  new KnowledgeSiloScorer(),
  new ChunkRelativeChurnScorer(),
  new BlockPenaltyScorer(),
];
```

**Step 6: Run test to verify it passes**

Run: `npx vitest run tests/core/trajectory/git/scorers/index.test.ts` Expected:
PASS

**Step 7: Commit**

```bash
git add src/core/trajectory/git/scorers/ tests/core/trajectory/git/scorers/
git commit -m "feat: create 14 leaf scorer classes in trajectory/git/scorers/"
```

---

## Task 7: Rename `fields.ts` → `signals.ts` and create git contract

Rename `fields.ts` → `signals.ts` (payload field descriptions are signal
definitions). Create `contract.ts` composing all parts. Move git presets from
reranker.

**Files:**

- Rename: `src/core/trajectory/git/fields.ts` →
  `src/core/trajectory/git/signals.ts`
- Create: `src/core/trajectory/git/contract.ts`
- Modify: `tests/core/trajectory/git/filters.test.ts` — update import
- Test: `tests/core/trajectory/git/contract.test.ts`

**Step 1: Rename `fields.ts` → `signals.ts`**

```bash
git mv src/core/trajectory/git/fields.ts src/core/trajectory/git/signals.ts
```

Update all imports: `filters.test.ts` imports `gitPayloadFields` from
`fields.js` → `signals.js`.

**Step 2: Write git contract test**

```typescript
// tests/core/trajectory/git/contract.test.ts
import { describe, expect, it } from "vitest";

import { gitContract } from "../../../../src/core/trajectory/git/contract.js";

describe("gitContract", () => {
  it("has 14 scorers", () => {
    expect(gitContract.scorers).toHaveLength(14);
  });

  it("has 7 filters", () => {
    expect(gitContract.filters).toHaveLength(7);
  });

  it("has payload fields for file and chunk levels", () => {
    const fileFields = gitContract.payloadFields.filter((f) =>
      f.key.startsWith("git.file."),
    );
    const chunkFields = gitContract.payloadFields.filter((f) =>
      f.key.startsWith("git.chunk."),
    );
    expect(fileFields.length).toBeGreaterThan(0);
    expect(chunkFields.length).toBeGreaterThan(0);
  });

  it("has presets including techDebt and hotspots", () => {
    expect(gitContract.presets.techDebt).toBeDefined();
    expect(gitContract.presets.hotspots).toBeDefined();
    expect(gitContract.presets.relevance).toBeDefined();
  });

  it("satisfies TrajectoryQueryContract interface", () => {
    expect(gitContract.scorers).toBeDefined();
    expect(gitContract.filters).toBeDefined();
    expect(gitContract.presets).toBeDefined();
    expect(gitContract.payloadFields).toBeDefined();
  });
});
```

**Step 3: Create git contract**

```typescript
// src/core/trajectory/git/contract.ts
/**
 * Git trajectory query contract.
 *
 * Composes git scorers, filters, presets, and payload field docs
 * into a single TrajectoryQueryContract for registry registration.
 */

import type { TrajectoryQueryContract } from "../types.js";
import { gitFilters } from "./filters.js";
import { gitPresets } from "./presets.js";
import { gitScorers } from "./scorers/index.js";
import { gitPayloadFields } from "./signals.js";

export const gitContract: TrajectoryQueryContract = {
  scorers: gitScorers,
  filters: gitFilters,
  presets: gitPresets,
  payloadFields: gitPayloadFields,
};
```

**Step 4: Extract git presets from reranker**

Create `src/core/trajectory/git/presets.ts` with the git-owned preset weights
(moved from `reranker.ts`):

```typescript
// src/core/trajectory/git/presets.ts
/**
 * Git-owned rerank presets.
 *
 * These weight configurations are registered via the git contract.
 * Composite scorers may override preset names at the API layer.
 */

import type { ScoringWeights } from "../types.js";

export const gitPresets: Record<string, ScoringWeights> = {
  relevance: { similarity: 1.0 },

  techDebt: {
    similarity: 0.2,
    age: 0.15,
    churn: 0.15,
    bugFix: 0.15,
    volatility: 0.1,
    knowledgeSilo: 0.1,
    density: 0.1,
    blockPenalty: -0.05,
  },

  hotspots: {
    similarity: 0.25,
    chunkChurn: 0.15,
    chunkRelativeChurn: 0.15,
    burstActivity: 0.15,
    bugFix: 0.15,
    volatility: 0.15,
    blockPenalty: -0.15,
  },

  codeReview: {
    similarity: 0.35,
    recency: 0.15,
    burstActivity: 0.15,
    density: 0.15,
    chunkChurn: 0.2,
    blockPenalty: -0.1,
  },

  onboarding: {
    similarity: 0.4,
    documentation: 0.3,
    stability: 0.3,
  },

  securityAudit: {
    similarity: 0.3,
    age: 0.15,
    ownership: 0.1,
    bugFix: 0.15,
    pathRisk: 0.15,
    volatility: 0.15,
  },

  refactoring: {
    similarity: 0.2,
    chunkChurn: 0.15,
    relativeChurnNorm: 0.15,
    chunkSize: 0.15,
    volatility: 0.15,
    bugFix: 0.1,
    age: 0.1,
    blockPenalty: -0.1,
  },

  ownership: {
    similarity: 0.4,
    ownership: 0.35,
    knowledgeSilo: 0.25,
  },

  impactAnalysis: {
    similarity: 0.5,
    imports: 0.5,
  },

  // search_code presets
  recent: {
    similarity: 0.7,
    recency: 0.3,
  },

  stable: {
    similarity: 0.7,
    stability: 0.3,
  },
};
```

**Step 5: Run tests**

Run: `npx vitest run tests/core/trajectory/git/` Expected: PASS

**Step 6: Commit**

```bash
git add src/core/trajectory/git/signals.ts src/core/trajectory/git/contract.ts \
  src/core/trajectory/git/presets.ts \
  tests/core/trajectory/git/contract.test.ts tests/core/trajectory/git/filters.test.ts
git commit -m "feat: create git contract with presets, rename fields.ts → signals.ts"
```

---

## Task 8: Add `registerComposites()` to TrajectoryRegistry

**Files:**

- Modify: `src/core/api/trajectory-registry.ts`
- Modify: `tests/core/api/trajectory-registry.test.ts`

**Step 1: Write the failing test**

Add to existing test file:

```typescript
// Additional tests in tests/core/api/trajectory-registry.test.ts
import type { CompositeScorer, Scorer } from "../../../src/core/api/scorer.js";

describe("registerComposites", () => {
  it("registers composite scorers that override same-named leafs", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract); // has "recency" and "churn" leaf scorers
    const composite: CompositeScorer = {
      name: "recency", // same name as leaf
      description: "Composite recency",
      dependencies: ["churn"],
      bind: () => {},
      extract: () => 0.99,
    };
    registry.registerComposites([composite]);
    const all = registry.getAllScorers();
    const recencyScorers = all.filter((s) => s.name === "recency");
    // Composite should replace the leaf
    expect(recencyScorers).toHaveLength(1);
    expect(recencyScorers[0].extract({})).toBe(0.99);
  });

  it("calls bind() with resolved dependencies", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract);
    let boundScorers: Map<string, Scorer> | undefined;
    const composite: CompositeScorer = {
      name: "techDebt",
      description: "Tech debt composite",
      dependencies: ["recency", "churn"],
      bind(scorers) {
        boundScorers = scorers;
      },
      extract: () => 0.5,
    };
    registry.registerComposites([composite]);
    expect(boundScorers).toBeDefined();
    expect(boundScorers!.has("recency")).toBe(true);
    expect(boundScorers!.has("churn")).toBe(true);
  });

  it("throws on duplicate leaf scorer names across trajectories", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", mockContract); // has "recency"
    const dupContract = {
      ...mockContract,
      scorers: [{ name: "recency", description: "Dup", extract: () => 0 }],
    };
    expect(() => registry.register("graph", dupContract)).toThrow(
      /duplicate.*recency/i,
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/trajectory-registry.test.ts` Expected: FAIL
— `registerComposites` not found, no duplicate check

**Step 3: Implement**

Update `TrajectoryRegistry`:

```typescript
// In trajectory-registry.ts, add:
import type { CompositeScorer, Scorer } from "./scorer.js";

// Add private state:
private leafScorers = new Map<string, Scorer>();
private compositeScorers = new Map<string, CompositeScorer>();

// Update register() to check leaf uniqueness:
register(key: string, contract: TrajectoryQueryContract): void {
  // Check leaf scorer name uniqueness
  for (const scorer of contract.scorers) {
    if (this.leafScorers.has(scorer.name)) {
      throw new Error(`Duplicate leaf scorer name: "${scorer.name}" (already registered)`);
    }
  }
  this.contracts.set(key, contract);
  for (const scorer of contract.scorers) {
    this.leafScorers.set(scorer.name, scorer);
  }
}

// Add registerComposites():
registerComposites(composites: CompositeScorer[]): void {
  for (const cs of composites) {
    this.compositeScorers.set(cs.name, cs);
    // Resolve and bind dependencies
    const deps = new Map<string, Scorer>();
    for (const depName of cs.dependencies) {
      const leaf = this.leafScorers.get(depName);
      if (leaf) deps.set(depName, leaf);
    }
    cs.bind(deps);
  }
}

// Update getAllScorers() to return composites overriding leafs:
getAllScorers(): Scorer[] {
  const result = new Map<string, Scorer>();
  for (const [name, scorer] of this.leafScorers) {
    result.set(name, scorer);
  }
  for (const [name, scorer] of this.compositeScorers) {
    result.set(name, scorer); // override leaf
  }
  return Array.from(result.values());
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/api/trajectory-registry.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/core/api/trajectory-registry.ts tests/core/api/trajectory-registry.test.ts
git commit -m "feat: add registerComposites() with leaf uniqueness and dep binding"
```

---

## Task 9: Create composite scorer implementations

**Files:**

- Create: `src/core/search/scorers/tech-debt.ts`
- Create: `src/core/search/scorers/hotspot.ts`
- Create: `src/core/api/scorers.ts` — factory for composite scorers
- Test: `tests/core/search/scorers/tech-debt.test.ts`
- Test: `tests/core/search/scorers/hotspot.test.ts`
- Test: `tests/core/api/scorers.test.ts`

**Step 1: Write failing test for TechDebtScorer**

```typescript
// tests/core/search/scorers/tech-debt.test.ts
import { describe, expect, it } from "vitest";

import type { Scorer } from "../../../../src/core/api/scorer.js";
import { TechDebtScorer } from "../../../../src/core/search/scorers/tech-debt.js";

describe("TechDebtScorer", () => {
  it("implements CompositeScorer", () => {
    const scorer = new TechDebtScorer();
    expect(scorer.name).toBe("techDebt");
    expect(scorer.dependencies).toContain("age");
    expect(scorer.dependencies).toContain("churn");
  });

  it("returns 0 before bind()", () => {
    const scorer = new TechDebtScorer();
    expect(scorer.extract({})).toBe(0);
  });

  it("combines age and churn after bind()", () => {
    const scorer = new TechDebtScorer();
    const mockAge: Scorer = {
      name: "age",
      description: "",
      extract: () => 0.8,
    };
    const mockChurn: Scorer = {
      name: "churn",
      description: "",
      extract: () => 0.6,
    };
    scorer.bind(
      new Map([
        ["age", mockAge],
        ["churn", mockChurn],
      ]),
    );
    const result = scorer.extract({});
    // 0.4 * 0.8 + 0.6 * 0.6 = 0.32 + 0.36 = 0.68
    expect(result).toBeCloseTo(0.68, 2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/search/scorers/tech-debt.test.ts` Expected: FAIL

**Step 3: Write TechDebtScorer**

```typescript
// src/core/search/scorers/tech-debt.ts
import type { CompositeScorer, Scorer } from "../../api/scorer.js";

export class TechDebtScorer implements CompositeScorer {
  readonly name = "techDebt";
  readonly description = "Technical debt: combines age and churn signals";
  readonly dependencies = ["age", "churn"];

  private sources = new Map<string, Scorer>();

  bind(scorers: Map<string, Scorer>): void {
    this.sources = scorers;
  }

  extract(payload: Record<string, unknown>): number {
    const age = this.sources.get("age")?.extract(payload) ?? 0;
    const churn = this.sources.get("churn")?.extract(payload) ?? 0;
    return age * 0.4 + churn * 0.6;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/search/scorers/tech-debt.test.ts` Expected: PASS

**Step 5: Write HotspotScorer (same pattern)**

```typescript
// src/core/search/scorers/hotspot.ts
import type { CompositeScorer, Scorer } from "../../api/scorer.js";

export class HotspotScorer implements CompositeScorer {
  readonly name = "hotspot";
  readonly description =
    "Bug hunting hotspot: combines churn, bug fix rate, and recency";
  readonly dependencies = ["churn", "bugFix", "burstActivity"];

  private sources = new Map<string, Scorer>();

  bind(scorers: Map<string, Scorer>): void {
    this.sources = scorers;
  }

  extract(payload: Record<string, unknown>): number {
    const churn = this.sources.get("churn")?.extract(payload) ?? 0;
    const bugFix = this.sources.get("bugFix")?.extract(payload) ?? 0;
    const burst = this.sources.get("burstActivity")?.extract(payload) ?? 0;
    return churn * 0.4 + bugFix * 0.3 + burst * 0.3;
  }
}
```

Write corresponding test.

**Step 6: Create `api/scorers.ts` factory**

```typescript
// src/core/api/scorers.ts
/**
 * Composite scorer factory.
 *
 * Returns all cross-trajectory composite scorers for registry registration.
 * This is the API layer's single point for composite scorer creation —
 * no bootstrap files, no scattered instantiation.
 */

import { HotspotScorer } from "../search/scorers/hotspot.js";
import { TechDebtScorer } from "../search/scorers/tech-debt.js";
import type { CompositeScorer } from "./scorer.js";

export function createCompositeScorers(): CompositeScorer[] {
  return [new TechDebtScorer(), new HotspotScorer()];
}
```

**Step 7: Write factory test**

```typescript
// tests/core/api/scorers.test.ts
import { describe, expect, it } from "vitest";

import { createCompositeScorers } from "../../../src/core/api/scorers.js";

describe("createCompositeScorers", () => {
  it("returns composite scorer instances", () => {
    const composites = createCompositeScorers();
    expect(composites.length).toBeGreaterThanOrEqual(2);
    const names = composites.map((c) => c.name);
    expect(names).toContain("techDebt");
    expect(names).toContain("hotspot");
  });

  it("each composite has dependencies and bind()", () => {
    for (const cs of createCompositeScorers()) {
      expect(cs.dependencies.length).toBeGreaterThan(0);
      expect(typeof cs.bind).toBe("function");
    }
  });
});
```

**Step 8: Run tests**

Run: `npx vitest run tests/core/search/scorers/ tests/core/api/scorers.test.ts`
Expected: PASS

**Step 9: Commit**

```bash
git add src/core/search/scorers/ src/core/api/scorers.ts \
  tests/core/search/scorers/ tests/core/api/scorers.test.ts
git commit -m "feat: add TechDebtScorer, HotspotScorer, and createCompositeScorers factory"
```

---

## Task 10: Delete old `signals.ts` (object literals), update consumers

Replace old `trajectory/git/signals.ts` (14 object literals) with the new
class-based scorers from `trajectory/git/scorers/`. The file
`trajectory/git/signals.ts` already holds `gitPayloadFields` (renamed from
fields.ts in Task 7), so only the old `gitSignals`/`gitScorers` export needs to
be removed from wherever it still lives.

**Files:**

- Delete: old object-literal signal code from
  `src/core/trajectory/git/signals.ts` (keep only `gitPayloadFields`)
- Modify: `tests/core/trajectory/git/signals.test.ts` — either delete or
  redirect to scorers tests
- Modify: any remaining consumer imports

**Step 1: Verify no production code imports old `gitSignals`/`gitScorers` from
`trajectory/git/signals.ts`**

The only production consumer should be the git contract (`contract.ts`), which
imports from `scorers/index.ts`. If old imports remain, update them.

**Step 2: Remove deprecated re-exports**

Clean up `trajectory/git/signals.ts` to only export `gitPayloadFields`.

**Step 3: Delete or update old test**

Delete `tests/core/trajectory/git/signals.test.ts` — it's fully superseded by
`tests/core/trajectory/git/scorers/index.test.ts`.

**Step 4: Run full test suite**

Run: `npx vitest run` Expected: PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove old object-literal signals, all scoring via scorer classes

BREAKING CHANGE: gitSignals export removed, use gitScorers from scorers/index"
```

---

## Task 11: Final integration test

Verify end-to-end: git contract → registry → composites → getAllScorers().

**Files:**

- Test: `tests/core/api/scorer-integration.test.ts`

**Step 1: Write integration test**

```typescript
// tests/core/api/scorer-integration.test.ts
import { describe, expect, it } from "vitest";

import { createCompositeScorers } from "../../../src/core/api/scorers.js";
import { TrajectoryRegistry } from "../../../src/core/api/trajectory-registry.js";
import { gitContract } from "../../../src/core/trajectory/git/contract.js";

describe("Scorer integration", () => {
  it("registers git contract and composites end-to-end", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", gitContract);
    registry.registerComposites(createCompositeScorers());

    const scorers = registry.getAllScorers();
    const names = scorers.map((s) => s.name);

    // 14 git leaf scorers + 2 composites (may override some)
    expect(names).toContain("recency");
    expect(names).toContain("churn");
    expect(names).toContain("techDebt");
    expect(names).toContain("hotspot");
  });

  it("composites extract from payload using bound leaf scorers", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", gitContract);
    registry.registerComposites(createCompositeScorers());

    const techDebt = registry
      .getAllScorers()
      .find((s) => s.name === "techDebt")!;
    const payload = { git: { file: { ageDays: 365, commitCount: 50 } } };
    const score = techDebt.extract(payload);
    // age=1.0, churn=1.0 → 0.4*1 + 0.6*1 = 1.0
    expect(score).toBeCloseTo(1.0, 1);
  });

  it("presets come from git contract", () => {
    const registry = new TrajectoryRegistry();
    registry.register("git", gitContract);
    const presets = registry.getAllPresets();
    expect(presets.techDebt).toBeDefined();
    expect(presets.hotspots).toBeDefined();
    expect(presets.recent).toBeDefined();
    expect(presets.stable).toBeDefined();
  });
});
```

**Step 2: Run test**

Run: `npx vitest run tests/core/api/scorer-integration.test.ts` Expected: PASS

**Step 3: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

**Step 4: Commit**

```bash
git add tests/core/api/scorer-integration.test.ts
git commit -m "test: add end-to-end scorer integration test"
```

---

## Summary of file changes

### Created

- `src/core/api/scorer.ts` — Scorer + CompositeScorer interfaces
- `src/core/api/scorers.ts` — createCompositeScorers() factory
- `src/core/trajectory/git/infra/metrics/extractors.ts` — pure metric functions
- `src/core/trajectory/git/infra/metrics/file-assembler.ts` — file metadata
  assembler
- `src/core/trajectory/git/infra/metrics/chunk-assembler.ts` — chunk overlay
  assembler
- `src/core/trajectory/git/infra/metrics/types.ts` — re-export ChunkAccumulator
- `src/core/trajectory/git/scorers/*.ts` — 14 leaf scorer classes + helpers +
  index
- `src/core/trajectory/git/contract.ts` — git query contract
- `src/core/trajectory/git/presets.ts` — git-owned rerank presets
- `src/core/search/scorers/tech-debt.ts` — TechDebtScorer composite
- `src/core/search/scorers/hotspot.ts` — HotspotScorer composite

### Renamed

- `src/core/trajectory/git/fields.ts` → `src/core/trajectory/git/signals.ts`

### Modified

- `src/core/trajectory/types.ts` — SignalDescriptor → Scorer, signals → scorers
- `src/core/api/trajectory-registry.ts` — getAllScorers(), registerComposites(),
  leaf uniqueness
- `src/core/trajectory/git/infra/metrics.ts` — delegates to assemblers

### Deleted

- Old object-literal signal code from `trajectory/git/signals.ts`

### Not changed (deferred to separate tasks)

- `src/core/search/reranker.ts` — refactoring to use registry scorers is
  `tea-rags-mcp-7w4`
- `src/mcp/tools/schemas.ts` — dynamic schema from registry is
  `tea-rags-mcp-d56`
