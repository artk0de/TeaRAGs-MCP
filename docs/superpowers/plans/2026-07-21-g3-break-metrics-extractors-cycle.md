# G3: Break metrics ↔ extractors Import Cycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> dinopowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the only import cycle in the project graph
(`trajectory/git/infra/metrics.ts` ↔ `metrics/extractors.ts`) by relocating the
bug-fix classification block to the leaf module `git/infra/utils.ts`.

**Architecture:** The classification block (6 private pattern constants +
`MERGE_SUBJECT` + `isBugFixCommit` + `isBugFixCommitOrBranch`,
`metrics.ts:42-115`) is self-contained and pure. It moves verbatim to `utils.ts`
(a zero-import leaf). `metrics.ts` re-exports all three public symbols, so its
hub surface (fanIn 4, consumers `walk-commits.ts` and the test suite) is
unchanged. `extractors.ts` and `sessions.ts` switch their imports from
`../metrics.js` to `../utils.js` — both cycle-forming edges disappear.

**Tech Stack:** TypeScript ESM, vitest, ripgrep for structural assertions.

## Global Constraints

- Spec:
  `docs/superpowers/specs/2026-07-21-architecture-drift-refactoring-design.md`,
  Group 3.
- Epic: `tea-rags-mcp-udhyf`. Branch: `worktree-arch-drift-design`.
- `.claude/rules/test-invariants.md`: behavior-preserving relocation —
  `tests/**` must stay semantically untouched (`git diff --stat -- tests/` empty
  at the end).
- `walk-commits.ts` MUST stay out of the diff (3-contributor file, fanOut 5) —
  the re-export in `metrics.ts` guarantees this.
- Commit ≠ push. No push, no merge to main.

---

### Task 1: Relocate bug-fix classification block to utils.ts

**Files:**

- Modify: `src/core/domains/trajectory/git/infra/metrics.ts:42-115` (cut block,
  add re-export)
- Modify: `src/core/domains/trajectory/git/infra/utils.ts` (append block at end)
- Modify: `src/core/domains/trajectory/git/infra/metrics/extractors.ts:10-12`
  (import switch)
- Modify: `src/core/domains/trajectory/git/infra/metrics/sessions.ts:11` (import
  switch)
- Test: none added/changed (relocation under test-invariants rule)

**Interfaces:**

- Consumes: existing `extractTaskIds` in `utils.ts` (unchanged neighbor).
- Produces: `isBugFixCommit(body: string): boolean`,
  `isBugFixCommitOrBranch(body: string, sha: string, bugFixShas: Set<string>): boolean`,
  `MERGE_SUBJECT: RegExp` — exported from `utils.ts` AND re-exported from
  `metrics.ts` (import stability for `walk-commits.ts` and
  `tests/core/domains/trajectory/git/infra/metrics.test.ts:14-15`).

- [ ] **Step 1: Baseline green**

Run: `npx vitest run tests/core/domains/trajectory/git/infra/` Expected: PASS
(all files).

- [ ] **Step 2: Append the classification block to `utils.ts`**

Cut `metrics.ts` lines 42–115 (from the `/** Cosmetic/infrastructure patterns …`
doc comment through the closing brace of `isBugFixCommit`) and append verbatim
to the end of `src/core/domains/trajectory/git/infra/utils.ts`:

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

`utils.ts` gains no imports — it stays a leaf.

- [ ] **Step 3: Re-export from `metrics.ts`**

`export … from` does NOT create local bindings, and `metrics.ts:205` calls
`isBugFixCommitOrBranch` inside `computeFileSignals` — so an import + export
pair is REQUIRED. Add to the import section at the top of `metrics.ts`:

```typescript
import {
  isBugFixCommit,
  isBugFixCommitOrBranch,
  MERGE_SUBJECT,
} from "./utils.js";
```

and at the cut position (after the `SquashOptions` interface) insert the
re-export line:

```typescript
export { isBugFixCommit, isBugFixCommitOrBranch, MERGE_SUBJECT };
```

`overlaps()` (old lines 121-123) and everything below stay in `metrics.ts`.

- [ ] **Step 4: Switch `extractors.ts` import (kills cycle edge 1)**

Replace lines 10-12:

```typescript
import type { CommitInfo } from "../../../../../adapters/vcs/types.js";
import { isBugFixCommitOrBranch } from "../metrics.js";
import { extractTaskIds } from "../utils.js";
```

with:

```typescript
import type { CommitInfo } from "../../../../../adapters/vcs/types.js";
import { extractTaskIds, isBugFixCommitOrBranch } from "../utils.js";
```

- [ ] **Step 5: Switch `sessions.ts` import (kills cycle edge 2)**

Replace line 11:

```typescript
import { isBugFixCommit, MERGE_SUBJECT } from "../metrics.js";
```

with:

```typescript
import { isBugFixCommit, MERGE_SUBJECT } from "../utils.js";
```

- [ ] **Step 6: Structural assertion — no metrics/ file imports the parent**

Run:
`rg 'from "\.\./metrics\.js"' src/core/domains/trajectory/git/infra/metrics/`
Expected: no matches (both edges gone → import DAG).

- [ ] **Step 7: Type-check + tests**

Run:
`npx tsc --noEmit && npx vitest run tests/core/domains/trajectory/git/infra/`
Expected: 0 type errors, all tests PASS.

- [ ] **Step 8: Verify tests untouched**

Run: `git diff --stat -- tests/` Expected: empty output (test-invariants rule).

- [ ] **Step 9: Commit**

```bash
git add src/core/domains/trajectory/git/infra/metrics.ts \
        src/core/domains/trajectory/git/infra/utils.ts \
        src/core/domains/trajectory/git/infra/metrics/extractors.ts \
        src/core/domains/trajectory/git/infra/metrics/sessions.ts
git commit -m "refactor(git): break metrics<->extractors import cycle via utils relocation

Why: only cycle in the project import graph (risk-assessment 2026-07-20,
epic tea-rags-mcp-udhyf); bug-fix classification is pure and belongs in the
leaf utils module. metrics.ts re-exports keep walk-commits and tests untouched.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Post-merge verification (user-gated, NOT part of this branch):** after this
branch merges to main and an incremental `index_codebase project=tea-rags` runs,
`find_cycles scope=file` must return `{"cycles": []}` (DAG). The current index
still shows the old cycle until then.

**Beads:** one task under epic `tea-rags-mcp-udhyf` mirrors this Task (created
during plan sync); the epic also carries the debug-logger watch-note (deliberate
infra hub, fanIn 20 — escalate only on concerning bugFixRate or further fanIn
growth).
