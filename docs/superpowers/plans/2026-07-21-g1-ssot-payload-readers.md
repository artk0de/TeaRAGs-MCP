# G1: SSoT Payload-Path Readers Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> dinopowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all generic payload-path reads through the canonical
`resolvePayloadValue` (`contracts/signal-utils.ts:104`, fanIn 17 hub, documented
as "the single source of truth for payload addressing") — deleting the three
independent re-implementations.

**Architecture:** Three thin-delegate rewrites, no signature changes, no
consumer edits. (1) codegraph derived-signal helpers keep their public
`codegraphFileNum/Bool/chunkNum` coercion wrappers but delegate addressing; (2)
`git/stats/utils.ts#readPayloadPath` keeps its exported name, body becomes a
one-line delegate; (3) `stats-recompute.ts` drops its local mirror and calls the
canonical directly. NOT in scope: `git/rerank/derived-signals/helpers.ts`
(`fileField`/`chunkField`) — those are scope-local accessors with distinct
semantics (flat-on-`git`-object form, undefined-vs-0 distinction for
alpha-blending), a legitimate divergence, not a duplicate.

**Tech Stack:** TypeScript ESM, vitest.

## Global Constraints

- Spec:
  `docs/superpowers/specs/2026-07-21-architecture-drift-refactoring-design.md`,
  Group 1. Epic: `tea-rags-mcp-3f21g`. Branch: `worktree-arch-drift-design`.
- `.claude/rules/test-invariants.md`: behavior-preserving consolidation —
  `tests/**` semantically untouched, `git diff --stat -- tests/` empty at the
  end. If any test fails, the CODE is wrong (canonical resolver covers flat
  fixtures via its step 1/3) — do not edit tests.
- Resolution-order note: local codegraph helpers were nested-first; canonical is
  flat-first. Real payloads never carry both shapes at once, and test fixtures
  feed one shape — the suite is the equivalence proof.
- Known upside: the stats-recompute mirror lacks the codegraph nested-symbols
  mapping (canonical step 2) that `collection-stats.ts` already has —
  consolidation removes that latent divergence for codegraph support-key
  backfill.
- Commit ≠ push. No push, no merge to main.

---

### Task 1: Codegraph derived-signal helpers delegate to canonical resolver

**Files:**

- Modify:
  `src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/helpers.ts`
  (full-file rewrite, 63 → ~30 lines)
- Test: none added/changed
  (`tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/codegraph-signals.test.ts`
  must pass unchanged)

**Interfaces:**

- Consumes: `resolvePayloadValue(payload, path)` from
  `contracts/signal-utils.ts` (handles flat dotted key → codegraph
  nested-symbols `codegraph.symbols.{file|chunk}.X` → plain nested traversal).
- Produces (UNCHANGED signatures — 10 derived-signal consumers untouched):
  `codegraphFileNum(payload, suffix): number`,
  `codegraphFileBool(payload, suffix): boolean`,
  `codegraphChunkNum(payload, suffix): number`. Private `getSymbols`,
  `readNested`, `SymbolsScope`, `CodegraphLike` are DELETED.

- [ ] **Step 1: Baseline green**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/`
Expected: PASS.

- [ ] **Step 2: Rewrite helpers.ts as thin delegates**

Replace the ENTIRE file content with:

```typescript
/**
 * Codegraph-specific payload accessors for derived signals.
 *
 * All payload addressing routes through the canonical resolvePayloadValue
 * (contracts/signal-utils.ts) — the single source of truth for payload
 * shapes (flat dotted key, codegraph nested-symbols
 * `codegraph.symbols.{file|chunk}.X`, plain nested traversal). These wrappers
 * add only suffix prefixing and num/bool coercion.
 *
 * Mirrors the git helpers at
 * `src/core/domains/trajectory/git/rerank/derived-signals/helpers.ts`.
 */

import { resolvePayloadValue } from "../../../../../../contracts/signal-utils.js";

/** Read a numeric `codegraph.file.<suffix>` value via the canonical resolver. */
export function codegraphFileNum(
  payload: Record<string, unknown>,
  suffix: string,
): number {
  const n = Number(
    resolvePayloadValue(payload, `codegraph.file.${suffix}`) ?? 0,
  );
  return Number.isNaN(n) ? 0 : n;
}

/** Read a boolean `codegraph.file.<suffix>` value via the canonical resolver. */
export function codegraphFileBool(
  payload: Record<string, unknown>,
  suffix: string,
): boolean {
  return resolvePayloadValue(payload, `codegraph.file.${suffix}`) === true;
}

/** Read a numeric `codegraph.chunk.<suffix>` value via the canonical resolver. */
export function codegraphChunkNum(
  payload: Record<string, unknown>,
  suffix: string,
): number {
  const n = Number(
    resolvePayloadValue(payload, `codegraph.chunk.${suffix}`) ?? 0,
  );
  return Number.isNaN(n) ? 0 : n;
}
```

(Import depth is six `../` — `derived-signals` sits 6 levels under `src/core/`.)

- [ ] **Step 3: Type-check + targeted tests**

Run:
`npx tsc --noEmit && npx vitest run tests/core/domains/trajectory/codegraph/`
Expected: 0 errors, PASS — flat fixtures resolve via canonical step 1, nested
production shape via step 2.

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/helpers.ts
git commit -m "refactor(signals): codegraph helpers delegate to canonical resolvePayloadValue

Why: SSoT violation (risk-assessment 2026-07-20, epic tea-rags-mcp-3f21g) —
local reader duplicated payload addressing with inverted resolution order;
bugFixRate 100% on this hub (fanIn 10).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: git/stats readPayloadPath delegates to canonical resolver

**Files:**

- Modify: `src/core/domains/trajectory/git/stats/utils.ts` (full-file rewrite,
  15 → ~10 lines)
- Test: none added/changed (`tests/core/domains/trajectory/git/stats/` must pass
  unchanged)

**Interfaces:**

- Produces (UNCHANGED): `readPayloadPath(payload, path): unknown` — consumers
  `author-counts.ts`, `file-time-range.ts`, `chunk-time-range.ts`,
  `git-data-paths.ts` keep importing from `./utils.js`, untouched.

- [ ] **Step 1: Rewrite utils.ts as a thin delegate**

Replace the ENTIRE file content with:

```typescript
import { resolvePayloadValue } from "../../../../contracts/signal-utils.js";

/**
 * Read a value from a payload using a dot-notation path.
 * Thin delegate of the canonical resolvePayloadValue
 * (contracts/signal-utils.ts) — the single source of truth for payload
 * addressing.
 */
export function readPayloadPath(
  payload: Record<string, unknown>,
  path: string,
): unknown {
  return resolvePayloadValue(payload, path);
}
```

- [ ] **Step 2: Type-check + targeted tests**

Run:
`npx tsc --noEmit && npx vitest run tests/core/domains/trajectory/git/stats/`
Expected: 0 errors, PASS (flat-first semantics identical for `git.*` paths).

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/trajectory/git/stats/utils.ts
git commit -m "refactor(signals): git stats readPayloadPath delegates to canonical resolver

Why: duplicate payload traversal bypassed the declared SSoT
(contracts/signal-utils resolvePayloadValue); epic tea-rags-mcp-3f21g.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: stats-recompute drops its local mirror

**Files:**

- Modify: `src/core/domains/ingest/infra/stats-recompute.ts` (delete local
  `readPayloadPath` at lines 252-267, switch the single call site at line 153)
- Test: none added/changed (`tests/core/domains/ingest/` must pass unchanged)

**Interfaces:**

- Consumes: `resolvePayloadValue` from `contracts/signal-utils.ts` (ingest →
  contracts is a legal foundation import; the old "kept local to avoid
  re-exporting an ingest-internal helper" reason is void — the canonical lives
  in contracts, not in ingest).

- [ ] **Step 1: Add the import**

Add to the import section of `stats-recompute.ts`:

```typescript
import { resolvePayloadValue } from "../../../contracts/signal-utils.js";
```

- [ ] **Step 2: Switch the call site**

At line 153, replace:

```typescript
const v = readPayloadPath(point.payload, signalKey);
```

with:

```typescript
const v = resolvePayloadValue(point.payload, signalKey);
```

- [ ] **Step 3: Delete the local mirror**

Delete the doc comment + function at lines 252-267
(`/** Read a value from Qdrant payload via dot-path … */` through the closing
brace of the local `readPayloadPath`).

- [ ] **Step 4: Type-check + targeted tests + full suite**

Run: `npx tsc --noEmit && npx vitest run tests/core/domains/ingest/` Expected: 0
errors, PASS.

Then run the FULL suite once (closes the group): `npx vitest run` Expected:
PASS.

- [ ] **Step 5: Verify tests untouched (group acceptance)**

Run: `git diff --stat main -- tests/` Expected: empty output for this group's
commits (test-invariants rule).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/infra/stats-recompute.ts
git commit -m "refactor(signals): stats-recompute uses canonical resolvePayloadValue

Why: local mirror lacked the codegraph nested-symbols mapping that
collection-stats already resolves — latent divergence for codegraph
support-key backfill; epic tea-rags-mcp-3f21g.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Beads:** three tasks under epic `tea-rags-mcp-3f21g` mirror Tasks 1-3 (created
during plan sync).
