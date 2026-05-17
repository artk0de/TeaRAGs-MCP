# Tech Debt Q2 2026 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `dinopowers:subagent-driven-development` (recommended) or
> `dinopowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve four classes of tech debt — error taxonomy split, ingest bug
attractors, oversized methods, silo mitigation — across 26 tasks in a single
beads epic.

**Architecture:** Per-domain `*ErrorCode` unions replace the centralized
`contracts/errors.ts ErrorCode` (Option A — preserves layer rules from
`.claude/rules/domain-boundaries.md`: contracts cannot import from domains).
Bug-attractor refactors land behind failing tests written first (TDD-strict).
Oversized methods get behavior-preserving extractions ridden by existing tests.
Silo mitigation combines a small `app.ts` decomposition with a documented
pairing process.

**Tech Stack:** TypeScript 5.x, ESM, Vitest, Tree-sitter, Qdrant client, ONNX
Runtime, Ollama. All file paths absolute from repo root unless noted.

---

## Constraints (apply to every task)

1. **Business-logic tests are immutable.** Moving tests file-to-file (mirror new
   module structure) is allowed. Adding new tests for newly-extracted helpers is
   allowed. Modifying implementation-detail tests (mocks, internal contracts) is
   allowed. **Rewriting business-logic tests is forbidden.** If a business-logic
   test fails after a refactor, the refactor is wrong — fix the code, not the
   test. See memory `feedback_business_logic_tests_immutable`.
2. **Layer rules from `.claude/rules/domain-boundaries.md` are inviolate.**
   `core/contracts/` cannot import from `core/domains/*` or `core/api/`. This
   forces M1's per-domain unions design (Option A).
3. **Silo pairing.** When touching any deep-silo file (per the impact table in
   the spec — `contracts/errors.ts`, `api/errors.ts`, `domains/*/errors.ts`,
   `api/public/app.ts`, `adapters/qdrant/errors.ts`, `domains/ingest/errors.ts`,
   `domains/explore/errors.ts`, `domains/trajectory/errors.ts`,
   `adapters/errors.ts`), commit message MUST include `Why:` line stating intent
   and trade-offs. M4.2 formalizes this rule into
   `.claude/rules/silo-pairing.md`.
4. **Beads sync.** Each Task in this plan has a 1:1 beads task created with the
   labels specified per `.claude/rules/.local/beads-labels.md`.
   `bd update <id> --status=in_progress` before starting; `bd close <id>` after
   passing tests + commit + push. See `.claude/rules/.local/plan-beads-sync.md`.
5. **Commit conventions.** Follow `.claude/rules/commit-rules.md`. Type+scope
   per task is documented in each Task's commit step.
6. **Pre-commit hook.** Runs vitest + type-check + commitlint in parallel on
   staged TS files. Do not bypass with `--no-verify`.

## File structure

### Created

| Path                                                                        | Purpose                                                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/core/contracts/errors.ts` (modified)                                   | Reduces to `TeaRagsErrorContract` interface + `type ErrorCode = string` (loose, runtime contract) |
| `src/core/api/errors.ts` (modified)                                         | Adds `export type InputErrorCode = ...` local union                                               |
| `src/core/adapters/errors.ts` (modified)                                    | Adds `export type InfraErrorCode = ...` local union                                               |
| `src/core/domains/ingest/errors.ts` (modified)                              | Adds `export type IngestErrorCode = ...`, switches base ctor to use it                            |
| `src/core/domains/explore/errors.ts` (modified)                             | Adds `export type ExploreErrorCode = ...`                                                         |
| `src/core/domains/trajectory/errors.ts` (modified)                          | Adds `export type TrajectoryErrorCode = ...`                                                      |
| `src/bootstrap/errors.ts` (modified)                                        | Adds `export type ConfigErrorCode = ...`                                                          |
| `src/core/infra/errors.ts` (modified)                                       | Relaxes `TeaRagsError.code: ErrorCode` to `string` (matches the new loose contract)               |
| `src/core/domains/ingest/sync/deletion-retry-helper.ts`                     | New — extracted from `performDeletion`                                                            |
| `src/core/domains/ingest/sync/batch-delete-executor.ts`                     | New — extracted from `performDeletion`                                                            |
| `src/core/domains/ingest/optimizer-lifecycle.ts`                            | New — pause/resume guard, extracted from `IndexPipeline`                                          |
| `src/core/domains/ingest/heartbeat-guard.ts`                                | New — start/stop with cleanup, extracted from `IndexPipeline`                                     |
| `src/core/domains/ingest/pipeline/enrichment/missed-file-tracker.ts`        | New — extracted from `EnrichmentApplier`                                                          |
| `src/core/domains/trajectory/git/infra/build-accumulators.ts`               | New — extracted from `chunk-reader`                                                               |
| `src/core/domains/trajectory/git/infra/walk-commits.ts`                     | New — extracted from `chunk-reader`                                                               |
| `src/core/domains/trajectory/git/infra/assemble-overlays.ts`                | New — extracted from `chunk-reader`                                                               |
| `src/mcp/tools/code/register-search-tools.ts`                               | New — extracted from `registerCodeTools`                                                          |
| `src/mcp/tools/code/register-symbol-tools.ts`                               | New — extracted from `registerCodeTools`                                                          |
| `src/mcp/tools/code/register-rank-tools.ts`                                 | New — extracted from `registerCodeTools`                                                          |
| `src/mcp/tools/code/register-similar-tools.ts`                              | New — extracted from `registerCodeTools`                                                          |
| `.claude/rules/silo-pairing.md`                                             | New — M4.2 process rule                                                                           |
| `tests/core/domains/ingest/sync/deletion-retry-helper.test.ts`              | New (M2.A.1, M2.A.2)                                                                              |
| `tests/core/domains/ingest/optimizer-lifecycle.test.ts`                     | New (M2.B.1)                                                                                      |
| `tests/core/domains/ingest/heartbeat-guard.test.ts`                         | New (M2.B.2)                                                                                      |
| `tests/core/domains/ingest/pipeline/enrichment/missed-file-tracker.test.ts` | New (M2.C.1)                                                                                      |

### Modified (decomposed)

| Path                                                            | What changes                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/core/domains/ingest/sync/deletion-strategy.ts`             | `performDeletion` becomes orchestrator, calls retry-helper + batch-executor   |
| `src/core/domains/ingest/indexing.ts`                           | `processAndTrack` block uses OptimizerLifecycle + HeartbeatGuard              |
| `src/core/domains/ingest/pipeline/enrichment/applier.ts`        | `applyFileSignals` delegates missed-file path to MissedFileTracker            |
| `src/core/domains/ingest/reindexing.ts`                         | Block 322-509 split into ≤3 functions                                         |
| `src/core/domains/trajectory/git/infra/chunk-reader.ts`         | `buildChunkChurnMapUncached` becomes orchestrator over the 3 new helpers      |
| `src/mcp/tools/code.ts`                                         | `registerCodeTools` becomes orchestrator delegating to 4 register-\*-tools.ts |
| `src/core/api/public/app.ts`                                    | `createApp` body extracted into `wireFacades` + `wireOps` (private to file)   |
| `CLAUDE.md`                                                     | Adds reference to `silo-pairing.md`                                           |
| Domain barrels (`domains/{ingest,explore,trajectory}/index.ts`) | Re-export per-domain `*ErrorCode` types                                       |

### Out of scope (deferred per spec)

`adapters/embeddings/{ollama,onnx}/*.ts`, `website/docusaurus.config.ts`,
documentation regeneration. Do not touch.

---

## Milestone 1 — Error Taxonomy Split (Tasks 1-7)

**Risk:** Low (type-only changes, runtime behavior preserved). Each task is a
self-contained per-domain extraction. M1.7 is the keystone collapse.

**Why Option A (per-domain unions, no aggregate in contracts):**
`.claude/rules/domain-boundaries.md` forbids `core/contracts/` from importing
`core/domains/*`. The spec's original "aggregate union in contracts/" approach
violates this. Option A keeps strict typing per domain, relaxes
`contracts/errors.ts ErrorCode` to `string` (matches the runtime contract on
`TeaRagsErrorContract.code`).

### Task 1: Inventory baseline + verify pre-commit hook

**Files:**

- Read: `src/core/contracts/errors.ts:22-96`

- [ ] **Step 1: Snapshot current ErrorCode union as baseline**

  Read `src/core/contracts/errors.ts` and copy lines 22-96 to a scratch file
  `$CLAUDE_JOB_DIR/errorcode-baseline.txt`. This is the master list — every
  literal must appear in exactly one new domain union after M1.7.

- [ ] **Step 2: Run pre-commit hook dry-run**

  Run: `npx vitest run --reporter=dot tests/core/contracts/ 2>&1 | tail -5`
  Expected: PASS or "No tests found" (proves baseline is green).

  Run: `npm run type-check 2>&1 | tail -5` Expected: no errors.

- [ ] **Step 3: Commit baseline note**

  ```bash
  git status   # expect clean (no changes)
  ```

  No commit needed — this is a verification task. Close beads task with
  `--reason="baseline verified, ErrorCode has 64 codes across 7 categories"`.

**Beads:** title="techdebt-q2 baseline verification", labels: `architecture`.

---

### Task 2 (M1.1): Create `InputErrorCode` in `core/api/errors.ts`

**Files:**

- Modify: `src/core/api/errors.ts:5-19`

- [ ] **Step 1: Add `InputErrorCode` union after the imports**

  Edit `src/core/api/errors.ts` — replace line 5 (the `import type` line) and
  add the union right above the abstract class:

  ```typescript
  // Replace:
  import type { ErrorCode } from "../contracts/errors.js";

  // With:
  /**
   * Input validation error codes. Local strict union — used by InputValidationError
   * subclasses. Aggregates into the runtime ErrorCode = string contract.
   */
  export type InputErrorCode =
    | "INPUT_COLLECTION_NOT_PROVIDED"
    | "INPUT_MISSING_ARGUMENT"
    | "INPUT_INVALID_PARAMETER"
    | "INPUT_PROJECT_NOT_REGISTERED"
    | "INPUT_PROJECT_NAME_NOT_UNIQUE"
    | "INPUT_PROJECT_NAME_INVALID"
    | "INPUT_PROJECT_PATH_MISSING"
    | "INPUT_PATH_NOT_EXISTS";
  ```

- [ ] **Step 2: Update `InputValidationError` constructor signature**

  Change `code: ErrorCode` to `code: InputErrorCode` in lines 12-19.

- [ ] **Step 3: Run type-check**

  Run: `npx tsc --noEmit 2>&1 | grep "src/core/api/errors.ts" | head -5`
  Expected: no errors. Subclasses already pass literals that match the new
  union.

- [ ] **Step 4: Run tests**

  Run: `npx vitest run tests/core/api/ --reporter=dot 2>&1 | tail -3` Expected:
  PASS (or "No tests found" — both fine).

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/api/errors.ts
  git commit -m "$(cat <<'EOF'
  refactor(api): extract InputErrorCode local union from contracts

  Why: contracts/errors.ts cannot import from domains per domain-boundaries.md;
  per-domain local unions preserve type safety without violating layer rules.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M1.1: extract InputErrorCode in api/errors.ts", labels: `api`,
`architecture`.

---

### Task 3 (M1.2): Create `InfraErrorCode` in `core/adapters/errors.ts`

**Files:**

- Modify: `src/core/adapters/errors.ts`

- [ ] **Step 1: Add union before the abstract class**

  ```typescript
  /**
   * Infrastructure error codes. Local strict union — Qdrant, embeddings, git CLI,
   * registry. Concrete InfraError subclasses live in
   * adapters/{qdrant,embeddings,git,registry}/errors.ts.
   */
  export type InfraErrorCode =
    // Qdrant
    | "INFRA_QDRANT_UNAVAILABLE"
    | "INFRA_QDRANT_STARTING"
    | "INFRA_QDRANT_RECOVERING"
    | "INFRA_QDRANT_TIMEOUT"
    | "INFRA_QDRANT_OPERATION_FAILED"
    | "INFRA_QDRANT_OPTIMIZATION_IN_PROGRESS"
    | "INFRA_QDRANT_VERSION_TOO_OLD"
    | "INFRA_QDRANT_DOWNGRADE_NOT_SUPPORTED"
    | "INFRA_COLLECTION_ALREADY_EXISTS"
    | "INFRA_ALIAS_OPERATION"
    | "INFRA_QDRANT_POINT_NOT_FOUND"
    // Embeddings
    | "INFRA_OLLAMA_UNAVAILABLE"
    | "INFRA_OLLAMA_TIMEOUT"
    | "INFRA_OLLAMA_RESPONSE_ERROR"
    | "INFRA_OLLAMA_CONTEXT_OVERFLOW"
    | "INFRA_OLLAMA_MODEL_MISSING"
    | "INFRA_ONNX_MODEL_LOAD_FAILED"
    | "INFRA_ONNX_INFERENCE_FAILED"
    | "INFRA_ONNX_PACKAGE_MISSING"
    | "INFRA_OPENAI_RATE_LIMIT"
    | "INFRA_OPENAI_AUTH_FAILED"
    | "INFRA_COHERE_RATE_LIMIT"
    | "INFRA_COHERE_API"
    | "INFRA_VOYAGE_RATE_LIMIT"
    | "INFRA_VOYAGE_API"
    | "INFRA_EMBEDDING_MODEL_MISMATCH"
    // Git
    | "INFRA_GIT_CLI_NOT_FOUND"
    | "INFRA_GIT_CLI_TIMEOUT"
    // Registry
    | "INFRA_REGISTRY_FILE_CORRUPTED"
    | "INFRA_REGISTRY_WRITE_FAILED"
    | "INFRA_REGISTRY_CONCURRENCY"
    | "INFRA_REGISTRY_NAME_CONFLICT";
  ```

- [ ] **Step 2: Verify concrete InfraError subclasses still type-check**

  Run:
  `npx tsc --noEmit 2>&1 | grep -E "(qdrant|embeddings|git|registry)/errors.ts" | head -10`
  Expected: no errors. Concrete subclasses (in `adapters/qdrant/errors.ts` etc.)
  extend `InfraError` and pass `code` literals — TypeScript widens to `string`
  via current `ErrorCode` import. After the constructor signature is tightened
  in M1.7, those literals must satisfy `InfraErrorCode`.

- [ ] **Step 3: Commit**

  ```bash
  git add src/core/adapters/errors.ts
  git commit -m "$(cat <<'EOF'
  refactor(adapters): extract InfraErrorCode local union

  Why: per-domain unions replace centralized ErrorCode in contracts. Layer
  rule: contracts/ cannot import from domains/, so each domain owns its slice.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M1.2: extract InfraErrorCode in adapters/errors.ts", labels:
`api`, `architecture`.

---

### Task 4 (M1.3): Create `IngestErrorCode` in `core/domains/ingest/errors.ts`

**Files:**

- Modify: `src/core/domains/ingest/errors.ts:5-17`
- Modify: `src/core/domains/ingest/index.ts` (barrel re-export)

- [ ] **Step 1: Add union before the IngestError abstract class**

  Replace import on line 5:

  ```typescript
  // Replace:
  import type { ErrorCode } from "../../contracts/errors.js";

  // With:
  /**
   * Ingest domain error codes. Local strict union.
   */
  export type IngestErrorCode =
    | "INGEST_NOT_INDEXED"
    | "INGEST_COLLECTION_EXISTS"
    | "INGEST_SNAPSHOT_MISSING"
    | "INGEST_SNAPSHOT_CORRUPTED"
    | "INGEST_MIGRATION_FAILED"
    | "INGEST_REINDEX_FAILED"
    | "INGEST_INDEXING_FAILED"
    | "INGEST_PARTIAL_DELETION"
    | "INGEST_PIPELINE_NOT_STARTED"
    | "INGEST_INVARIANT_VIOLATED";
  ```

- [ ] **Step 2: Update `IngestError` ctor signature on line 14**

  Change `code: ErrorCode` → `code: IngestErrorCode`.

- [ ] **Step 3: Add re-export to `domains/ingest/index.ts`**

  Append: `export type { IngestErrorCode } from "./errors.js";` Read the barrel
  first to find the right insertion point relative to existing
  `export * from "./errors.js"` (if present, the type is already covered).

- [ ] **Step 4: Type-check**

  Run: `npx tsc --noEmit 2>&1 | grep "domains/ingest" | head -10` Expected: no
  errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/domains/ingest/errors.ts src/core/domains/ingest/index.ts
  git commit -m "$(cat <<'EOF'
  refactor(ingest): extract IngestErrorCode local union, re-export from barrel

  Why: per-domain ownership of error codes per domain-boundaries.md.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M1.3: extract IngestErrorCode + barrel re-export", labels:
`api`, `architecture`.

---

### Task 5 (M1.4): Create `ExploreErrorCode` in `core/domains/explore/errors.ts`

**Files:**

- Modify: `src/core/domains/explore/errors.ts:5`
- Modify: `src/core/domains/explore/index.ts`

- [ ] **Step 1: Add union, replace ErrorCode import**

  Replace line 5:

  ```typescript
  /**
   * Explore domain error codes. Local strict union.
   */
  export type ExploreErrorCode =
    | "EXPLORE_COLLECTION_NOT_FOUND"
    | "EXPLORE_HYBRID_NOT_ENABLED"
    | "EXPLORE_INVALID_QUERY"
    | "EXPLORE_INVALID_STRATEGY"
    | "EXPLORE_CHUNK_NOT_FOUND";
  ```

- [ ] **Step 2: Update `ExploreError` ctor on line 13**

  Change `code: ErrorCode` → `code: ExploreErrorCode`.

- [ ] **Step 3: Add `export type { ExploreErrorCode }` to
      `domains/explore/index.ts`**

- [ ] **Step 4: Type-check + commit**

  ```bash
  npx tsc --noEmit 2>&1 | grep "domains/explore" | head -5
  git add src/core/domains/explore/errors.ts src/core/domains/explore/index.ts
  git commit -m "$(cat <<'EOF'
  refactor(explore): extract ExploreErrorCode local union

  Why: per-domain ownership of error codes per domain-boundaries.md.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M1.4: extract ExploreErrorCode", labels: `api`,
`architecture`.

---

### Task 6 (M1.5): Create `TrajectoryErrorCode` in `core/domains/trajectory/errors.ts`

**Files:**

- Modify: `src/core/domains/trajectory/errors.ts:7`
- Modify: `src/core/domains/trajectory/index.ts`

- [ ] **Step 1: Add union, replace import**

  Replace line 7:

  ```typescript
  /**
   * Trajectory domain error codes (git + static).
   */
  export type TrajectoryErrorCode =
    | "TRAJECTORY_GIT_BLAME_FAILED"
    | "TRAJECTORY_GIT_LOG_TIMEOUT"
    | "TRAJECTORY_GIT_NOT_AVAILABLE"
    | "TRAJECTORY_STATIC_PARSE_FAILED";
  ```

- [ ] **Step 2: Update `TrajectoryError` ctor on line 15**

  Change `code: ErrorCode` → `code: TrajectoryErrorCode`.

- [ ] **Step 3: Add `export type { TrajectoryErrorCode }` to
      `domains/trajectory/index.ts`**

- [ ] **Step 4: Type-check + commit**

  ```bash
  npx tsc --noEmit 2>&1 | grep "domains/trajectory" | head -5
  git add src/core/domains/trajectory/errors.ts src/core/domains/trajectory/index.ts
  git commit -m "$(cat <<'EOF'
  refactor(trajectory): extract TrajectoryErrorCode local union

  Why: per-domain ownership of error codes per domain-boundaries.md.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M1.5: extract TrajectoryErrorCode", labels: `api`,
`architecture`.

---

### Task 7 (M1.6): Create `ConfigErrorCode` in `src/bootstrap/errors.ts`

**Files:**

- Modify: `src/bootstrap/errors.ts`

- [ ] **Step 1: Read current `src/bootstrap/errors.ts`**

  This file already exists. Check its current `ErrorCode` import and concrete
  `ConfigError` subclasses.

- [ ] **Step 2: Add `ConfigErrorCode` union, replace ErrorCode import if
      present**

  ```typescript
  /**
   * Bootstrap config error codes.
   */
  export type ConfigErrorCode =
    | "CONFIG_VALUE_INVALID"
    | "CONFIG_VALUE_MISSING"
    | "CONFIG_NOT_INITIALIZED";
  ```

- [ ] **Step 3: Update `ConfigError` ctor signature to use `ConfigErrorCode`**

- [ ] **Step 4: Type-check + commit**

  ```bash
  npx tsc --noEmit 2>&1 | grep "bootstrap/errors" | head -5
  git add src/bootstrap/errors.ts
  git commit -m "$(cat <<'EOF'
  refactor(config): extract ConfigErrorCode local union

  Why: per-domain ownership of error codes; aligns bootstrap with the rest of
  the M1 split.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M1.6: extract ConfigErrorCode in bootstrap", labels: `api`,
`architecture`.

---

### Task 8 (M1.7): Collapse `core/contracts/errors.ts` + relax `infra/errors.ts`

**Files:**

- Modify: `src/core/contracts/errors.ts:22-96` (delete the `ErrorCode` union)
- Modify: `src/core/infra/errors.ts:5,14,19` (relax `code: ErrorCode` to
  `string`)
- Modify: `src/core/contracts/index.ts` (barrel — drop `ErrorCode` export if
  present)

- [ ] **Step 1: Delete the `ErrorCode` union from `contracts/errors.ts`**

  Replace lines 17-96 with:

  ```typescript
  /**
   * Loose runtime contract for error codes. Strict per-domain unions live in
   * each domain's `errors.ts` (see `IngestErrorCode`, `ExploreErrorCode`,
   * `TrajectoryErrorCode`, `InfraErrorCode`, `InputErrorCode`,
   * `ConfigErrorCode`). Aggregating those here would violate
   * `domain-boundaries.md` (contracts cannot import from domains).
   */
  export type ErrorCode = string;
  ```

- [ ] **Step 2: Relax `infra/errors.ts` import + signature**

  Edit `src/core/infra/errors.ts`:
  - Line 5: keep import
    `import type { ErrorCode, TeaRagsErrorContract } from "../contracts/errors.js";`
    — `ErrorCode` is now `string`, no other change needed
  - Line 14: `readonly code: ErrorCode;` already compatible (string)
  - Line 19: ctor `code: ErrorCode` already compatible (string)

  No changes required at this file — type alias relaxation is invisible to
  consumers.

- [ ] **Step 3: Type-check entire src/**

  Run: `npm run type-check 2>&1 | tail -10` Expected: no errors. Domain ctors
  that previously accepted the wide `ErrorCode` (string union) now accept their
  local narrow unions; downstream consumers (subclasses passing matching
  literals) all type-check.

- [ ] **Step 4: Run full test suite**

  Run: `npx vitest run --reporter=dot 2>&1 | tail -5` Expected: PASS (no tests
  should change behavior).

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/contracts/errors.ts src/core/infra/errors.ts src/core/contracts/index.ts
  git commit -m "$(cat <<'EOF'
  refactor(contracts)!: collapse ErrorCode union to loose string contract

  Why: domain-boundaries.md forbids contracts/ importing from domains/, so
  centralized aggregation is impossible. Each domain owns its strict union;
  contracts only carries the runtime contract (code is a string). All
  TeaRagsErrorContract.code values remain runtime-stable string literals.

  BREAKING CHANGE: External consumers typing against the global ErrorCode
  union must now import the per-domain unions (IngestErrorCode etc.) for
  strict typing. Loose string typing continues to work for runtime checks.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M1.7: collapse contracts/errors.ts to string contract",
labels: `api`, `architecture`. **This task unblocks M2** (M2 tasks add new typed
errors that reference the new local unions).

---

## Milestone 2 — Ingest Bug Attractors (Tasks 9-19)

**Risk:** High. Production-critical paths. **TDD strict.** Each refactor lands
behind a failing test that captures the historical bug class.

**Helpers to use:**

- `tests/core/domains/ingest/__helpers__/test-helpers.ts` provides
  `MockQdrantManager`, `MockEmbeddingProvider`, `createTestFile`,
  `createTempTestDir`, `defaultTestConfig`. Use these — do not roll your own.

### Task 9 (M2.A.1): Failing test — partial deletion outcome

**Files:**

- Create: `tests/core/domains/ingest/sync/deletion-retry-helper.test.ts`

- [ ] **Step 1: Read current `performDeletion` to understand contract**

  Read `src/core/domains/ingest/sync/deletion-strategy.ts:75-129` and identify
  the `DeletionOutcome` shape (likely `{ succeeded: Set, failed: Set }`).

- [ ] **Step 2: Write failing test for partial deletion**

  ```typescript
  // tests/core/domains/ingest/sync/deletion-retry-helper.test.ts
  import { describe, expect, it, vi } from "vitest";

  import { MockQdrantManager } from "../__helpers__/test-helpers.js";
  import { performDeletion } from "../../../../../src/core/domains/ingest/sync/deletion-strategy.js";

  describe("performDeletion partial outcome", () => {
    it("returns succeeded + failed sets when some chunks fail to delete", async () => {
      const qdrant = new MockQdrantManager();
      // Configure mock to fail for chunkId "B"
      vi.spyOn(qdrant, "deletePoints").mockImplementation(
        async (_coll, ids) => {
          if (ids.includes("B")) throw new Error("simulated qdrant error");
        },
      );

      const outcome = await performDeletion(qdrant, "test-collection", [
        "A",
        "B",
        "C",
      ]);

      expect(outcome.succeeded).toEqual(new Set(["A", "C"]));
      expect(outcome.failed).toEqual(new Set(["B"]));
    });
  });
  ```

  Adjust import paths and signatures to match actual `performDeletion` signature
  read in Step 1.

- [ ] **Step 3: Verify test fails for the expected reason**

  Run:
  `npx vitest run tests/core/domains/ingest/sync/deletion-retry-helper.test.ts 2>&1 | tail -10`
  Expected: FAIL — either due to current `performDeletion` not exposing the
  outcome cleanly, or due to a mock-spy gap. Capture the failure message.

- [ ] **Step 4: Commit failing test**

  ```bash
  git add tests/core/domains/ingest/sync/deletion-retry-helper.test.ts
  git commit -m "$(cat <<'EOF'
  test(ingest): add failing test for partial deletion outcome

  Why: pinning current performDeletion behavior before extracting
  DeletionRetryHelper. Test currently fails — see M2.A.3 for the fix.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M2.A.1: failing test for partial deletion outcome", labels:
`bugfix`, `architecture`.

---

### Task 10 (M2.A.2): Failing test — retry exhaustion

**Files:**

- Modify: `tests/core/domains/ingest/sync/deletion-retry-helper.test.ts`

- [ ] **Step 1: Append second failing test**

  Append to the existing file:

  ```typescript
  it("emits failed entry per id when retries exhaust", async () => {
    const qdrant = new MockQdrantManager();
    let attempts = 0;
    vi.spyOn(qdrant, "deletePoints").mockImplementation(async () => {
      attempts++;
      throw new Error("transient error");
    });

    const outcome = await performDeletion(qdrant, "test-collection", ["X"], {
      maxRetries: 2,
    });

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(outcome.failed.has("X")).toBe(true);
    expect(outcome.succeeded.size).toBe(0);
  });
  ```

- [ ] **Step 2: Run + commit failing test**

  ```bash
  npx vitest run tests/core/domains/ingest/sync/deletion-retry-helper.test.ts 2>&1 | tail -5
  git add tests/core/domains/ingest/sync/deletion-retry-helper.test.ts
  git commit -m "$(cat <<'EOF'
  test(ingest): add failing test for retry exhaustion

  Why: pin retry contract before extracting helper. Will pass after M2.A.3.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M2.A.2: failing test for retry exhaustion", labels: `bugfix`,
`architecture`.

---

### Task 11 (M2.A.3): Extract `DeletionRetryHelper`

**Files:**

- Create: `src/core/domains/ingest/sync/deletion-retry-helper.ts`
- Modify: `src/core/domains/ingest/sync/deletion-strategy.ts` (call helper
  instead of inline retry/accumulation)

- [ ] **Step 1: Create the helper**

  ```typescript
  // src/core/domains/ingest/sync/deletion-retry-helper.ts
  import type { DeletionOutcome } from "./deletion-outcome.js";

  export interface RetryOptions {
    maxRetries: number;
    backoffMs: number;
  }

  /**
   * Wraps a delete attempt with retry + outcome accumulation. Caller supplies
   * the per-batch delete function; helper handles retry policy and merges
   * results into a single DeletionOutcome.
   */
  export class DeletionRetryHelper {
    constructor(private readonly opts: RetryOptions) {}

    async execute(
      ids: string[],
      attempt: (ids: string[]) => Promise<void>,
    ): Promise<DeletionOutcome> {
      const succeeded = new Set<string>();
      const failed = new Set<string>();
      // ... (implementation extracted from current performDeletion)
      return { succeeded, failed };
    }
  }
  ```

  Read the current `performDeletion` body to copy retry+accumulation logic
  faithfully. Do not invent new behavior.

- [ ] **Step 2: Refactor `performDeletion` to use helper**

  Replace the inline retry+accumulation block in
  `src/core/domains/ingest/sync/deletion-strategy.ts:75-129` with a call to
  `new DeletionRetryHelper(...).execute(...)`. The function signature stays
  identical.

- [ ] **Step 3: Run failing tests — should now PASS**

  Run:
  `npx vitest run tests/core/domains/ingest/sync/deletion-retry-helper.test.ts 2>&1 | tail -5`
  Expected: PASS for both tests added in M2.A.1 and M2.A.2.

- [ ] **Step 4: Run full ingest tests — confirm no business-logic regression**

  Run: `npx vitest run tests/core/domains/ingest/ --reporter=dot 2>&1 | tail -5`
  Expected: PASS. **If a business-logic test fails, fix the helper, NOT the
  test** (constraint #1).

- [ ] **Step 5: Commit**

  ```bash
  git add src/core/domains/ingest/sync/deletion-retry-helper.ts src/core/domains/ingest/sync/deletion-strategy.ts
  git commit -m "$(cat <<'EOF'
  refactor(ingest): extract DeletionRetryHelper from performDeletion

  Why: file bugFixRate 70 critical (per tea-rags risk-assessment 2026-05-16).
  Isolates retry+accumulation behind tests added in M2.A.1/M2.A.2.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M2.A.3: extract DeletionRetryHelper", labels: `bugfix`,
`architecture`. Depends on: M2.A.1, M2.A.2.

---

### Task 12 (M2.A.4): Extract `BatchDeleteExecutor`

**Files:**

- Create: `src/core/domains/ingest/sync/batch-delete-executor.ts`
- Modify: `src/core/domains/ingest/sync/deletion-strategy.ts`

- [ ] **Step 1: Create the executor**

  ```typescript
  // src/core/domains/ingest/sync/batch-delete-executor.ts
  import type { QdrantManager } from "../../../adapters/qdrant/client.js";

  /**
   * Single-batch delete invoker. Pure pass-through to qdrant.deletePoints —
   * isolates the boundary so DeletionRetryHelper stays free of qdrant types.
   */
  export class BatchDeleteExecutor {
    constructor(
      private readonly qdrant: QdrantManager,
      private readonly collection: string,
    ) {}

    async deleteBatch(ids: string[]): Promise<void> {
      await this.qdrant.deletePoints(this.collection, ids);
    }
  }
  ```

- [ ] **Step 2: Wire into `performDeletion`**

  Replace the direct `qdrant.deletePoints(...)` call (passed to helper in
  M2.A.3) with `new BatchDeleteExecutor(qdrant, collectionName).deleteBatch`.

- [ ] **Step 3: Run tests + commit**

  ```bash
  npx vitest run tests/core/domains/ingest/ --reporter=dot 2>&1 | tail -3
  git add src/core/domains/ingest/sync/batch-delete-executor.ts src/core/domains/ingest/sync/deletion-strategy.ts
  git commit -m "$(cat <<'EOF'
  refactor(ingest): extract BatchDeleteExecutor from performDeletion

  Why: isolates qdrant boundary from retry logic. Completes M2.A
  performDeletion decomposition.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M2.A.4: extract BatchDeleteExecutor", labels: `bugfix`,
`architecture`. Depends on: M2.A.3.

---

### Task 13 (M2.B.1): Failing test — heartbeat lifecycle on exception

**Files:**

- Create: `tests/core/domains/ingest/heartbeat-guard.test.ts`

- [ ] **Step 1: Write failing test**

  ```typescript
  import { describe, expect, it, vi } from "vitest";

  import { HeartbeatGuard } from "../../../../src/core/domains/ingest/heartbeat-guard.js";

  describe("HeartbeatGuard", () => {
    it("stops the heartbeat even if the wrapped function throws", async () => {
      const stop = vi.fn();
      const guard = new HeartbeatGuard({ start: () => stop, intervalMs: 100 });

      await expect(
        guard.run(async () => {
          throw new Error("simulated failure");
        }),
      ).rejects.toThrow("simulated failure");

      expect(stop).toHaveBeenCalledTimes(1);
    });
  });
  ```

  This test will fail because `HeartbeatGuard` doesn't exist yet — that's the
  RED phase.

- [ ] **Step 2: Run, confirm fail, commit**

  ```bash
  npx vitest run tests/core/domains/ingest/heartbeat-guard.test.ts 2>&1 | tail -5
  git add tests/core/domains/ingest/heartbeat-guard.test.ts
  git commit -m "$(cat <<'EOF'
  test(ingest): failing test for HeartbeatGuard cleanup contract

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M2.B.1: failing test for HeartbeatGuard cleanup", labels:
`bugfix`, `architecture`.

---

### Task 14 (M2.B.2): Failing test — pauseOptimizer/resumeOptimizer invariant

**Files:**

- Create: `tests/core/domains/ingest/optimizer-lifecycle.test.ts`

- [ ] **Step 1: Write failing test**

  ```typescript
  import { describe, expect, it, vi } from "vitest";

  import { OptimizerLifecycle } from "../../../../src/core/domains/ingest/optimizer-lifecycle.js";
  import { MockQdrantManager } from "./__helpers__/test-helpers.js";

  describe("OptimizerLifecycle", () => {
    it("calls resume even when wrapped fn throws", async () => {
      const qdrant = new MockQdrantManager();
      const pause = vi.spyOn(qdrant, "pauseOptimizer").mockResolvedValue();
      const resume = vi.spyOn(qdrant, "resumeOptimizer").mockResolvedValue();

      const lifecycle = new OptimizerLifecycle(qdrant);
      await expect(
        lifecycle.with("test-collection", async () => {
          throw new Error("ingest failed");
        }),
      ).rejects.toThrow("ingest failed");

      expect(pause).toHaveBeenCalledOnce();
      expect(resume).toHaveBeenCalledOnce();
    });
  });
  ```

- [ ] **Step 2: Run, confirm fail, commit**

  ```bash
  npx vitest run tests/core/domains/ingest/optimizer-lifecycle.test.ts 2>&1 | tail -5
  git add tests/core/domains/ingest/optimizer-lifecycle.test.ts
  git commit -m "$(cat <<'EOF'
  test(ingest): failing test for OptimizerLifecycle resume invariant

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M2.B.2: failing test for OptimizerLifecycle invariant",
labels: `bugfix`, `architecture`.

---

### Task 15 (M2.B.3): Extract `OptimizerLifecycle`

**Files:**

- Create: `src/core/domains/ingest/optimizer-lifecycle.ts`
- Modify: `src/core/domains/ingest/indexing.ts:120-236`

- [ ] **Step 1: Create the helper**

  ```typescript
  // src/core/domains/ingest/optimizer-lifecycle.ts
  import type { QdrantManager } from "../../adapters/qdrant/client.js";

  /**
   * Wraps a function in pauseOptimizer / resumeOptimizer with finally guard.
   * Resume always runs, even when the wrapped fn throws.
   */
  export class OptimizerLifecycle {
    constructor(private readonly qdrant: QdrantManager) {}

    async with<T>(collection: string, fn: () => Promise<T>): Promise<T> {
      await this.qdrant.pauseOptimizer(collection);
      try {
        return await fn();
      } finally {
        await this.qdrant.resumeOptimizer(collection).catch(() => undefined);
      }
    }
  }
  ```

- [ ] **Step 2: Refactor `IndexPipeline` chunk 120-236 to use it**

  Replace the inline
  `pauseOptimizer / try { processAndTrack } finally { resumeOptimizer }` block
  with
  `await new OptimizerLifecycle(this.qdrant).with(setup.targetCollection, async () => { ... processAndTrack body ... });`.

- [ ] **Step 3: Run tests — M2.B.2 should now PASS**

  ```bash
  npx vitest run tests/core/domains/ingest/ --reporter=dot 2>&1 | tail -5
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/core/domains/ingest/optimizer-lifecycle.ts src/core/domains/ingest/indexing.ts
  git commit -m "$(cat <<'EOF'
  refactor(ingest): extract OptimizerLifecycle from IndexPipeline

  Why: chunk bugFixRate 53 concerning. Isolates pause/resume invariant — resume
  always runs in finally, immune to processAndTrack failures.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M2.B.3: extract OptimizerLifecycle", labels: `bugfix`,
`architecture`. Depends on: M2.B.2.

---

### Task 16 (M2.B.4): Extract `HeartbeatGuard`

**Files:**

- Create: `src/core/domains/ingest/heartbeat-guard.ts`
- Modify: `src/core/domains/ingest/indexing.ts`

- [ ] **Step 1: Create the helper**

  ```typescript
  // src/core/domains/ingest/heartbeat-guard.ts
  export interface HeartbeatOptions {
    /** Returns a stop function. Called on entry. */
    start: () => () => void;
    intervalMs: number;
  }

  /**
   * Starts a heartbeat for the duration of a function. Cleanup runs in finally.
   */
  export class HeartbeatGuard {
    constructor(private readonly opts: HeartbeatOptions) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
      const stop = this.opts.start();
      try {
        return await fn();
      } finally {
        stop();
      }
    }
  }
  ```

- [ ] **Step 2: Refactor `IndexPipeline` startHeartbeat/stopHeartbeat to use
      guard**

  Replace inline
  `this.startHeartbeat(...); try {...} finally { this.stopHeartbeat(); }` with
  `await new HeartbeatGuard({ start: () => this.startHeartbeat(setup.targetCollection), intervalMs: ... }).run(async () => { ... });`.

- [ ] **Step 3: Run tests — M2.B.1 should now PASS**

  ```bash
  npx vitest run tests/core/domains/ingest/heartbeat-guard.test.ts 2>&1 | tail -5
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add src/core/domains/ingest/heartbeat-guard.ts src/core/domains/ingest/indexing.ts
  git commit -m "$(cat <<'EOF'
  refactor(ingest): extract HeartbeatGuard from IndexPipeline

  Why: isolates heartbeat lifecycle — stop always runs even when wrapped
  function throws. Completes M2.B IndexPipeline decomposition.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M2.B.4: extract HeartbeatGuard", labels: `bugfix`,
`architecture`. Depends on: M2.B.1.

---

### Task 17 (M2.C.1): Failing test — missed-file path

**Files:**

- Create:
  `tests/core/domains/ingest/pipeline/enrichment/missed-file-tracker.test.ts`

- [ ] **Step 1: Write failing test**

  ```typescript
  import { describe, expect, it } from "vitest";

  import { MissedFileTracker } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/missed-file-tracker.js";

  describe("MissedFileTracker", () => {
    it("accumulates missed-file paths and chunk IDs up to sample limit", () => {
      const tracker = new MissedFileTracker({ sampleLimit: 2 });

      tracker.track("a.ts", [{ chunkId: "c1", startLine: 1, endLine: 5 }]);
      tracker.track("b.ts", [{ chunkId: "c2", startLine: 1, endLine: 5 }]);
      tracker.track("c.ts", [{ chunkId: "c3", startLine: 1, endLine: 5 }]);

      expect(tracker.missedCount).toBe(3);
      expect(tracker.samples).toEqual(["a.ts", "b.ts"]); // capped at limit
      expect(tracker.chunksFor("a.ts")).toHaveLength(1);
    });
  });
  ```

- [ ] **Step 2: Run, confirm fail, commit**

  ```bash
  npx vitest run tests/core/domains/ingest/pipeline/enrichment/missed-file-tracker.test.ts 2>&1 | tail -5
  git add tests/core/domains/ingest/pipeline/enrichment/missed-file-tracker.test.ts
  git commit -m "$(cat <<'EOF'
  test(ingest): failing test for MissedFileTracker contract

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M2.C.1: failing test for MissedFileTracker", labels: `bugfix`,
`architecture`.

---

### Task 18 (M2.C.2): Extract `MissedFileTracker`

**Files:**

- Create: `src/core/domains/ingest/pipeline/enrichment/missed-file-tracker.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/applier.ts`

- [ ] **Step 1: Create the tracker**

  ```typescript
  // src/core/domains/ingest/pipeline/enrichment/missed-file-tracker.ts
  export interface MissedChunkRef {
    chunkId: string;
    startLine: number;
    endLine: number;
  }

  /**
   * Accumulates missed-file paths + chunk references during enrichment.
   * Bounded sample list for diagnostics.
   */
  export class MissedFileTracker {
    private _missedCount = 0;
    private readonly _samples: string[] = [];
    private readonly _chunks = new Map<string, MissedChunkRef[]>();

    constructor(private readonly opts: { sampleLimit: number }) {}

    track(relativePath: string, chunks: MissedChunkRef[]): void {
      this._missedCount++;
      if (this._samples.length < this.opts.sampleLimit)
        this._samples.push(relativePath);
      const existing = this._chunks.get(relativePath) ?? [];
      existing.push(...chunks);
      this._chunks.set(relativePath, existing);
    }

    get missedCount(): number {
      return this._missedCount;
    }
    get samples(): readonly string[] {
      return this._samples;
    }
    chunksFor(path: string): readonly MissedChunkRef[] {
      return this._chunks.get(path) ?? [];
    }
  }
  ```

- [ ] **Step 2: Refactor `EnrichmentApplier.applyFileSignals` to delegate**

  In `src/core/domains/ingest/pipeline/enrichment/applier.ts`, replace the
  inline `missedFiles++ / missedPathSamples.push / _missedFileChunks.set` block
  with delegation to a `this.missedTracker: MissedFileTracker` instance
  (initialize in constructor with `sampleLimit: 10`). Expose
  `missedTracker.missedCount`, `missedTracker.samples`,
  `missedTracker.chunksFor(...)` via the existing applier accessors.

- [ ] **Step 3: Run tests — both new + existing should PASS**

  ```bash
  npx vitest run tests/core/domains/ingest/ --reporter=dot 2>&1 | tail -5
  ```

  **Constraint: any failing business-logic test means the refactor is wrong.**
  Fix the applier delegation, not the test.

- [ ] **Step 4: Commit**

  ```bash
  git add src/core/domains/ingest/pipeline/enrichment/missed-file-tracker.ts src/core/domains/ingest/pipeline/enrichment/applier.ts
  git commit -m "$(cat <<'EOF'
  refactor(ingest): extract MissedFileTracker from EnrichmentApplier

  Why: file bugFixRate 50 critical, methodLines 95. Isolates missed-file
  bookkeeping from happy-path apply.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M2.C.2: extract MissedFileTracker", labels: `bugfix`,
`architecture`. Depends on: M2.C.1.

---

### Task 19 (M2.D.1): Investigation — `pipeline-manager.ts:addUpsert`

**Files:**

- Read: `src/core/domains/ingest/pipeline/pipeline-manager.ts:111-127`

- [ ] **Step 1: Read addUpsert + git log**

  Run:
  `git log --oneline --follow -- src/core/domains/ingest/pipeline/pipeline-manager.ts | head -20`
  Read each commit message that mentions addUpsert / batch / upsert.

- [ ] **Step 2: Cross-reference bug fixes**

  Identify commits with `fix(` prefix. For each, capture:
  - Commit SHA
  - Bug class (race condition / null handling / batch ordering / etc.)
  - Whether the fix is currently in addUpsert or moved elsewhere

- [ ] **Step 3: Document findings**

  Write findings to beads task notes via:

  ```bash
  bd update <task-id> --notes="$(cat <<'EOF'
  Investigation: pipeline-manager.ts addUpsert (47d legacy, bugFix 63 critical)

  Bug history:
  - <sha1>: <bug class>
  - <sha2>: <bug class>

  Root cause assessment: [in addUpsert / in caller / mixed]

  Recommendation: [refactor in M2.D.2 / defer / close]
  EOF
  )"
  ```

- [ ] **Step 4: Decision**
  - If root cause is in `addUpsert` itself → proceed to M2.D.2
  - If root cause is upstream → close M2.D with
    `--reason="root cause in [caller-name], deferred to follow-up epic"`. **No
    code changes in M2.D.**

**Beads:** title="M2.D.1: investigate addUpsert legacy bug history", labels:
`bugfix`, `architecture`.

---

### Task 20 (M2.D.2 — CONDITIONAL): Refactor `addUpsert` if M2.D.1 surfaces a cause

**Skip if M2.D.1 closed with `defer`.**

**Files:**

- Modify: `src/core/domains/ingest/pipeline/pipeline-manager.ts:111-127`

- [ ] **Step 1: Write failing test for the identified bug class**

  Test name and assertions specific to the bug class found in M2.D.1.

- [ ] **Step 2: Implement minimal fix**

- [ ] **Step 3: Run tests + commit**

  Commit message scope: `fix(ingest)` (this is a bug fix, not a refactor).

**Beads:** title="M2.D.2: fix addUpsert per M2.D.1 findings (conditional)",
labels: `bugfix`. Depends on: M2.D.1.

---

### Task 21 (M2.E.1): Investigation — `reindexing.ts:322-509` (158-line block)

**Files:**

- Read: `src/core/domains/ingest/reindexing.ts:322-509`

- [ ] **Step 1: Read the block + identify logical phases**

  Document phases (e.g. "phase 1: detect changes", "phase 2: execute parallel
  pipelines", "phase 3: finalize") in beads task notes.

- [ ] **Step 2: Identify the historical bug class**

  Same approach as M2.D.1 — `git log -p` on the block, cross-reference fix
  commits.

**Beads:** title="M2.E.1: investigate reindexing block 322-509 history", labels:
`bugfix`, `architecture`.

---

### Task 22 (M2.E.2 + M2.E.3): Failing test + decompose reindexing block

**Files:**

- Modify: `tests/core/domains/ingest/reindexing.test.ts` (add new tests, do NOT
  rewrite existing business-logic tests)
- Modify: `src/core/domains/ingest/reindexing.ts:322-509`

- [ ] **Step 1: Write failing test for the bug class identified in M2.E.1**

  Test name + assertions specific to the issue. Add to existing test file or
  create new under `tests/core/domains/ingest/reindexing-block.test.ts`.

- [ ] **Step 2: Decompose block into ≤3 cohesive functions**

  Names + boundaries decided after M2.E.1. Each new function ≤60 lines.

- [ ] **Step 3: Run tests, confirm pass, commit**

  ```bash
  npx vitest run tests/core/domains/ingest/ --reporter=dot 2>&1 | tail -5
  git add tests/core/domains/ingest/ src/core/domains/ingest/reindexing.ts
  git commit -m "$(cat <<'EOF'
  refactor(ingest): decompose reindexing block 322-509 into 3 phases

  Why: chunk bugFixRate 55 critical, methodLines 158 oversized. Phases
  identified in M2.E.1: <list>.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M2.E.2/3: decompose reindexing block + failing test", labels:
`bugfix`, `architecture`. Depends on: M2.E.1.

---

## Milestone 3 — Oversized Method Decomposition (Tasks 23-25)

**Risk:** Medium. Behavior-preserving — ride existing tests. **Do NOT rewrite
business-logic tests.** If a test fails after extraction, the extraction is
wrong.

### Task 23 (M3.A): Decompose `chunk-reader.ts:buildChunkChurnMapUncached` (341 lines)

**Files:**

- Create: `src/core/domains/trajectory/git/infra/build-accumulators.ts`
- Create: `src/core/domains/trajectory/git/infra/walk-commits.ts`
- Create: `src/core/domains/trajectory/git/infra/assemble-overlays.ts`
- Modify: `src/core/domains/trajectory/git/infra/chunk-reader.ts`

- [ ] **Step 1: Read the full function body**

  Read `src/core/domains/trajectory/git/infra/chunk-reader.ts:83-423`
  (`buildChunkChurnMapUncached` and surrounding context).

- [ ] **Step 2: Extract `buildAccumulators`**

  Lines roughly 83-134 — initialize per-chunk accumulator state. New file:

  ```typescript
  // src/core/domains/trajectory/git/infra/build-accumulators.ts
  import type { ChunkLookupEntry } from "../../../../adapters/git/types.js";

  export interface ChunkAccumulator {
    commitShas: Set<string>;
    authors: Set<string>;
    bugFixCount: number;
    lastModifiedAt: number;
    linesAdded: number;
    linesDeleted: number;
    commitTimestamps: number[];
    commitAuthors: string[];
    taskIds: Set<string>;
  }

  export function buildAccumulators(
    relativeChunkMap: Map<string, ChunkLookupEntry[]>,
  ): Map<string, ChunkAccumulator> {
    const accumulators = new Map<string, ChunkAccumulator>();
    for (const [, entries] of relativeChunkMap) {
      for (const entry of entries) {
        accumulators.set(entry.chunkId, {
          commitShas: new Set(),
          authors: new Set(),
          bugFixCount: 0,
          lastModifiedAt: 0,
          linesAdded: 0,
          linesDeleted: 0,
          commitTimestamps: [],
          commitAuthors: [],
          taskIds: new Set(),
        });
      }
    }
    return accumulators;
  }
  ```

- [ ] **Step 3: Extract `walkCommits`**

  The commit iteration loop. New file
  `src/core/domains/trajectory/git/infra/walk-commits.ts`. Function signature
  takes `accumulators`, `repoRoot`, `relativeChunkMap`, `sinceDate`, helpers
  (`squashOpts`, `chunkTimeoutMs`, etc.) — match exactly the inputs the current
  loop reads.

- [ ] **Step 4: Extract `assembleOverlays`**

  The final reduce → `Map<string, Map<string, ChunkChurnOverlay>>`. New file
  `assemble-overlays.ts`. Calls existing `assembleChunkSignals` per chunk.

- [ ] **Step 5: Refactor `buildChunkChurnMapUncached` to orchestrate**

  Replace 341-line body with three calls:

  ```typescript
  const accumulators = buildAccumulators(relativeChunkMap);
  await walkCommits(accumulators, { repoRoot /* ... */ });
  return assembleOverlays(accumulators, relativeChunkMap, blameByPath);
  ```

  Result: `buildChunkChurnMapUncached` ≤80 lines.

- [ ] **Step 6: Run trajectory tests**

  Run:
  `npx vitest run tests/core/domains/trajectory/git/ --reporter=dot 2>&1 | tail -5`
  Expected: PASS. **Failing business-logic test = wrong extraction; fix the
  extraction, not the test.**

- [ ] **Step 7: Commit**

  ```bash
  git add src/core/domains/trajectory/git/infra/build-accumulators.ts \
          src/core/domains/trajectory/git/infra/walk-commits.ts \
          src/core/domains/trajectory/git/infra/assemble-overlays.ts \
          src/core/domains/trajectory/git/infra/chunk-reader.ts
  git commit -m "$(cat <<'EOF'
  refactor(trajectory): decompose buildChunkChurnMapUncached (341 -> 3 helpers)

  Why: 341-line function impossible to review. Behavior preserved — existing
  tests pass without modification.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M3.A: decompose buildChunkChurnMapUncached", labels:
`architecture`, `dx`.

---

### Task 24 (M3.B.1): Group `registerCodeTools` by family

**Files:**

- Read: `src/mcp/tools/code.ts:1-end` (272 lines)

- [ ] **Step 1: Read full file**

- [ ] **Step 2: Map each tool registration to a family**

  Document in beads task notes:
  - `search`: `semantic_search`, `hybrid_search`
  - `symbol`: `find_symbol`
  - `rank`: `rank_chunks`
  - `similar`: `find_similar`
  - other: `search_code`, etc.

- [ ] **Step 3: Identify shared imports/helpers per family**

  Note shared formatters (`./formatters/enrichment.js`), schemas
  (`./schemas.js`), and middleware (`../middleware/error-handler.js`). These
  must be re-imported in each new family file.

**Beads:** title="M3.B.1: map registerCodeTools families", labels:
`architecture`, `dx`.

---

### Task 25 (M3.B.2): Extract per-family `register*Tools` files

**Files:**

- Create: `src/mcp/tools/code/register-search-tools.ts`
- Create: `src/mcp/tools/code/register-symbol-tools.ts`
- Create: `src/mcp/tools/code/register-rank-tools.ts`
- Create: `src/mcp/tools/code/register-similar-tools.ts`
- Modify: `src/mcp/tools/code.ts`

- [ ] **Step 1: Create each family file**

  Each exports a single function:

  ```typescript
  // src/mcp/tools/code/register-search-tools.ts
  import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

  import type { App } from "../../../core/api/index.js";

  // ... shared imports

  export function registerSearchTools(server: McpServer, app: App): void {
    // semantic_search registration block (copied verbatim from registerCodeTools)
    // hybrid_search registration block
  }
  ```

  Repeat for symbol, rank, similar. Each function ≤80 lines.

- [ ] **Step 2: Refactor `registerCodeTools` to orchestrate**

  ```typescript
  // src/mcp/tools/code.ts
  import { registerRankTools } from "./code/register-rank-tools.js";
  import { registerSearchTools } from "./code/register-search-tools.js";
  import { registerSimilarTools } from "./code/register-similar-tools.js";
  import { registerSymbolTools } from "./code/register-symbol-tools.js";

  export function registerCodeTools(server: McpServer, app: App): void {
    registerSearchTools(server, app);
    registerSymbolTools(server, app);
    registerRankTools(server, app);
    registerSimilarTools(server, app);
  }
  ```

- [ ] **Step 3: Run MCP tool tests**

  Run: `npx vitest run tests/mcp/tools/ --reporter=dot 2>&1 | tail -5` Expected:
  PASS.

- [ ] **Step 4: Manual MCP smoke test (per
      `.claude/rules/.local/mcp-testing.md`)**

  Run: `npm run build` Then ask the user via `AskUserQuestion`:

  > "MCP server code was modified (registerCodeTools split). Please reconnect
  > the tea-rags MCP server, then select 'Done'."

  Options: `Done` / `Skip`. After Done, verify via:

  ```
  mcp__tea-rags__semantic_search project=tea-rags query="test" limit=1
  ```

  Expected: result returned (proves search tool registered correctly).

- [ ] **Step 5: Commit**

  ```bash
  git add src/mcp/tools/code.ts src/mcp/tools/code/
  git commit -m "$(cat <<'EOF'
  refactor(mcp): split registerCodeTools by tool family (272 -> 4 modules)

  Why: 272-line function with 28 commits, mixed responsibilities. Split into
  search/symbol/rank/similar families. Behavior preserved — MCP smoke test
  green.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M3.B.2: extract per-family register-tools files", labels:
`architecture`, `dx`. Depends on: M3.B.1.

---

## Milestone 4 — Silo Mitigation (Tasks 26-28)

### Task 26 (M4.1): Decompose `app.ts:createApp` into wireFacades + wireOps

**Files:**

- Modify: `src/core/api/public/app.ts:149-179`

- [ ] **Step 1: Read createApp body**

- [ ] **Step 2: Extract `wireFacades` (private to file)**

  ```typescript
  function wireFacades(deps: AppDeps): {
    explore: ExploreFacade;
    ingest: IngestFacade;
  } {
    return {
      explore: new ExploreFacade(/* ... */),
      ingest: new IngestFacade(/* ... */),
    };
  }
  ```

- [ ] **Step 3: Extract `wireOps`**

  ```typescript
  function wireOps(deps: AppDeps): {
    collection: CollectionOps;
    document: DocumentOps;
    projectRegistry: ProjectRegistryOps;
  } {
    return {
      collection: new CollectionOps(/* ... */),
      document: new DocumentOps(/* ... */),
      projectRegistry: new ProjectRegistryOps(/* ... */),
    };
  }
  ```

- [ ] **Step 4: Refactor `createApp` body to use them**

  ```typescript
  export function createApp(deps: AppDeps): App {
    const facades = wireFacades(deps);
    const ops = wireOps(deps);
    return {
      /* App interface composition using facades + ops */
    };
  }
  ```

- [ ] **Step 5: Run app tests + commit**

  ```bash
  npx vitest run tests/core/api/public/ --reporter=dot 2>&1 | tail -5
  git add src/core/api/public/app.ts
  git commit -m "$(cat <<'EOF'
  refactor(api): extract wireFacades + wireOps from createApp

  Why: createApp is 62-line deep-silo block. Extraction makes layer
  separation explicit and reduces silo concentration through
  layer-named helpers. DI chain (bootstrap -> composition -> app -> MCP)
  preserved per .claude/rules/wiring.md.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M4.1: extract wireFacades + wireOps from createApp", labels:
`architecture`, `dx`.

---

### Task 27 (M4.2): Create `.claude/rules/silo-pairing.md`

**Files:**

- Create: `.claude/rules/silo-pairing.md`

- [ ] **Step 1: Write the rule**

  ````markdown
  # Silo Pairing (MANDATORY for deep-silo files)

  Files with `git.file.blameDominantAuthorPct = 100` (deep-silo per tea-rags
  signal) carry bus-factor risk. To mitigate without forcing awkward
  co-authorship, every commit touching these files must include intent +
  trade-offs in the message.

  ## Files currently classified as deep-silo

  (Updated 2026-05-16; re-run `tea-rags:risk-assessment` quarterly to refresh.)

  - `src/core/api/internal/ops/indexing-ops.ts`
  - `src/core/api/internal/ops/project-registry-ops.ts`
  - `src/core/domains/ingest/pipeline/enrichment/recovery.ts`
  - `src/core/adapters/qdrant/errors.ts`
  - `src/core/api/public/app.ts` (after M4.1 — re-evaluate at next assessment)
  - `src/core/api/errors.ts`
  - `src/core/domains/explore/errors.ts`
  - `src/core/domains/trajectory/errors.ts`
  - `src/core/adapters/errors.ts`

  ## Rule

  Commits touching any deep-silo file MUST include a `Why:` line in the body
  stating intent and trade-offs. Example:

  ```text
  refactor(ingest): tighten recovery scrollUnenriched cursor lifetime

  Why: previous cursor leak caused 3.5s hang on first re-poll after restart.
  Trade-off: extra Qdrant call per cycle, acceptable given <50ms latency.
  ```
  ````

  ## Why no test-time enforcement

  This rule is process-only — automated enforcement (commitlint check) would
  catch false positives on non-deep-silo files. Reviewers verify on PR.

  ```

  ```

- [ ] **Step 2: Run markdownlint**

  Run: `npx markdownlint .claude/rules/silo-pairing.md 2>&1 | tail -3` Expected:
  no errors.

- [ ] **Step 3: Commit**

  ```bash
  git add .claude/rules/silo-pairing.md
  git commit -m "$(cat <<'EOF'
  docs(rules): add silo-pairing process rule

  Why: 9 deep-silo files identified in 2026-05-16 risk assessment. Process
  rule (no automation) — commit-message intent + trade-offs is the lightweight
  mitigation.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M4.2: add silo-pairing.md", labels: `docs`, `dx`.

---

### Task 28 (M4.3): Reference silo-pairing in CLAUDE.md

**Files:**

- Modify: `.claude/CLAUDE.md` (project-level CLAUDE.md, not user)

- [ ] **Step 1: Read CLAUDE.md to find the rules section**

  Run:
  `grep -n "rules" /Users/artk0re/Dev/Tools/tea-rags-mcp/.claude/CLAUDE.md | head -5`

- [ ] **Step 2: Add reference to silo-pairing**

  In the Rules section, add a bullet/link:

  ```markdown
  - `.claude/rules/silo-pairing.md` — process rule for commits touching
    deep-silo files (must include `Why:` line).
  ```

- [ ] **Step 3: Run markdownlint + commit**

  ```bash
  npx markdownlint .claude/CLAUDE.md 2>&1 | tail -3
  git add .claude/CLAUDE.md
  git commit -m "$(cat <<'EOF'
  docs(rules): link silo-pairing.md from CLAUDE.md

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  EOF
  )"
  ```

**Beads:** title="M4.3: reference silo-pairing in CLAUDE.md", labels: `docs`,
`dx`.

---

## Verification (epic close)

After all 28 tasks closed, run epic-level verification:

- [ ] **V1: full test suite** Run:
      `npx vitest run --reporter=dot 2>&1 | tail -5` Expected: PASS, no
      business-logic tests modified.

- [ ] **V2: type-check** Run: `npm run type-check 2>&1 | tail -5` Expected: no
      errors.

- [ ] **V3: build** Run: `npm run build 2>&1 | tail -5` Expected: success.

- [ ] **V4: force re-index tea-rags self-test** Run:
      `mcp__tea-rags__force_reindex project=tea-rags` Expected: success, no
      payload-schema errors. Validates that all signal descriptors still resolve
      after the refactors.

- [ ] **V5: re-run risk assessment** Run: `tea-rags:risk-assessment` skill
      Expected:
  - `contracts/errors.ts` no longer in any of the 3 lenses
  - `bugFixRate` for the 4 ingest hotspot files trends down (full effect at +30
    days post-merge)

- [ ] **V6: close epic** Run:
      `bd close tea-rags-mcp-techdebt-q2 --reason="all 28 tasks complete; verification passed"`

---

## Self-Review (run after writing this plan)

**1. Spec coverage** — every milestone in the spec has tasks above:

- M1 (taxonomy split) → Tasks 2-8 (7 tasks; spec said 6, added Task 1 baseline +
  Task 8 collapse)
- M2 (bug attractors) → Tasks 9-22 (12 + investigation conditional, spec
  said 12)
- M3 (oversized) → Tasks 23-25 (3, spec said 5 — collapsed M3.B.1+M3.B.2 into
  separate Tasks 24-25; M3.A.1/2/3 from spec are sub-steps inside Task 23)
- M4 (silos) → Tasks 26-28 (3, matches spec)

  Total: 28 plan Tasks. Spec said ~26 — extra 2 are Task 1 baseline + Task 8
  collapse (spec lumped collapse into M1.6).

**2. Placeholder scan** — no TBDs except the explicit conditional in Task 20
(M2.D.2 conditional on M2.D.1 outcome) and the "names + boundaries decided after
M2.E.1" in Task 22. Both are documented as intentional investigation gates per
`signal-confidence.md` "fragile legacy" rule.

**3. Type consistency** — `IngestErrorCode`, `ExploreErrorCode`,
`TrajectoryErrorCode`, `InfraErrorCode`, `InputErrorCode`, `ConfigErrorCode` all
named consistently with `<Domain>ErrorCode` pattern.

**4. Layer compliance** — Option A respects `domain-boundaries.md` (no contracts
→ domains imports). Verified via Step 3 type-check in M1.7.

**5. Test rule compliance** — every M2/M3 task that touches tests includes the
constraint reminder ("Failing business-logic test = wrong extraction; fix the
code, not the test"). M4 doesn't touch tests beyond ride-existing.
