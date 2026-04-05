# bugFixRate Accuracy Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three P1 bugs in bugFixRate signal: false-positive classification
(tea-rags-mcp-6130), small sample unreliability (tea-rags-mcp-2xeb), and chunk
line drift attribution (tea-rags-mcp-fek8).

**Architecture:** Three-layer fix. Layer 1 — improve commit classification by
adding merge-branch-prefix propagation to child commits (single-pass via `%P` in
git log format) plus stricter subject-line patterns with cosmetic exclusion.
Layer 2 — raise dampening FALLBACK_THRESHOLD (k=8→10) to reduce noise from small
samples. Layer 3 — fix chunk line drift by adding offset tracking to
chunk-reader (two-phase: parallel blob reads, sequential per-file mapping).

**Tech Stack:** TypeScript, Vitest, git CLI

---

## File Structure

| Action | File                                                                      | Responsibility                                         |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| Modify | `src/core/adapters/git/client.ts`                                         | Add `%P` (parents) to git log format string            |
| Modify | `src/core/adapters/git/types.ts`                                          | Add `parents: string[]` to `CommitInfo`                |
| Modify | `src/core/adapters/git/parsers.ts`                                        | Parse `%P` field, populate `CommitInfo.parents`        |
| Create | `src/core/domains/trajectory/git/infra/merge-branch-resolver.ts`          | Build `childSha → branchPrefix` map from merge graph   |
| Modify | `src/core/domains/trajectory/git/infra/metrics.ts`                        | Rewrite `isBugFixCommit()` with strict patterns        |
| Modify | `src/core/domains/trajectory/git/infra/file-reader.ts`                    | Call merge-branch-resolver, pass map to classification |
| Modify | `src/core/domains/trajectory/git/infra/chunk-reader.ts`                   | Use resolved isBugFix from merge map                   |
| Modify | `src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.ts`       | Raise FALLBACK_THRESHOLD 8→10                          |
| Create | `src/core/domains/trajectory/git/infra/offset-tracker.ts`                 | Per-file chunk range offset tracking for drift fix     |
| Modify | `tests/core/domains/trajectory/git/infra/git-log-reader.test.ts`          | Update isBugFixCommit tests for new patterns           |
| Create | `tests/core/domains/trajectory/git/infra/merge-branch-resolver.test.ts`   | Tests for merge graph traversal                        |
| Create | `tests/core/domains/trajectory/git/infra/offset-tracker.test.ts`          | Tests for offset tracking algorithm                    |
| Modify | `tests/core/domains/trajectory/git/derived-signals/confidence.test.ts`    | Update BugFixSignal threshold tests                    |
| Modify | `tests/core/domains/trajectory/git/infra/metrics/chunk-assembler.test.ts` | Update Laplace smoothing expected values               |

---

## Task 1: Add `parents` to CommitInfo and git log format

**Files:**

- Modify: `src/core/adapters/git/types.ts:16-21`
- Modify: `src/core/adapters/git/client.ts:57`
- Modify: `src/core/adapters/git/parsers.ts:12-64`
- Test: `tests/core/domains/trajectory/git/infra/git-log-reader.test.ts`

### Step 1: Write failing test — parser extracts parents

- [ ] Add test in
      `tests/core/domains/trajectory/git/infra/git-log-reader.test.ts`:

```typescript
describe("parseNumstatOutput — parent parsing", () => {
  it("should parse parent SHAs from %P field", () => {
    const sha = "a".repeat(40);
    const parent1 = "b".repeat(40);
    const parent2 = "c".repeat(40);
    // Format: \0SHA\0PARENTS\0author\0email\0timestamp\0body\0numstat
    const stdout = [
      "",
      sha,
      `${parent1} ${parent2}`, // two parents = merge commit
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "Merge branch 'fix/TD-123' into 'master'",
      "10\t5\tapp/models/user.rb",
    ].join("\0");
    const result = parseNumstatOutput(stdout);
    const commits = result.get("app/models/user.rb")!.commits;
    expect(commits[0].parents).toEqual([parent1, parent2]);
  });

  it("should parse single parent for non-merge commits", () => {
    const sha = "a".repeat(40);
    const parent = "b".repeat(40);
    const stdout = [
      "",
      sha,
      parent,
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "[TD-456] Fix validation",
      "3\t1\tapp/services/auth.rb",
    ].join("\0");
    const result = parseNumstatOutput(stdout);
    const commits = result.get("app/services/auth.rb")!.commits;
    expect(commits[0].parents).toEqual([parent]);
  });

  it("should handle root commit with no parents", () => {
    const sha = "a".repeat(40);
    const stdout = [
      "",
      sha,
      "", // empty parents = root commit
      "Alice",
      "alice@example.com",
      String(Math.floor(Date.now() / 1000)),
      "Initial commit",
      "1\t0\tREADME.md",
    ].join("\0");
    const result = parseNumstatOutput(stdout);
    const commits = result.get("README.md")!.commits;
    expect(commits[0].parents).toEqual([]);
  });
});
```

- [ ] Run:
      `npx vitest run tests/core/domains/trajectory/git/infra/git-log-reader.test.ts`
- [ ] Expected: FAIL — `parents` property does not exist on CommitInfo

### Step 2: Add `parents` field to CommitInfo

- [ ] Modify `src/core/adapters/git/types.ts`:

```typescript
export interface CommitInfo {
  sha: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  body: string;
  parents: string[]; // NEW: parent SHAs from %P
}
```

### Step 3: Add `%P` to git log format

- [ ] Modify `src/core/adapters/git/client.ts` — `buildCliArgs()`:

```typescript
export function buildCliArgs(sinceDate?: Date): string[] {
  const args = [
    "log",
    "HEAD",
    "--numstat",
    "--format=%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%B%x00",
  ];
  if (sinceDate) {
    args.push(`--since=${sinceDate.toISOString()}`);
  }
  return args;
}
```

- [ ] Also update the pathspec format in `getCommitsByPathspecSingle()`:

```typescript
const args = [
  "log",
  `--since=${sinceDate.toISOString()}`,
  "--format=%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%B%x00",
  "--numstat",
  "--",
  ...filePaths,
];
```

### Step 4: Update both parsers to extract parents

- [ ] Modify `src/core/adapters/git/parsers.ts` — `parseNumstatOutput()`:

The current field order is: SHA, author, email, timestamp, body. New order: SHA,
parents, author, email, timestamp, body. Field count goes from 5 to 6.

```typescript
export function parseNumstatOutput(stdout: string): Map<string, FileChurnData> {
  const fileMap = new Map<string, FileChurnData>();
  const sections = stdout.split("\0");
  let i = 0;

  while (i < sections.length) {
    if (!sections[i]?.trim()) {
      i++;
      continue;
    }

    const sha = sections[i]?.trim();
    if (sha?.length !== 40 || !/^[a-f0-9]+$/.test(sha)) {
      i++;
      continue;
    }

    const parentsRaw = sections[i + 1] || "";
    const parents = parentsRaw.trim() ? parentsRaw.trim().split(" ") : [];
    const author = sections[i + 2] || "";
    const email = sections[i + 3] || "";
    const timestamp = parseInt(sections[i + 4] || "0", 10);
    const body = sections[i + 5] || "";
    i += 6;

    const commitInfo: CommitInfo = {
      sha,
      author,
      authorEmail: email,
      timestamp,
      body,
      parents,
    };

    const numstatSection = sections[i] || "";
    i++;

    for (const line of numstatSection.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;

      const added = parseInt(parts[0], 10);
      const deleted = parseInt(parts[1], 10);
      const filePath = parts[2];

      if (isNaN(added) || isNaN(deleted)) continue;

      let entry = fileMap.get(filePath);
      if (!entry) {
        entry = { commits: [], linesAdded: 0, linesDeleted: 0 };
        fileMap.set(filePath, entry);
      }
      entry.commits.push(commitInfo);
      entry.linesAdded += added;
      entry.linesDeleted += deleted;
    }
  }

  return fileMap;
}
```

- [ ] Analogous change to `parsePathspecOutput()` — same field shift (+1 for
      parents at index i+1, author at i+2, etc.), add `parents` to CommitInfo
      construction.

### Step 5: Fix all existing tests that construct CommitInfo

- [ ] Add `parents: []` to every `makeCommit()` helper and any raw CommitInfo
      construction in existing tests. Search for `CommitInfo` across test files
      and update.

### Step 6: Run tests

- [ ] Run: `npx vitest run`
- [ ] Expected: ALL PASS — parser tests pass with new format, existing tests
      pass with `parents: []` defaults

### Step 7: Commit

```bash
git add src/core/adapters/git/types.ts src/core/adapters/git/client.ts \
  src/core/adapters/git/parsers.ts tests/
git commit -m "feat(git): add parent SHAs to CommitInfo via %P in git log format

Enables merge-commit-to-child propagation for bugFixRate accuracy.
Part of tea-rags-mcp-6130."
```

---

## Task 2: Build merge-branch-resolver (parent graph → child SHA map)

**Files:**

- Create: `src/core/domains/trajectory/git/infra/merge-branch-resolver.ts`
- Create:
  `tests/core/domains/trajectory/git/infra/merge-branch-resolver.test.ts`

### Step 1: Write failing tests

- [ ] Create
      `tests/core/domains/trajectory/git/infra/merge-branch-resolver.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type { CommitInfo } from "../../../../../../src/core/adapters/git/types.js";
import { buildBugFixShaSet } from "../../../../../../src/core/domains/trajectory/git/infra/merge-branch-resolver.js";

function commit(sha: string, parents: string[], body: string): CommitInfo {
  return {
    sha,
    author: "A",
    authorEmail: "a@a.com",
    timestamp: 0,
    body,
    parents,
  };
}

describe("buildBugFixShaSet", () => {
  it("marks child of fix/ merge as bug fix", () => {
    // M merges child C from fix/ branch
    const M = commit(
      "m000",
      ["base", "c000"],
      "Merge branch 'fix/TD-123-bug' into 'master'",
    );
    const C = commit("c000", ["base"], "[TD-123] Restore sorting param");
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(true);
    expect(result.has("m000")).toBe(false); // merge itself not marked
  });

  it("marks child of hotfix/ merge as bug fix", () => {
    const M = commit(
      "m000",
      ["base", "c000"],
      "Merge branch 'hotfix/urgent-patch' into 'master'",
    );
    const C = commit("c000", ["base"], "[HOTFIX] Return retry");
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(true);
  });

  it("marks child of bugfix/ merge as bug fix", () => {
    const M = commit(
      "m000",
      ["base", "c000"],
      "Merge branch 'bugfix/TD-456-seat-decrease' into 'master'",
    );
    const C = commit("c000", ["base"], "[TD-456] Fix seat targeting");
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(true);
  });

  it("marks GitHub PR merge with fix/ branch as bug fix", () => {
    const M = commit(
      "m000",
      ["base", "c000"],
      "Merge pull request #42 from user/fix-auth-bypass",
    );
    const C = commit("c000", ["base"], "Patch auth bypass vulnerability");
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(true);
  });

  it("does NOT mark children of feature/ merge", () => {
    const M = commit(
      "m000",
      ["base", "c000"],
      "Merge branch 'feature/TD-789-new-ui' into 'master'",
    );
    const C = commit("c000", ["base"], "[TD-789] New dashboard UI");
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(false);
  });

  it("handles multi-commit fix branch via parent traversal", () => {
    // M merges tip C3, which chains: C3 → C2 → C1 → base
    const M = commit(
      "m000",
      ["base", "c003"],
      "Merge branch 'fix/TD-100-multi' into 'master'",
    );
    const C3 = commit("c003", ["c002"], "Final cleanup");
    const C2 = commit("c002", ["c001"], "Add test");
    const C1 = commit("c001", ["base"], "Initial fix attempt");
    const result = buildBugFixShaSet([M, C3, C2, C1]);
    expect(result.has("c001")).toBe(true);
    expect(result.has("c002")).toBe(true);
    expect(result.has("c003")).toBe(true);
  });

  it("does not traverse beyond mainline parent", () => {
    // Mainline commits before the merge should not be marked
    const M = commit(
      "m000",
      ["prev", "c000"],
      "Merge branch 'fix/TD-200' into 'master'",
    );
    const C = commit("c000", ["prev"], "[TD-200] Fix");
    const prev = commit("prev", ["older"], "feat: unrelated feature");
    const result = buildBugFixShaSet([M, C, prev]);
    expect(result.has("c000")).toBe(true);
    expect(result.has("prev")).toBe(false);
  });

  it("handles feature/ branch with fix in description (not a bug fix)", () => {
    const M = commit(
      "m000",
      ["base", "c000"],
      "Merge branch 'feature/TD-999-fix-badges-in-comparison-page' into 'master'",
    );
    const C = commit("c000", ["base"], "[TD-999] Fix badges");
    // Branch is feature/, not fix/ — don't mark from merge.
    // Child has "Fix" in subject but that's handled separately by isBugFixCommit.
    const result = buildBugFixShaSet([M, C]);
    expect(result.has("c000")).toBe(false);
  });

  it("returns empty set when no merges", () => {
    const C1 = commit("c001", ["c000"], "fix: direct commit");
    const C2 = commit("c000", [], "Initial");
    const result = buildBugFixShaSet([C1, C2]);
    expect(result.size).toBe(0);
  });
});
```

- [ ] Run:
      `npx vitest run tests/core/domains/trajectory/git/infra/merge-branch-resolver.test.ts`
- [ ] Expected: FAIL — module does not exist

### Step 2: Implement merge-branch-resolver

- [ ] Create `src/core/domains/trajectory/git/infra/merge-branch-resolver.ts`:

```typescript
/**
 * Resolve bug-fix child commits from merge commit branch prefixes.
 *
 * Builds a Set<sha> of commits that belong to fix/, hotfix/, or bugfix/
 * branches by traversing the parent graph from merge commits' second parent.
 * Pure function — no I/O, no git CLI calls.
 */

import type { CommitInfo } from "../../../../adapters/git/types.js";

/**
 * Patterns that identify a merge commit as merging a bug-fix branch.
 * Matches GitLab ("Merge branch 'fix/...'") and GitHub ("Merge pull request #N from user/fix-...")
 */
const FIX_BRANCH_PATTERNS = [
  /Merge branch '(?:fix|hotfix|bugfix)\//i,
  /Merge pull request #\d+ from [^/]+\/(?:fix|hotfix|bugfix)[/-]/i,
];

function isBugFixMerge(subject: string): boolean {
  return FIX_BRANCH_PATTERNS.some((p) => p.test(subject));
}

/**
 * Build a Set of commit SHAs that belong to bug-fix branches.
 *
 * Algorithm:
 * 1. Index all commits by SHA for O(1) lookup
 * 2. Find merge commits (2+ parents) with fix/hotfix/bugfix branch prefix
 * 3. For each such merge: BFS from parent[1] (branch tip) through parent chain,
 *    stop when reaching parent[0] (mainline) or a commit not in our set
 * 4. All visited SHAs = bug-fix commits
 */
export function buildBugFixShaSet(commits: CommitInfo[]): Set<string> {
  const commitMap = new Map<string, CommitInfo>();
  for (const c of commits) {
    commitMap.set(c.sha, c);
  }

  const bugFixShas = new Set<string>();

  for (const c of commits) {
    if (c.parents.length < 2) continue;

    const subject = c.body.split("\n")[0];
    if (!isBugFixMerge(subject)) continue;

    const mainlineParent = c.parents[0];
    const branchTip = c.parents[1];

    // BFS from branch tip, stop at mainline
    const queue = [branchTip];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const sha = queue.shift()!;
      if (sha === mainlineParent || visited.has(sha)) continue;
      visited.add(sha);

      const node = commitMap.get(sha);
      if (!node) continue;

      bugFixShas.add(sha);

      for (const parent of node.parents) {
        if (!visited.has(parent) && parent !== mainlineParent) {
          queue.push(parent);
        }
      }
    }
  }

  return bugFixShas;
}
```

### Step 3: Run tests

- [ ] Run:
      `npx vitest run tests/core/domains/trajectory/git/infra/merge-branch-resolver.test.ts`
- [ ] Expected: ALL PASS

### Step 4: Commit

```bash
git add src/core/domains/trajectory/git/infra/merge-branch-resolver.ts \
  tests/core/domains/trajectory/git/infra/merge-branch-resolver.test.ts
git commit -m "feat(git): add merge-branch-resolver for fix branch propagation

BFS from merge commit second parent through parent graph to identify
all child commits of fix/hotfix/bugfix branches. Pure function, no I/O.
Part of tea-rags-mcp-6130."
```

---

## Task 3: Rewrite isBugFixCommit() with strict patterns

**Files:**

- Modify: `src/core/domains/trajectory/git/infra/metrics.ts:38-50`
- Modify: `tests/core/domains/trajectory/git/infra/git-log-reader.test.ts`

### Step 1: Write failing tests for new classification rules

- [ ] Replace the existing `isBugFixCommit` test block in
      `tests/core/domains/trajectory/git/infra/git-log-reader.test.ts`:

```typescript
describe("isBugFixCommit — strict classification", () => {
  // ── TRUE POSITIVES ──

  it("detects conventional commit: fix:", () => {
    expect(isBugFixCommit("fix: resolve login race condition")).toBe(true);
  });

  it("detects conventional commit: fix(scope):", () => {
    expect(isBugFixCommit("fix(auth): prevent session fixation")).toBe(true);
  });

  it("detects conventional commit: hotfix:", () => {
    expect(isBugFixCommit("hotfix: emergency payment rollback")).toBe(true);
  });

  it("detects conventional commit: hotfix(scope):", () => {
    expect(isBugFixCommit("hotfix(billing): fix double charge")).toBe(true);
  });

  it("detects [Fix] tag", () => {
    expect(isBugFixCommit("[Fix] Restore sorting param in documents")).toBe(
      true,
    );
  });

  it("detects [Bug] tag", () => {
    expect(isBugFixCommit("[Bug] Handle null pointer in payment flow")).toBe(
      true,
    );
  });

  it("detects [HOTFIX] tag", () => {
    expect(
      isBugFixCommit("[HOTFIX] Return retry, need in specific place"),
    ).toBe(true);
  });

  it("detects [Bugfix] tag", () => {
    expect(isBugFixCommit("[Bugfix] Correct timezone offset")).toBe(true);
  });

  it("detects [TD-XXXX] Fix ... pattern (ticket + Fix verb)", () => {
    expect(
      isBugFixCommit("[TD-81775] Fix for uncheckable checkbox in enum filters"),
    ).toBe(true);
  });

  it("detects [TD-XXXX] fixed ... pattern (past tense)", () => {
    expect(
      isBugFixCommit("[TD-81618] fixed 404 error when a job is created"),
    ).toBe(true);
  });

  it("detects TD-XXXX Fix without brackets", () => {
    expect(
      isBugFixCommit("TD-78954 Fix retry from failed jobs notification"),
    ).toBe(true);
  });

  it("detects 'Fix high bug' with ticket prefix", () => {
    expect(isBugFixCommit("[TD-81602] Fix high bug")).toBe(true);
  });

  it("detects 'fixes #123' GitHub keyword", () => {
    expect(isBugFixCommit("Update auth flow\n\nfixes #123")).toBe(true);
  });

  it("detects 'resolves #456' GitHub keyword", () => {
    expect(isBugFixCommit("Patch validation\n\nresolves #456")).toBe(true);
  });

  it("detects 'closes #789' GitHub keyword", () => {
    expect(isBugFixCommit("Handle edge case\n\ncloses #789")).toBe(true);
  });

  // ── TRUE NEGATIVES ──

  it("rejects merge commit with fix/ branch", () => {
    expect(
      isBugFixCommit("Merge branch 'fix/TD-123-urgent' into 'master'"),
    ).toBe(false);
  });

  it("rejects merge commit with hotfix/ branch", () => {
    expect(
      isBugFixCommit("Merge branch 'hotfix/emergency' into 'master'"),
    ).toBe(false);
  });

  it("rejects merge PR with fix/ branch", () => {
    expect(isBugFixCommit("Merge pull request #42 from user/fix-auth")).toBe(
      false,
    );
  });

  it("rejects 'fix typo'", () => {
    expect(isBugFixCommit("fix typo in README")).toBe(false);
  });

  it("rejects 'fix lint' / 'fix linter'", () => {
    expect(isBugFixCommit("fix lint errors")).toBe(false);
    expect(isBugFixCommit("fix linter warnings")).toBe(false);
  });

  it("rejects 'fix formatting' / 'fix style'", () => {
    expect(isBugFixCommit("fix formatting issues")).toBe(false);
    expect(isBugFixCommit("fix style violations")).toBe(false);
  });

  it("rejects 'fix whitespace' / 'fix indentation'", () => {
    expect(isBugFixCommit("fix whitespace")).toBe(false);
    expect(isBugFixCommit("fix indentation in module")).toBe(false);
  });

  it("rejects 'fix imports'", () => {
    expect(isBugFixCommit("fix imports order")).toBe(false);
  });

  it("rejects 'fix tests' / 'fix specs' / 'fix flaky'", () => {
    expect(isBugFixCommit("fix flaky tests")).toBe(false);
    expect(isBugFixCommit("fix spec tags, ordering")).toBe(false);
    expect(
      isBugFixCommit(
        "[TD-81841] fix spec tags, ordering and add purchase/create coverage",
      ),
    ).toBe(false);
  });

  it("rejects 'fix rubocop' / 'fix eslint'", () => {
    expect(isBugFixCommit("Fix rubocop offenses in CodeMetrics spec")).toBe(
      false,
    );
    expect(isBugFixCommit("fix eslint warnings")).toBe(false);
  });

  it("rejects 'fix review' / 'fix code review findings'", () => {
    expect(isBugFixCommit("refactor(specs): fix code review findings")).toBe(
      false,
    );
    expect(
      isBugFixCommit(
        "[TD-80688] Fix rubocop offenses in UpdatePassFee service",
      ),
    ).toBe(false);
  });

  it("rejects 'fix ci' / 'fix pipeline'", () => {
    expect(isBugFixCommit("fix ci pipeline")).toBe(false);
    expect(
      isBugFixCommit("fix: preserve NODE_OPTIONS env in test-ct script"),
    ).toBe(false);
  });

  it("rejects 'fix migration' without bug context", () => {
    expect(isBugFixCommit("[TD-81791] fix migration")).toBe(false);
  });

  it("rejects 'resolve the conflicts'", () => {
    expect(isBugFixCommit("[TD-80535] resolve the conflicts")).toBe(false);
  });

  it("rejects feature commit with no fix keywords", () => {
    expect(
      isBugFixCommit("[TD-80719] Add v3 cursor pagination endpoints"),
    ).toBe(false);
  });

  it("rejects 'Resolve TD-XXXXX Feature/' GitLab auto-merge", () => {
    expect(
      isBugFixCommit(
        'Resolve TD-77320 "Feature/ vitest test for usepipelineform"',
      ),
    ).toBe(false);
  });

  it("rejects feature/TD-XXXX-fix branch name in body (feature branch)", () => {
    // Child commit from feature/ branch that happens to have "fix" in branch name
    expect(isBugFixCommit("[TD-81964] Fix badges")).toBe(true);
    // But the merge for this branch is feature/ — merge-branch-resolver handles that.
    // isBugFixCommit only looks at commit message, not branch context.
  });

  it("rejects 'Text fix' / 'text fixes'", () => {
    expect(isBugFixCommit("[TD-81563] Text fix")).toBe(false);
    expect(isBugFixCommit("text fixes")).toBe(false);
  });
});
```

- [ ] Import `isBugFixCommit` directly (currently tested via
      `computeFileSignals`):

```typescript
import { isBugFixCommit } from "../../../../../../src/core/domains/trajectory/git/infra/metrics.js";
```

- [ ] Run:
      `npx vitest run tests/core/domains/trajectory/git/infra/git-log-reader.test.ts`
- [ ] Expected: FAIL — many new tests fail with current loose pattern

### Step 2: Rewrite isBugFixCommit()

- [ ] Modify `src/core/domains/trajectory/git/infra/metrics.ts`:

Replace lines 38-50 with:

```typescript
/**
 * Cosmetic/infrastructure patterns to EXCLUDE — not real bug fixes.
 * Checked against the full commit body (case-insensitive).
 */
const COSMETIC_PATTERN =
  /\bfix(?:e[sd])?\s+(?:typo|lint|linter|format|formatting|style|whitespace|indentation|imports?|tests?|specs?|flaky|rubocop|eslint|prettier|ci|pipeline|migration|review|code\s*review|conflicts?)\b/i;

const TEXT_FIX_PATTERN = /\btext\s+fix(?:es)?\b/i;

/**
 * Strong positive signals — conventional commits and explicit tags.
 * Checked against the SUBJECT line only.
 */
const CONVENTIONAL_FIX = /^(?:hot)?fix(?:\([^)]+\))?!?:/i;
const TAG_FIX = /^\[(?:Fix|Bug|Hotfix|Bugfix)\]/i;

/**
 * Ticket + Fix verb: "[TD-123] Fix ..." or "TD-123 Fix ..." or "[PROJ-456] fixed ..."
 * Checked against the SUBJECT line only.
 */
const TICKET_FIX = /^\[?[A-Z]+-\d+\]?\s+(?:fix|fixed|fixes)\b/i;

/**
 * GitHub/GitLab closing keywords in body: "fixes #123", "resolves #456", "closes #789"
 * Checked against the FULL body.
 */
const CLOSES_ISSUE = /\b(?:fix|fixe[sd]|resolve[sd]?|close[sd]?)\s+#\d+/i;

export const MERGE_SUBJECT = /^Merge\b/i;

/**
 * Check if a commit is a bug fix based on its message.
 *
 * Classification rules (in order):
 * 1. Skip merge commits — branch prefix is handled by merge-branch-resolver
 * 2. Exclude cosmetic patterns (fix typo, fix lint, fix tests, etc.)
 * 3. Match conventional prefix: fix:, hotfix:, fix(scope):
 * 4. Match explicit tag: [Fix], [Bug], [HOTFIX], [Bugfix]
 * 5. Match ticket + Fix verb: [TD-123] Fix ..., TD-456 fixed ...
 * 6. Match GitHub closing keywords: fixes #123, resolves #456
 */
export function isBugFixCommit(body: string): boolean {
  const subject = body.split("\n")[0];

  // 1. Skip merge commits
  if (MERGE_SUBJECT.test(subject)) return false;

  // 2. Exclude cosmetic/infrastructure fixes
  if (COSMETIC_PATTERN.test(body)) return false;
  if (TEXT_FIX_PATTERN.test(body)) return false;

  // 3. Conventional commit prefix
  if (CONVENTIONAL_FIX.test(subject)) return true;

  // 4. Explicit tag
  if (TAG_FIX.test(subject)) return true;

  // 5. Ticket + Fix verb
  if (TICKET_FIX.test(subject)) return true;

  // 6. GitHub/GitLab closing keywords (anywhere in body)
  if (CLOSES_ISSUE.test(body)) return true;

  return false;
}
```

### Step 3: Update old tests that relied on broad matching

- [ ] Remove the old `isBugFixCommit (via computeFileSignals)` describe block.
      The new test block from Step 1 replaces it. Update the
      `computeFileSignals` test that checked Laplace smoothing for merge commits
      to use the new expected values:

```typescript
it("should skip merge commits that contain 'fix' in branch name", () => {
  const commits = [
    makeCommit({ body: "Merge branch 'fix/TD-9999-urgent-patch' into main" }),
    makeCommit({ body: "feat: add unrelated feature" }),
  ];
  const data: FileChurnData = { commits, linesAdded: 0, linesDeleted: 0 };
  const meta = computeFileSignals(data, 100);
  // Both commits are non-fix: merge is skipped, feat has no fix keyword
  // Laplace-smoothed: (0 + 0.5) / (2 + 1.0) = 0.5/3.0 ≈ 17
  expect(meta.bugFixRate).toBe(17);
});
```

### Step 4: Run tests

- [ ] Run: `npx vitest run`
- [ ] Expected: ALL PASS

### Step 5: Commit

```bash
git add src/core/domains/trajectory/git/infra/metrics.ts \
  tests/core/domains/trajectory/git/infra/git-log-reader.test.ts
git commit -m "fix(signals): rewrite isBugFixCommit with strict classification

Replace broad regex with layered detection:
- Conventional prefix (fix:, hotfix:)
- Explicit tags ([Fix], [Bug], [HOTFIX])
- Ticket + Fix verb ([TD-123] Fix ...)
- GitHub closing keywords (fixes #123)
- Cosmetic exclusion (fix typo, fix lint, fix tests, etc.)

Fixes tea-rags-mcp-6130."
```

---

## Task 4: Wire merge-branch-resolver into file-reader

**Files:**

- Modify: `src/core/domains/trajectory/git/infra/file-reader.ts`
- Modify: `src/core/domains/trajectory/git/infra/metrics.ts` (add
  `isBugFixCommitOrBranch()`)

### Step 1: Write failing test

- [ ] Add test to
      `tests/core/domains/trajectory/git/infra/git-log-reader.test.ts`:

```typescript
describe("isBugFixCommitOrBranch", () => {
  it("returns true when SHA is in bugFixShaSet (from merge branch)", () => {
    const bugFixShas = new Set(["abc123"]);
    expect(
      isBugFixCommitOrBranch("feat: unrelated commit", "abc123", bugFixShas),
    ).toBe(true);
  });

  it("returns true when message matches isBugFixCommit", () => {
    const bugFixShas = new Set<string>();
    expect(
      isBugFixCommitOrBranch(
        "fix(auth): prevent session fixation",
        "xyz789",
        bugFixShas,
      ),
    ).toBe(true);
  });

  it("returns false when neither branch nor message match", () => {
    const bugFixShas = new Set<string>();
    expect(
      isBugFixCommitOrBranch("feat: add dashboard", "xyz789", bugFixShas),
    ).toBe(false);
  });
});
```

- [ ] Run: FAIL — function does not exist

### Step 2: Add isBugFixCommitOrBranch() to metrics.ts

- [ ] Add to `src/core/domains/trajectory/git/infra/metrics.ts`:

```typescript
/**
 * Combined bug-fix check: merge branch prefix OR commit message.
 * Used by file-reader and chunk-reader for final classification.
 */
export function isBugFixCommitOrBranch(
  body: string,
  sha: string,
  bugFixShas: Set<string>,
): boolean {
  if (bugFixShas.has(sha)) return true;
  return isBugFixCommit(body);
}
```

### Step 3: Wire into file-reader

- [ ] Modify `src/core/domains/trajectory/git/infra/file-reader.ts`:

Import and call `buildBugFixShaSet()` after `buildViaCli()`:

```typescript
import { buildBugFixShaSet } from "./merge-branch-resolver.js";
```

After `buildViaCli(repoRoot, sinceDate, timeoutMs)` returns `fileMap`:

```typescript
// Collect all unique commits across all files for merge resolution
const allCommits = new Map<string, CommitInfo>();
for (const [, data] of fileMap) {
  for (const c of data.commits) {
    if (!allCommits.has(c.sha)) allCommits.set(c.sha, c);
  }
}
const bugFixShas = buildBugFixShaSet(Array.from(allCommits.values()));
```

Then pass `bugFixShas` to `computeFileSignals()` — see Step 4.

### Step 4: Update computeFileSignals() to accept bugFixShas

- [ ] Modify `src/core/domains/trajectory/git/infra/metrics.ts` —
      `computeFileSignals()` signature:

```typescript
export function computeFileSignals(
  churnData: FileChurnData,
  currentLineCount: number,
  bugFixShas?: Set<string>,
): GitFileSignals {
```

Replace the bugFixRate computation (line 152):

```typescript
const effectiveBugFixShas = bugFixShas ?? new Set<string>();
const bugFixCount = commits.filter((c) =>
  isBugFixCommitOrBranch(c.body, c.sha, effectiveBugFixShas),
).length;
```

### Step 5: Update file-reader call site to pass bugFixShas

- [ ] In file-reader where `computeFileSignals(churnData, lineCount)` is called,
      add the third argument:
      `computeFileSignals(churnData, lineCount, bugFixShas)`.

### Step 6: Run tests

- [ ] Run: `npx vitest run`
- [ ] Expected: ALL PASS — existing tests pass with `bugFixShas` defaulting to
      empty Set

### Step 7: Commit

```bash
git add src/core/domains/trajectory/git/infra/file-reader.ts \
  src/core/domains/trajectory/git/infra/metrics.ts \
  tests/core/domains/trajectory/git/infra/git-log-reader.test.ts
git commit -m "feat(git): wire merge-branch-resolver into file signal computation

computeFileSignals() now accepts bugFixShas set from merge graph.
Commits from fix/hotfix/bugfix branches are correctly classified
even when their message lacks fix keywords.
Part of tea-rags-mcp-6130."
```

---

## Task 5: Wire merge-branch-resolver into chunk-reader

**Files:**

- Modify: `src/core/domains/trajectory/git/infra/chunk-reader.ts:175,252`

### Step 1: Update chunk-reader to use bugFixShas

- [ ] The chunk-reader currently computes `isBugFix` per commit at line 175:

```typescript
const isBugFix = isBugFixCommit(commit.body);
```

Change to:

```typescript
const isBugFix = isBugFixCommitOrBranch(commit.body, commit.sha, bugFixShas);
```

- [ ] `bugFixShas` must be passed into the chunk processing function. The chunk
      reader gets commits via `getCommitsByPathspec()`, which already parses
      parents. Build the set from those commits:

```typescript
import { buildBugFixShaSet } from "./merge-branch-resolver.js";

// After getCommitsByPathspec returns commitEntries:
const allCommitsForMerge = commitEntries.map((e) => e.commit);
const bugFixShas = buildBugFixShaSet(allCommitsForMerge);
```

### Step 2: Run tests

- [ ] Run: `npx vitest run`
- [ ] Expected: ALL PASS

### Step 3: Commit

```bash
git add src/core/domains/trajectory/git/infra/chunk-reader.ts
git commit -m "feat(git): wire merge-branch-resolver into chunk signal computation

Chunk-level bugFixRate now correctly classifies commits from
fix/hotfix/bugfix branches via merge graph propagation.
Part of tea-rags-mcp-6130."
```

---

## Task 6: Raise BugFixSignal FALLBACK_THRESHOLD (bug 2xeb)

**Files:**

- Modify: `src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.ts:21`
- Modify: `tests/core/domains/trajectory/git/derived-signals/confidence.test.ts`

Note: adaptive dampening via `GIT_FILE_DAMPENING` (p25 of commitCount) remains
unchanged. Only the FALLBACK_THRESHOLD (used when adaptive bounds unavailable)
changes from 8 to 10.

### Step 1: Write failing test for new threshold

- [ ] Update
      `tests/core/domains/trajectory/git/derived-signals/confidence.test.ts`:

```typescript
it("uses fallback threshold k=10 (not k=8)", () => {
  const raw = makePayload({ commitCount: 4, bugFixRate: 50 });
  const ctx: ExtractContext = {
    bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
  };
  const value = signal.extract(raw, ctx);
  // With k=10: confidence = (4/10)^2 = 0.16
  // base = 50/100 = 0.5
  // value = 0.5 * 0.16 = 0.08
  expect(value).toBeCloseTo(0.5 * (4 / 10) ** 2);
});
```

- [ ] Run:
      `npx vitest run tests/core/domains/trajectory/git/derived-signals/confidence.test.ts`
- [ ] Expected: FAIL — old threshold k=8 gives different value

### Step 2: Change FALLBACK_THRESHOLD from 8 to 10

- [ ] Modify
      `src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.ts`:

```typescript
private static readonly FALLBACK_THRESHOLD = 10;
```

### Step 3: Update existing tests for k=10

- [ ] In `confidence.test.ts`, update the "dampens value when commitCount <
      adaptive threshold" test:

```typescript
it("dampens value when commitCount < adaptive threshold", () => {
  const raw = makePayload({ commitCount: 2, bugFixRate: 50 });
  const ctx: ExtractContext = {
    bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
  };
  const value = signal.extract(raw, ctx);
  // base = 50/100 = 0.5, confidence = (2/10)^2 = 0.04 (FALLBACK_THRESHOLD=10)
  expect(value).toBeCloseTo(0.5 * (2 / 10) ** 2);
});

it("uses fallback threshold when no dampeningThreshold", () => {
  const raw = makePayload({ commitCount: 2, bugFixRate: 50 });
  const ctx: ExtractContext = {
    bounds: { "file.bugFixRate": 100, "chunk.bugFixRate": 100 },
  };
  const value = signal.extract(raw, ctx);
  // Fallback k=10, confidence = (2/10)^2 = 0.04
  expect(value).toBeCloseTo(0.5 * (2 / 10) ** 2);
});
```

### Step 4: Run tests

- [ ] Run: `npx vitest run`
- [ ] Expected: ALL PASS

### Step 5: Commit

```bash
git add src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.ts \
  tests/core/domains/trajectory/git/derived-signals/confidence.test.ts
git commit -m "fix(signals): raise BugFixSignal FALLBACK_THRESHOLD from k=8 to k=10

Reduces false-positive impact on small samples when adaptive bounds
unavailable. At commitCount=4, confidence drops from 25% (k=8) to
16% (k=10). Adaptive dampening (p25) unchanged.

Fixes tea-rags-mcp-2xeb."
```

---

## Task 7: Offset tracker — pure algorithm for chunk range drift fix (bug fek8)

**Files:**

- Create: `src/core/domains/trajectory/git/infra/offset-tracker.ts`
- Create: `tests/core/domains/trajectory/git/infra/offset-tracker.test.ts`

This task extracts the offset tracking algorithm as a pure, testable module. The
chunk-reader wiring happens in Task 8.

### Step 1: Write failing tests for offset tracking

- [ ] Create `tests/core/domains/trajectory/git/infra/offset-tracker.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  applyOffsets,
  mapHunksToChunks,
  type AdjustedRange,
} from "../../../../../../src/core/domains/trajectory/git/infra/offset-tracker.js";

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

describe("mapHunksToChunks", () => {
  it("maps hunk to overlapping chunk using adjusted ranges", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 10, end: 20 },
      { chunkId: "B", start: 30, end: 40 },
    ];
    const hunks: Hunk[] = [
      { oldStart: 10, oldLines: 3, newStart: 12, newLines: 5 },
    ];
    // Hunk covers lines 12-16 in new version → overlaps chunk A (10-20)
    const affected = mapHunksToChunks(hunks, ranges);
    expect(affected).toContain("A");
    expect(affected).not.toContain("B");
  });

  it("maps hunk overlapping multiple chunks", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 10, end: 20 },
      { chunkId: "B", start: 21, end: 30 },
    ];
    const hunks: Hunk[] = [
      { oldStart: 15, oldLines: 10, newStart: 15, newLines: 12 },
    ];
    // Hunk covers lines 15-26 → overlaps both A and B
    const affected = mapHunksToChunks(hunks, ranges);
    expect(affected).toContain("A");
    expect(affected).toContain("B");
  });

  it("returns empty set when no overlap", () => {
    const ranges: AdjustedRange[] = [{ chunkId: "A", start: 50, end: 60 }];
    const hunks: Hunk[] = [
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 5 },
    ];
    // Hunk covers lines 1-5, chunk at 50-60
    const affected = mapHunksToChunks(hunks, ranges);
    expect(affected.size).toBe(0);
  });
});

describe("applyOffsets", () => {
  it("shifts chunks BELOW a hunk by insertion delta", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 5, end: 10 },
      { chunkId: "B", start: 20, end: 30 },
    ];
    // Hunk at lines 12-16 in new version inserted 3 lines (newLines=5, oldLines=2)
    const hunks: Hunk[] = [
      { oldStart: 12, oldLines: 2, newStart: 12, newLines: 5 },
    ];
    const adjusted = applyOffsets(ranges, hunks);
    // Chunk A (5-10) is ABOVE hunk (12) → no shift
    expect(adjusted.find((r) => r.chunkId === "A")).toEqual({
      chunkId: "A",
      start: 5,
      end: 10,
    });
    // Chunk B (20-30) is BELOW hunk end (16) → shift by -(5-2) = -3
    const b = adjusted.find((r) => r.chunkId === "B")!;
    expect(b.start).toBe(17); // 20 - 3
    expect(b.end).toBe(27); // 30 - 3
  });

  it("shifts chunks BELOW a hunk by deletion delta", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 5, end: 10 },
      { chunkId: "B", start: 20, end: 30 },
    ];
    // Hunk deleted 3 lines (oldLines=5, newLines=2), lines 8-9 in new version
    const hunks: Hunk[] = [
      { oldStart: 8, oldLines: 5, newStart: 8, newLines: 2 },
    ];
    const adjusted = applyOffsets(ranges, hunks);
    // Chunk B (20-30) is below hunk → shift by -(2-5) = +3
    const b = adjusted.find((r) => r.chunkId === "B")!;
    expect(b.start).toBe(23); // 20 + 3
    expect(b.end).toBe(33); // 30 + 3
  });

  it("resizes chunk when hunk is INSIDE it (insertion)", () => {
    const ranges: AdjustedRange[] = [{ chunkId: "A", start: 10, end: 30 }];
    // Hunk at lines 15-19 inside chunk A, inserted 3 lines (old=2, new=5)
    const hunks: Hunk[] = [
      { oldStart: 15, oldLines: 2, newStart: 15, newLines: 5 },
    ];
    const adjusted = applyOffsets(ranges, hunks);
    const a = adjusted.find((r) => r.chunkId === "A")!;
    // Start unchanged (hunk is inside), end shrinks by delta=3
    expect(a.start).toBe(10);
    expect(a.end).toBe(27); // 30 - 3
  });

  it("resizes chunk when hunk is INSIDE it (deletion)", () => {
    const ranges: AdjustedRange[] = [{ chunkId: "A", start: 10, end: 30 }];
    // Hunk deleted lines inside chunk (old=5, new=2) → delta=-3
    const hunks: Hunk[] = [
      { oldStart: 15, oldLines: 5, newStart: 15, newLines: 2 },
    ];
    const adjusted = applyOffsets(ranges, hunks);
    const a = adjusted.find((r) => r.chunkId === "A")!;
    // End expands by 3 (going backward, old version had 3 more lines)
    expect(a.start).toBe(10);
    expect(a.end).toBe(33); // 30 + 3
  });

  it("handles multiple hunks bottom-to-top to avoid cascading", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 5, end: 10 },
      { chunkId: "B", start: 20, end: 25 },
      { chunkId: "C", start: 40, end: 50 },
    ];
    // Two insertions: one at line 12 (+3), one at line 30 (+2)
    const hunks: Hunk[] = [
      { oldStart: 12, oldLines: 1, newStart: 12, newLines: 4 }, // +3 at 12
      { oldStart: 28, oldLines: 1, newStart: 30, newLines: 3 }, // +2 at 30
    ];
    const adjusted = applyOffsets(ranges, hunks);
    // A (5-10): above both hunks → no shift
    expect(adjusted.find((r) => r.chunkId === "A")).toEqual({
      chunkId: "A",
      start: 5,
      end: 10,
    });
    // B (20-25): below hunk1 (12) → shift -3, above hunk2 (30) → no shift from hunk2
    const b = adjusted.find((r) => r.chunkId === "B")!;
    expect(b.start).toBe(17); // 20 - 3
    expect(b.end).toBe(22); // 25 - 3
    // C (40-50): below both hunks → shift -(3+2) = -5
    const c = adjusted.find((r) => r.chunkId === "C")!;
    expect(c.start).toBe(35); // 40 - 5
    expect(c.end).toBe(45); // 50 - 5
  });

  it("does not shift chunks ABOVE hunk", () => {
    const ranges: AdjustedRange[] = [{ chunkId: "A", start: 5, end: 10 }];
    const hunks: Hunk[] = [
      { oldStart: 20, oldLines: 2, newStart: 20, newLines: 5 },
    ];
    const adjusted = applyOffsets(ranges, hunks);
    expect(adjusted[0]).toEqual({ chunkId: "A", start: 5, end: 10 });
  });

  it("handles zero-delta hunk (pure replacement, same line count)", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 5, end: 10 },
      { chunkId: "B", start: 20, end: 30 },
    ];
    const hunks: Hunk[] = [
      { oldStart: 12, oldLines: 3, newStart: 12, newLines: 3 },
    ];
    const adjusted = applyOffsets(ranges, hunks);
    // Zero delta → no shifts
    expect(adjusted.find((r) => r.chunkId === "A")).toEqual({
      chunkId: "A",
      start: 5,
      end: 10,
    });
    expect(adjusted.find((r) => r.chunkId === "B")).toEqual({
      chunkId: "B",
      start: 20,
      end: 30,
    });
  });

  it("prevents negative start after large deletion", () => {
    const ranges: AdjustedRange[] = [{ chunkId: "A", start: 2, end: 5 }];
    // Hunk at line 1 deleted 10 lines → delta = -(0-10) = +10
    // Going backward, chunk was lower... but start can't go below 1
    const hunks: Hunk[] = [
      { oldStart: 1, oldLines: 10, newStart: 1, newLines: 0 },
    ];
    const adjusted = applyOffsets(ranges, hunks);
    const a = adjusted.find((r) => r.chunkId === "A")!;
    expect(a.start).toBeGreaterThanOrEqual(1);
    expect(a.end).toBeGreaterThanOrEqual(a.start);
  });

  it("returns empty array for empty input", () => {
    expect(applyOffsets([], [])).toEqual([]);
  });
});
```

- [ ] Run:
      `npx vitest run tests/core/domains/trajectory/git/infra/offset-tracker.test.ts`
- [ ] Expected: FAIL — module does not exist

### Step 2: Implement offset-tracker

- [ ] Create `src/core/domains/trajectory/git/infra/offset-tracker.ts`:

```typescript
/**
 * Per-file chunk range offset tracking for drift-free hunk→chunk mapping.
 *
 * When processing commits newest→oldest, chunk line ranges (defined at HEAD)
 * must be adjusted backward through each commit's insertions/deletions.
 *
 * Pure functions — no I/O, no git dependency.
 */

export interface AdjustedRange {
  chunkId: string;
  start: number;
  end: number;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/**
 * Map hunks to overlapping chunks using current adjusted ranges.
 * Returns Set of affected chunkIds.
 */
export function mapHunksToChunks(
  hunks: Hunk[],
  ranges: AdjustedRange[],
): Set<string> {
  const affected = new Set<string>();
  for (const hunk of hunks) {
    const hunkStart = hunk.newStart;
    const hunkEnd = hunk.newStart + Math.max(hunk.newLines - 1, 0);
    for (const r of ranges) {
      if (hunkStart <= r.end && hunkEnd >= r.start) {
        affected.add(r.chunkId);
      }
    }
  }
  return affected;
}

/**
 * Apply offset corrections to adjusted ranges for the next (older) commit.
 *
 * For each hunk, computes delta = newLines - oldLines:
 * - Chunks BELOW hunk: shift start/end by -delta
 * - Chunks CONTAINING hunk (hunk entirely inside chunk): shrink/expand end by -delta
 * - Chunks ABOVE hunk: no change
 *
 * Hunks are processed bottom-to-top (sorted by newStart DESC) to prevent
 * cascading shift errors.
 *
 * Returns new array of AdjustedRange (does not mutate input).
 */
export function applyOffsets(
  ranges: AdjustedRange[],
  hunks: Hunk[],
): AdjustedRange[] {
  if (ranges.length === 0) return [];

  // Deep copy to avoid mutation
  const result: AdjustedRange[] = ranges.map((r) => ({ ...r }));

  // Sort hunks bottom-to-top to avoid cascading
  const sorted = [...hunks].sort((a, b) => b.newStart - a.newStart);

  for (const hunk of sorted) {
    const delta = hunk.newLines - hunk.oldLines;
    if (delta === 0) continue;

    const hunkStart = hunk.newStart;
    const hunkEnd = hunk.newStart + Math.max(hunk.newLines - 1, 0);

    for (const r of result) {
      if (r.start > hunkEnd) {
        // Chunk is entirely BELOW hunk → shift by -delta
        r.start -= delta;
        r.end -= delta;
      } else if (hunkStart >= r.start && hunkEnd <= r.end) {
        // Hunk is entirely INSIDE chunk → resize end only
        r.end -= delta;
      }
      // Chunk above or partially overlapping → no adjustment
    }
  }

  // Clamp to valid ranges
  for (const r of result) {
    r.start = Math.max(r.start, 1);
    r.end = Math.max(r.end, r.start);
  }

  return result;
}
```

### Step 3: Run tests

- [ ] Run:
      `npx vitest run tests/core/domains/trajectory/git/infra/offset-tracker.test.ts`
- [ ] Expected: ALL PASS

### Step 4: Commit

```bash
git add src/core/domains/trajectory/git/infra/offset-tracker.ts \
  tests/core/domains/trajectory/git/infra/offset-tracker.test.ts
git commit -m "feat(git): add offset-tracker for drift-free chunk attribution

Pure algorithm: adjusts chunk line ranges backward through commit
history to compensate for insertions/deletions above/inside chunks.
Hunks processed bottom-to-top to prevent cascading errors.
Part of tea-rags-mcp-fek8."
```

---

## Task 8: Wire offset tracker into chunk-reader (bug fek8)

**Files:**

- Modify: `src/core/domains/trajectory/git/infra/chunk-reader.ts`

Refactors `buildChunkChurnMapUncached()` from flat parallel commit processing to
two-phase architecture: parallel blob reads → sequential per-file offset-aware
mapping.

### Step 1: Refactor chunk-reader to two-phase architecture

- [ ] Modify `src/core/domains/trajectory/git/infra/chunk-reader.ts`:

**Phase 1** — parallel blob reads + patch computation (replaces current
`processCommitEntry`). Collects raw hunk data per file:

```typescript
import {
  applyOffsets,
  mapHunksToChunks,
  type AdjustedRange,
} from "./offset-tracker.js";

/** Raw hunk data collected in Phase 1 (parallel). */
interface CommitHunkData {
  commit: CommitInfo;
  hunks: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
  }[];
  isBugFix: boolean;
  taskIds: string[];
}

// Phase 1: parallel blob reads + patch computation
// Collect Map<filePath, CommitHunkData[]>
const fileHunkMap = new Map<string, CommitHunkData[]>();

const collectHunks = async (entry: {
  commit: CommitInfo;
  changedFiles: string[];
}): Promise<void> => {
  await acquire();
  try {
    const { commit, changedFiles } = entry;
    const relevantFiles = changedFiles.filter((f) => relativeChunkMap.has(f));
    if (relevantFiles.length === 0) return;

    const isBugFix = isBugFixCommitOrBranch(
      commit.body,
      commit.sha,
      bugFixShas,
    );
    const taskIds = extractTaskIds(commit.body);

    let parentOid: string;
    try {
      const commitObj = await git.readCommit({
        fs,
        dir: repoRoot,
        oid: commit.sha,
        cache: isoGitCache,
      });
      if (commitObj.commit.parent.length === 0) return;
      parentOid = commitObj.commit.parent[0];
    } catch {
      return;
    }

    await Promise.all(
      relevantFiles.map(async (filePath) => {
        const entries = relativeChunkMap.get(filePath);
        if (!entries) return;
        const maxLine = entries.reduce((max, e) => Math.max(max, e.endLine), 0);
        if (maxLine > maxFileLines) {
          skippedLargeFiles++;
          return;
        }

        const [oldContent, newContent] = await Promise.all([
          readBlobAsString(repoRoot, parentOid, filePath, isoGitCache),
          readBlobAsString(repoRoot, commit.sha, filePath, isoGitCache),
        ]);
        blobReads += 2;

        if (!oldContent && !newContent) {
          skippedEmptyBlobs++;
          return;
        }

        let hunks: {
          oldStart: number;
          oldLines: number;
          newStart: number;
          newLines: number;
        }[];
        try {
          const patch = structuredPatch(
            filePath,
            filePath,
            oldContent,
            newContent,
            "",
            "",
          );
          ({ hunks } = patch);
          patchCalls++;
        } catch {
          return;
        }

        if (hunks.length === 0) return;

        // Thread-safe: each filePath gets its own array
        let arr = fileHunkMap.get(filePath);
        if (!arr) {
          arr = [];
          fileHunkMap.set(filePath, arr);
        }
        arr.push({ commit, hunks, isBugFix, taskIds });
      }),
    );
  } finally {
    release();
  }
};

await Promise.all(commitEntries.map(collectHunks));
```

**Phase 2** — sequential per-file, parallel across files. Sort commits
newest→oldest, apply offset tracking:

```typescript
// Phase 2: sequential per-file offset-aware mapping (parallel across files)
await Promise.all(
  Array.from(fileHunkMap.entries()).map(async ([filePath, hunkDataList]) => {
    const entries = relativeChunkMap.get(filePath);
    if (!entries) return;

    // Sort newest → oldest (descending timestamp)
    hunkDataList.sort((a, b) => b.commit.timestamp - a.commit.timestamp);

    // Initialize adjusted ranges from HEAD chunk positions
    let adjustedRanges: AdjustedRange[] = entries.flatMap((e) => {
      const ranges = e.lineRanges || [{ start: e.startLine, end: e.endLine }];
      return ranges.map((r) => ({
        chunkId: e.chunkId,
        start: r.start,
        end: r.end,
      }));
    });

    for (const { commit, hunks, isBugFix, taskIds } of hunkDataList) {
      // Map hunks to chunks using ADJUSTED ranges
      const affectedChunkIds = mapHunksToChunks(hunks, adjustedRanges);

      // Accumulate stats (same as before)
      for (const chunkId of affectedChunkIds) {
        const acc = accumulators.get(chunkId);
        if (!acc) continue;
        acc.commitShas.add(commit.sha);
        acc.authors.add(commit.author);
        acc.commitTimestamps.push(commit.timestamp);
        acc.commitAuthors.push(commit.author);
        if (isBugFix) acc.bugFixCount++;
        for (const tid of taskIds) acc.taskIds.add(tid);
        if (commit.timestamp > acc.lastModifiedAt) {
          acc.lastModifiedAt = commit.timestamp;
        }
      }

      // Compute relativeChurn from hunk overlaps with adjusted ranges
      for (const hunk of hunks) {
        const hunkStart = hunk.newStart;
        const hunkEnd = hunk.newStart + Math.max(hunk.newLines - 1, 0);
        for (const r of adjustedRanges) {
          if (hunkStart <= r.end && hunkEnd >= r.start) {
            const acc = accumulators.get(r.chunkId);
            if (acc) {
              const overlapLines =
                Math.min(hunkEnd, r.end) - Math.max(hunkStart, r.start) + 1;
              acc.linesAdded += overlapLines;
              if (hunk.newLines > 0) {
                acc.linesDeleted += Math.round(
                  (hunk.oldLines * overlapLines) / hunk.newLines,
                );
              }
            }
          }
        }
      }

      // Apply offsets for next (older) commit
      adjustedRanges = applyOffsets(adjustedRanges, hunks);
    }
  }),
);
```

### Step 2: Handle thread safety for fileHunkMap

- [ ] The `fileHunkMap.get()/set()` in Phase 1 runs inside parallel
      `processCommitEntry` callbacks. Since JS is single-threaded (no true
      parallelism in `Promise.all`), Map operations are safe — `await` yields
      between callbacks, and Map mutations are synchronous. No mutex needed.

### Step 3: Run tests

- [ ] Run: `npx vitest run`
- [ ] Expected: ALL PASS — existing chunk-reader integration tests still pass,
      offset tracking improves accuracy

### Step 4: Commit

```bash
git add src/core/domains/trajectory/git/infra/chunk-reader.ts
git commit -m "fix(git): wire offset tracker into chunk-reader for drift-free attribution

Refactors chunk processing to two-phase architecture:
- Phase 1 (parallel): blob reads + structuredPatch → raw hunk data
- Phase 2 (sequential per file, parallel across files): offset-aware
  hunk→chunk mapping with adjusted ranges

Chunk line ranges are now corrected backward through commit history,
compensating for insertions/deletions that shift line numbers.

Fixes tea-rags-mcp-fek8."
```

---

## Task 9: Build, lint, full test suite

**Files:** All modified files

### Step 1: Build

- [ ] Run: `npm run build`
- [ ] Expected: Clean build, no errors

### Step 2: Lint

- [ ] Run:
      `npx prettier --check src/core/adapters/git/ src/core/domains/trajectory/git/infra/ src/core/domains/trajectory/git/rerank/derived-signals/`
- [ ] Fix any formatting issues with `npx prettier --write <files>`

### Step 3: Full test suite

- [ ] Run: `npx vitest run`
- [ ] Expected: ALL PASS, coverage thresholds met

### Step 4: Final commit (if lint fixes)

```bash
git add -A
git commit -m "style(git): format after bugFixRate accuracy fixes"
```

---

## Summary

| Bug                                  | Fix                                           | Task      |
| ------------------------------------ | --------------------------------------------- | --------- |
| tea-rags-mcp-6130 (false positives)  | Strict isBugFixCommit + merge-branch-resolver | Tasks 1-5 |
| tea-rags-mcp-2xeb (small samples)    | FALLBACK_THRESHOLD 8→10                       | Task 6    |
| tea-rags-mcp-fek8 (chunk line drift) | Offset tracker + two-phase chunk-reader       | Tasks 7-8 |

**Execution order:** Tasks 1→2→3→4→5→6→7→8→9 (sequential — each builds on
previous).
