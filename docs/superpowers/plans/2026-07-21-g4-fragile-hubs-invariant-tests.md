# G4: Fragile Hubs — Invariant Tests + Targeted Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> dinopowers:executing-plans to implement this plan task-by-task. Each
> test-writing Task MUST run dinopowers:test-driven-development first (pattern
> search over the module's existing tests) — invariant specs below are
> assertion-level (concrete inputs → expected observables); transcribe them into
> the module's established test conventions (mocks, fixtures, assertion style).
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the observable invariants of the four fragile hubs (isHub +
concerning bugFixRate) with behavioral tests, then extract ONLY where a method
stays oversized.

**Architecture:** Phase 1 — characterization tests born green against current
behavior, each sanity-checked by a temporary local mutation (flip → test fails →
revert). Phase 2 — one conditional extraction (`applyFileSignals`, 133 LOC > 87
threshold), behavior-preserving. No boundary redesign.

**Tech Stack:** TypeScript ESM, vitest.

## Global Constraints

- Spec:
  `docs/superpowers/specs/2026-07-21-architecture-drift-refactoring-design.md`,
  Group 4. Epic: `tea-rags-mcp-15h1s`. Branch: `worktree-arch-drift-design`.
- `.claude/rules/test-invariants.md`: new tests assert observable
  behavior/invariants, never internals. EXISTING tests untouched.
- Coverage thresholds never lowered; new tests only raise coverage.
- `adapters/qdrant/errors.ts` is a deep-silo file
  (`.claude/rules/silo-pairing.md`) — its commit MUST carry a `Why:` line.
- Each Task starts with an inventory step: skim the module's existing test
  file(s); an invariant already pinned by an existing test is SKIPPED (note it
  in the Task's commit message), not duplicated.
- Commits: `test(<scope>)` (non-release bump). Commit ≠ push.

---

### Task 1: Pin `resolveCollection` identity invariants

**Files:**

- Test: `tests/core/infra/collection-name.test.ts` (extend or create — inventory
  first)
- Source (read-only): `src/core/infra/collection-name.ts:30-102`

**Invariants** (each becomes one `it` unless already pinned):

| #   | Given                                                             | Expect                                                                  |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `{collection: "c1", project: "p", path: "/x"}`                    | `collectionName === "c1"` (collection beats project beats path)         |
| 2   | `{project: "known"}`, registry entry path exists                  | entry's `collectionName` + entry's `path` returned                      |
| 3   | `{project: "unknown"}`, registry lists `["a","b"]`                | throws `ProjectNotRegisteredError` carrying available names             |
| 4   | `{project: "moved"}`, entry.path set but directory does NOT exist | throws `StaleProjectAliasError`                                         |
| 5   | `{project: "stub"}`, entry.path EMPTY string                      | NO stale error — resolves to entry's collectionName (recovery stub)     |
| 6   | `{path: "/renamed"}`, registry `findByPath` returns entry         | entry's `collectionName` (NOT a fresh hash)                             |
| 7   | `{path: "/new"}`, registry has no entry                           | `code_` + first 8 hex of md5(absolute path); deterministic across calls |
| 8   | `{}`                                                              | throws `CollectionNotProvidedError`                                     |

Worked example for #6 (anchor the style; adapt mocks to the existing file's
conventions during execution):

```typescript
it("honors a moved alias: path lookup returns the registered collectionName", () => {
  const registry = {
    findByName: () => null,
    findByPath: (p: string) =>
      p === "/renamed"
        ? { collectionName: "code_old12345", path: "/renamed" }
        : null,
    list: () => [],
  } as unknown as CollectionRegistry;

  const { collectionName } = resolveCollection(registry, { path: "/renamed" });

  expect(collectionName).toBe("code_old12345");
});
```

- [ ] **Step 1: Inventory** —
      `rg "describe|it\(" tests/core/infra/collection-name.test.ts` (create the
      file if absent); map hits against invariants 1-8, drop pinned ones.
- [ ] **Step 2: Write missing invariant tests**
      (dinopowers:test-driven-development conventions pass first).
- [ ] **Step 3: Run** `npx vitest run tests/core/infra/collection-name.test.ts`
      — PASS.
- [ ] **Step 4: Mutation sanity** — locally swap priority of
      `collection`/`project` branches in `resolveCollection`, rerun (expect FAIL
      on #1), revert, rerun (PASS).
- [ ] **Step 5: Commit** —
      `test(infra): pin resolveCollection identity invariants (epic tea-rags-mcp-15h1s)`.

---

### Task 2: Pin `EnrichmentApplier` write-path invariants

**Files:**

- Test: `tests/core/domains/ingest/pipeline/enrichment/applier.test.ts` (extend
  — inventory first)
- Source (read-only):
  `src/core/domains/ingest/pipeline/enrichment/applier.ts:37-361`

**Invariants:**

| #   | Given                                               | Expect                                                                                       |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | file overlay present for relPath                    | payload written as `{[providerKey]: {file: data}}` (+ `enrichedAt` when passed)              |
| 2   | file WITHOUT overlay, `isIgnored(relPath) === true` | counted in `ignoredFiles`, NOT in `missedFiles`; NO payload stamp written for it             |
| 3   | file WITHOUT overlay, not ignored                   | counted in `missedFiles`; path appears in `missedPathSamples` (samples capped at 10)         |
| 4   | same relPath in TWO applyFileSignals batches        | `onApply` file-level `applied` counts it ONCE (Set-deduped cumulative)                       |
| 5   | two chunk batches of sizes 3 and 2 for one provider | `onApply` chunk-level `applied` is a running sum: 3 then 5                                   |
| 6   | `transform` provided                                | called per file with `(rawData, maxEndLine)`; transformed value is what lands in the payload |
| 7   | >100 point-ops in one call                          | writes split into batches of ≤100 (BATCH_SIZE), all applied                                  |

- [ ] **Step 1: Inventory** existing applier tests; map against 1-7, drop
      pinned.
- [ ] **Step 2: Write missing invariant tests** (mock `QdrantManager` per
      existing convention; assert on captured `setPayload` calls + public
      getters + `onApply` events — never private fields).
- [ ] **Step 3: Run**
      `npx vitest run tests/core/domains/ingest/pipeline/enrichment/` — PASS.
- [ ] **Step 4: Mutation sanity** — swap `ignoredPaths`/`missedTracker` branches
      locally, expect FAIL on #2/#3, revert.
- [ ] **Step 5: Commit** —
      `test(ingest): pin EnrichmentApplier write-path invariants (epic tea-rags-mcp-15h1s)`.

---

### Task 3: Pin DuckDB pool lifecycle invariants

**Files:**

- Test: `tests/core/adapters/duckdb/pool.test.ts` (extend — inventory first)
- Source (read-only): `src/core/adapters/duckdb/pool.ts`

**Invariants:**

| #   | Given                                                                     | Expect                                                                                   |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | two `acquire("c1")` calls                                                 | SAME handle identity (cached entry), initHook + migrations ran ONCE                      |
| 2   | daemon mode: `acquireWrite("c1")` then `acquireRead`/`acquireWrite` again | ONE shared symbol table instance per collection (regression pin for the fresh-table bug) |
| 3   | `release("c1")` then `acquire("c1")`                                      | new entry created (initHook runs again)                                                  |
| 4   | collection name with `/`, control chars                                   | DB file leaf is sanitised (`[^a-zA-Z0-9_.-]` → `_`)                                      |
| 5   | daemon fingerprint mismatch + `respawn` wired                             | drain → respawn invoked → reconnect, at most ONE retry                                   |
| 6   | fingerprint absent on either side (legacy peer)                           | NO restart — proceeds with existing daemon                                               |

- [ ] **Step 1: Inventory** existing pool tests; map against 1-6, drop pinned
      (2, 5, 6 likely pinned by daemon-era tests — verify, don't assume).
- [ ] **Step 2: Write missing invariant tests.**
- [ ] **Step 3: Run** `npx vitest run tests/core/adapters/duckdb/` — PASS.
- [ ] **Step 4: Commit** —
      `test(adapters): pin duckdb pool lifecycle invariants (epic tea-rags-mcp-15h1s)`.

---

### Task 4: Pin Qdrant error taxonomy invariants

**Files:**

- Test: `tests/core/adapters/qdrant/errors.test.ts` (extend — inventory first)
- Source (read-only): `src/core/adapters/qdrant/errors.ts`

**Invariants:**

| #   | Given                                           | Expect                                                                                                                                       |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | each error class constructed                    | stable `(code, httpStatus)` pairs — e.g. UNAVAILABLE/503, STARTING/503, RECOVERING/503, TIMEOUT/504, POINT_NOT_FOUND/404, ALREADY_EXISTS/409 |
| 2   | `QdrantStartingError` with `{pid, storagePath}` | hint contains platform-appropriate observability commands (pid AND storage lines)                                                            |
| 3   | Starting/Recovering with NO details             | hint contains no observability block (no trailing command lines)                                                                             |
| 4   | any error with `cause`                          | raw error preserved in `cause`, never interpolated into `message` (typed-errors rule)                                                        |

- [ ] **Step 1: Inventory** existing qdrant error tests; map against 1-4.
- [ ] **Step 2: Write missing invariant tests** (mock `process.platform` per
      existing convention if platform branches are asserted).
- [ ] **Step 3: Run** `npx vitest run tests/core/adapters/qdrant/` — PASS.
- [ ] **Step 4: Commit** (deep-silo file — `Why:` REQUIRED):

```bash
git commit -m "test(adapters): pin qdrant error taxonomy invariants

Why: errors.ts is a fanIn-12 hub with bugFixRate 44% (epic tea-rags-mcp-15h1s);
pinning (code, httpStatus, hint) contracts before any structural work.
Trade-off: platform-branch tests add process.platform mocking, accepted for
hint-correctness coverage.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5 (conditional): Extract `applyFileSignals` private helpers

**Precondition:** run AFTER Tasks 1-4 are committed. Execute ONLY if
`applyFileSignals` still exceeds the 87-LOC decomposition threshold (133 LOC
today) — it will, unless Phase 1 revealed dead branches.

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/applier.ts:119-361`
- Test: none added/changed (Tasks 1-4 tests are the safety net; test-invariants
  rule applies)

**Shape:** extract three private methods, same class, no signature changes:

- `groupItemsByFile(items, pathBase): Map<string, ChunkItem[]>` — the grouping
  loop at the head of `applyFileSignals`;
- `buildFilePayloadOps(byFile, fileMetadata, transform, enrichedAt, isIgnored)`
  — per-file transform + payload-op assembly + matched/ignored/missed tracking;
- `flushFileOps(collectionName, providerKey, ops)` — BATCH_SIZE-chunked
  `batchSetPayloadWithRetry` loop + `onApply` emission.

Behavior identical; the public method becomes an ~15-line orchestrator.

- [ ] **Step 1:** Extract the three methods (move code verbatim, wire calls).
- [ ] **Step 2:**
      `npx tsc --noEmit && npx vitest run tests/core/domains/ingest/pipeline/enrichment/`
      — PASS with ZERO test edits.
- [ ] **Step 3:** `git diff --stat -- tests/` — empty.
- [ ] **Step 4: Commit** —
      `refactor(ingest): decompose applyFileSignals into grouped private helpers (epic tea-rags-mcp-15h1s)`.

**Beads:** five tasks under epic `tea-rags-mcp-15h1s` mirror Tasks 1-5 (Task 5
marked conditional).
