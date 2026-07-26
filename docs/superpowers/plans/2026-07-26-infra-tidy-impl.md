# Infra Tidy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (inline) or `superpowers:subagent-driven-development` to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink `src/core/infra/` from 4194 to 1329 LOC by relocating product
logic to its owning module, cut all 17 upward edges, and repair the eslint
foundation guard so the drift cannot recur.

**Architecture:** Five waves. Wave 1 legalizes the foundation order
(`contracts < infra < adapters`) and fixes the guard's dead globs. Waves 2-3 cut
cheap edges and move small modules. Wave 4 moves `registry/**` to
`domains/maintenance/registry/`. Wave 5 moves `migration/**` to
`domains/maintenance/migration/`, introduces the DuckDB DDL applier injection,
and enables the `infra` deny patterns as the final commit.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, eslint 9 flat
config with `@typescript-eslint/no-restricted-imports` zones, DuckDB
(codegraph), Qdrant.

**Spec:** `docs/superpowers/specs/2026-07-26-infra-tidy-design.md` (commit
`0e1fcbc4`).

## Global Constraints

- Import specifiers inside `src/` are relative and end in `.js`, never `.ts`,
  never a path alias.
- Relocations are moves, not rewrites. Test files move with their subject; their
  bodies change only in the import line. `.claude/rules/test-invariants.md`
  forbids rewriting a business-logic test to accommodate a refactor.
- Never add `eslint-disable`, never lower a coverage threshold
  (`.claude/rules/linter-config.md`, project CLAUDE.md).
- Commits: conventional, header <= 100 chars, scope from
  `.claude/rules/commit-rules.md`. Relocations are `refactor`; the guard fix is
  `fix`; docs are `docs`.
- Files with 100% single-author blame (`registry/*`, `migration/*`,
  `schema-drift-monitor.ts`, `embedding-model-guard.ts`, `qdrant-version.ts`)
  are deep silos. Every commit touching them carries a `Why:` line per
  `.claude/rules/silo-pairing.md`.
- Run `npx prettier --write` on every touched file before committing (the
  pre-commit hook does it too, but staged-file reformatting mid-commit is
  noise).
- After the plan is saved, create one beads epic with one task per Task below
  and link them per `.claude/rules/.local/plan-beads-sync.md`.

## File Structure

**New files**

| File                                                               | Responsibility                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `src/core/contracts/types/registry.ts`                             | `CollectionRegistryPort` — the read/write surface `ingest` needs by type only |
| `src/core/contracts/types/migration.ts`                            | `MigratorPort`, `ShardedSnapshotAccess` + factory, `DatabaseMigrationApplier` |
| `src/core/contracts/types/qdrant-point-store.ts`                   | `CollectionPointStore` — the three Qdrant ops `EmbeddingModelGuard` needs     |
| `src/core/domains/maintenance/registry/`                           | Relocated project registry (6 files + own `errors.ts`)                        |
| `src/core/domains/maintenance/migration/`                          | Relocated migration framework (30 files)                                      |
| `src/core/domains/maintenance/migration/database/module-path.ts`   | Exports the resolved URL of the DDL module for daemon spawn                   |
| `src/core/domains/maintenance/schema-drift-monitor.ts`             | Relocated drift monitor                                                       |
| `src/core/domains/ingest/pipeline/enrichment/commit-diff-memo.ts`  | Relocated run-scoped diff memo                                                |
| `src/core/domains/ingest/sync/snapshot/sharded-snapshot-access.ts` | `ShardedSnapshotAccess` implementation over `ShardedSnapshotManager`          |
| `src/core/domains/trajectory/codegraph/hierarchy-view.ts`          | Relocated `MapHierarchyView`                                                  |
| `src/core/adapters/qdrant/required-version.ts`                     | Relocated `.qdrant-required-version` reader                                   |
| `tests/eslint-layer-guard.test.ts`                                 | Fixture test proving the foundation zones fire                                |

**Deleted files**

| File                                                | Why                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `src/core/domains/ingest/pipeline/infra/runtime.ts` | Deprecated re-export of `infra/runtime.ts`; 10 importers re-pointed |
| `src/core/domains/ingest/constants.ts`              | Sole export `INDEXING_METADATA_ID` moves to `contracts`             |
| `src/core/adapters/registry/errors.ts`              | Classes return to the registry's own domain                         |

---

## Wave 1 — Foundation order and guard repair

### Task 1: Repair the foundation eslint zones and prove they fire

**Files:**

- Modify: `eslint.config.js:393-419` (contracts zone), `:420-441` (adapters
  zone), `:443-465` (infra zone)
- Create: `tests/eslint-layer-guard.test.ts`
- Modify: `.claude/rules/domain-boundaries.md:40` and its `core/infra/`
  responsibility section
- Modify:
  `docs/superpowers/specs/2026-05-27-dependency-direction-guard-design.md`
  (amendment note)

**Interfaces:**

- Consumes: nothing.
- Produces: a guard that rejects `contracts -> *` and
  `adapters -> {domains, api, bootstrap, mcp, cli}` on relative specifiers;
  `infra` deny patterns authored but commented out until Task 15.

- [ ] **Step 1: Baseline green**

```bash
npx eslint src/ tests/ && npx tsc --noEmit
```

Expected: both exit 0. If not, stop: a pre-existing failure must not be
attributed to this plan.

- [ ] **Step 2: Write the failing fixture test**

Create `tests/eslint-layer-guard.test.ts`:

```typescript
import { join } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

async function lintAs(
  relativeFilePath: string,
  code: string,
): Promise<string[]> {
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(code, {
    filePath: join(ROOT, relativeFilePath),
  });
  return (result?.messages ?? []).map((m) => m.message);
}

describe("layer guard — foundation zones", () => {
  it("rejects a relative infra -> domains import", async () => {
    const messages = await lintAs(
      "src/core/infra/fixture-guard.ts",
      'import { x } from "../domains/ingest/constants.js";\nexport const y = x;\n',
    );
    expect(messages.join("\n")).toContain("infra is the lowest layer");
  });

  it("rejects a relative contracts -> infra import", async () => {
    const messages = await lintAs(
      "src/core/contracts/fixture-guard.ts",
      'import { isDebug } from "../infra/runtime.js";\nexport const y = isDebug;\n',
    );
    expect(messages.join("\n")).toContain("contracts is pure");
  });

  it("rejects a relative adapters -> domains import", async () => {
    const messages = await lintAs(
      "src/core/adapters/fixture-guard.ts",
      'import { x } from "../domains/ingest/constants.js";\nexport const y = x;\n',
    );
    expect(messages.join("\n")).toContain("adapters may import only");
  });

  it("allows infra -> contracts type-only imports", async () => {
    const messages = await lintAs(
      "src/core/infra/fixture-guard.ts",
      'import type { AstNode } from "../contracts/types/ast.js";\nexport type Y = AstNode;\n',
    );
    expect(messages.join("\n")).not.toContain("lowest layer");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run tests/eslint-layer-guard.test.ts
```

Expected: the `contracts -> infra` and `adapters -> domains` cases FAIL (the
current globs never match a relative specifier). The `infra -> domains` case
also fails and stays failing until Task 15 — mark it with `it.skip` plus the
comment `// unskipped in Task 15 (wave 5)` after confirming it fails for the
expected reason.

- [ ] **Step 4: Rewrite the contracts zone prefix-free**

In `eslint.config.js`, the `src/core/contracts/**/*.ts` zone's `group` becomes:

```javascript
              group: [
                "**/infra/**",
                "**/adapters/**",
                "**/domains/**",
                "**/api/**",
                "**/core/types",
                "**/core/types.js",
                "**/bootstrap/**",
                "**/mcp/**",
                "**/cli/**",
              ],
```

- [ ] **Step 5: Rewrite the adapters zone prefix-free**

The `src/core/adapters/**/*.ts` zone's `group` becomes:

```javascript
              group: ["**/api/**", "**/bootstrap/**", "**/mcp/**", "**/cli/**"],
```

`**/domains/**` is missing on purpose: it fails on
`adapters/qdrant/client.ts:8`, which throws the explore-domain
`InvalidQueryError`. That fix changes an error surfaced through MCP, so it is
deferred to `tea-rags-mcp-pn12w` with a TODO in the zone and a skipped fixture
case.

`contracts` is deliberately absent. The matrix already allows
`adapters -> contracts`, and the old zone forbade it only because the glob never
fired.

- [ ] **Step 6: Rewrite the infra zone — contracts allowed, rest commented**

The `src/core/infra/**/*.ts` zone becomes:

```javascript
          patterns: [
            {
              // Foundation order: contracts < infra < adapters. `infra` may
              // `import type` from `contracts` (see the 2026-07-26 infra-tidy
              // spec); `contracts` importing `infra` is blocked by its own zone,
              // so no cycle can form.
              //
              // TODO(wave-5): uncomment once the last infra -> {domains, api,
              // adapters} edge is gone (Task 15 of the infra-tidy plan).
              // group: ["**/domains/**", "**/adapters/**", "**/api/**", "**/bootstrap/**", "**/mcp/**", "**/cli/**"],
              group: ["**/bootstrap/**", "**/mcp/**", "**/cli/**"],
              message: "infra is the lowest layer — it may only import type from contracts.",
            },
          ],
```

- [ ] **Step 7: Run the full lint and the fixture test**

```bash
npx eslint src/ tests/ && npx vitest run tests/eslint-layer-guard.test.ts
```

Expected: the fixture test passes with the `infra -> domains` case still
skipped. eslint will NOT exit 0 on the first run: the newly-live zones catch
violations that were invisible before. Clear each one in this task if it is
mechanical, or defer it against a bead with a TODO in the zone plus a skipped
fixture case. What they surfaced on the first run: `contracts/types/app.ts`
(dead re-export of three `api/public/dto/*` modules — delete it and its
`contracts/index.ts` barrel line, then `npx tsc --noEmit` proves nothing
depended on it) and `adapters/qdrant/client.ts:8` (deferred to
`tea-rags-mcp-pn12w`).

- [ ] **Step 8: Update the rule doc**

In `.claude/rules/domain-boundaries.md`, the dependency table row for
`core/infra/` changes from `_(nothing)_` to `` `contracts/` _(type-only)_ ``.
Directly under the table, add:

```markdown
**Foundation order.** Inside the foundation row the layers are ordered
`contracts < infra < adapters`: `contracts` imports nothing, `infra` may
`import type` from `contracts` (runtime imports stay forbidden), `adapters` may
import both. Rationale and the duplication it removes:
`docs/superpowers/specs/2026-07-26-infra-tidy-design.md`.
```

Replace the `core/infra/` responsibility section with the module list from the
spec's "Stays in infra" table.

- [ ] **Step 9: Amend the dependency-guard spec**

Append to
`docs/superpowers/specs/2026-05-27-dependency-direction-guard-design.md`:

```markdown
## Amendment 2026-07-26

The `core/infra/** -> nothing` row is superseded by the foundation order
`contracts < infra < adapters` — see
`docs/superpowers/specs/2026-07-26-infra-tidy-design.md`. Reason: the strict
rule produced three structural type duplicates. The `no allowTypeImports`
principle still holds for every other edge in the matrix.
```

- [ ] **Step 10: Commit**

```bash
git add eslint.config.js tests/eslint-layer-guard.test.ts .claude/rules/domain-boundaries.md docs/superpowers/specs/2026-05-27-dependency-direction-guard-design.md
git commit -m "fix(config): make foundation eslint zones fire on relative specifiers"
```

---

## Wave 2 — Cheap edge cuts

### Task 2: Delete the deprecated runtime shim

`src/core/domains/ingest/pipeline/infra/runtime.ts` re-exports `isDebug` /
`setDebug` from `infra/runtime.ts` and is marked `@deprecated`. It has fanIn 23
in the graph and 10 direct importers, one of which
(`infra/embedding-model-guard.ts`) is an `infra -> domains` edge for a symbol
that already lives in `infra`.

**Files:**

- Delete: `src/core/domains/ingest/pipeline/infra/runtime.ts`
- Modify (import line only): `src/core/infra/embedding-model-guard.ts`,
  `src/core/domains/ingest/sync/synchronizer.ts`,
  `src/core/domains/ingest/sync/deletion/strategy.ts`,
  `src/core/domains/ingest/sync/parallel-synchronizer.ts`,
  `src/core/domains/ingest/sync/snapshot/snapshot-cleaner.ts`,
  `src/core/domains/ingest/operations/indexing.ts`,
  `src/core/domains/ingest/operations/reindexing.ts`,
  `src/core/domains/ingest/infra/alias-cleanup.ts`,
  `src/core/domains/ingest/infra/optimizer-lifecycle.ts`,
  `src/bootstrap/factory.ts`

**Interfaces:**

- Consumes: `isDebug`, `setDebug` from `src/core/infra/runtime.ts` (unchanged
  signatures: `() => boolean`, `(value: boolean) => void`).
- Produces: no module named `pipeline/infra/runtime.js` — later tasks must not
  reference it.

- [ ] **Step 1: Confirm the shim has no logic of its own**

```bash
cat src/core/domains/ingest/pipeline/infra/runtime.ts
```

Expected: only a doc comment and one
`export { isDebug, setDebug } from "../../../../infra/runtime.js";`. If it
contains anything else, stop. The premise of this task is wrong.

- [ ] **Step 2: Re-point each importer**

For each file listed above, rewrite the import to point at `infra/runtime.js`
with the correct relative depth. Examples (use `Edit`, one per file — do not
script it):

```typescript
// src/core/domains/ingest/sync/synchronizer.ts

// src/core/domains/ingest/pipeline/... (four levels up)
import { isDebug } from "../../../../infra/runtime.js";
import { isDebug } from "../../../infra/runtime.js";
// src/bootstrap/factory.ts
import { isDebug, setDebug } from "../core/infra/runtime.js";
// src/core/infra/embedding-model-guard.ts
import { isDebug } from "./runtime.js";
```

- [ ] **Step 3: Delete the shim and verify nothing references it**

```bash
git rm src/core/domains/ingest/pipeline/infra/runtime.ts
grep -rn "pipeline/infra/runtime" src tests --include="*.ts" | grep -v "^Binary"
```

Expected: the grep prints nothing.

- [ ] **Step 4: Type-check and run the suite**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: both green. `setDebug` is called from `bootstrap` and the vitest setup
only — no behaviour change.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(ingest): drop deprecated pipeline/infra/runtime re-export shim" -m "Why: the shim's 10 importers hid an infra -> domains edge (embedding-model-guard reaching a symbol that already lives in infra/runtime.ts). Deep-silo file, single author."
```

### Task 3: Move `INDEXING_METADATA_ID` into contracts

**Files:**

- Modify: `src/core/contracts/types/provider.ts` (add the constant) — or create
  `src/core/contracts/constants.ts` if `provider.ts` has no constant section
- Delete: `src/core/domains/ingest/constants.ts`
- Modify: `src/core/infra/embedding-model-guard.ts:11`,
  `src/core/infra/migration/adapters/enrichment-store-adapter.ts:9`,
  `src/core/domains/explore/queries/index-metrics.ts:14`,
  `src/core/api/internal/ops/indexing-ops.ts:18`

**Interfaces:**

- Produces: `INDEXING_METADATA_ID: "__indexing_metadata__"` exported from
  `src/core/contracts/constants.ts`.

- [ ] **Step 1: Confirm the source file has exactly one export**

```bash
cat src/core/domains/ingest/constants.ts
```

Expected: a single line exporting `INDEXING_METADATA_ID`.

- [ ] **Step 2: Create the contracts home**

Create `src/core/contracts/constants.ts`:

```typescript
/**
 * Cross-layer well-known identifiers.
 *
 * These are payload-level constants every layer agrees on. They live in
 * `contracts` because `infra`, `adapters`, `domains` and `api` all address the
 * same stored points by them.
 */

/** Point id of the per-collection indexing-metadata marker. */
export const INDEXING_METADATA_ID = "__indexing_metadata__";
```

- [ ] **Step 3: Re-point the four importers**

```typescript
// src/core/infra/embedding-model-guard.ts

// src/core/infra/migration/adapters/enrichment-store-adapter.ts

// src/core/domains/explore/queries/index-metrics.ts

// src/core/api/internal/ops/indexing-ops.ts
import {
  INDEXING_METADATA_ID,
  INDEXING_METADATA_ID,
  INDEXING_METADATA_ID,
} from "../../../contracts/constants.js";
import { INDEXING_METADATA_ID } from "../contracts/constants.js";
```

- [ ] **Step 4: Delete the old file and verify**

```bash
git rm src/core/domains/ingest/constants.ts
grep -rn "ingest/constants" src tests --include="*.ts"
```

Expected: no output.

- [ ] **Step 5: Type-check and run the suite**

```bash
npx tsc --noEmit && npx vitest run
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(contracts): home INDEXING_METADATA_ID in contracts/constants"
```

### Task 4: Bring two error classes down into `infra/errors.ts`

`infra/collection-name.ts:12` imports three error classes from `api/errors.ts`
(foundation reaching the composition root), and
`infra/embedding-model-guard.ts:9` imports `EmbeddingModelMismatchError` from
`adapters/embeddings/errors.ts`. `infra/errors.ts` carries transitiveImpact 236,
so it receives classes but never moves.

**Files:**

- Modify: `src/core/infra/errors.ts` (append classes)
- Modify: `src/core/api/errors.ts` (re-export the three moved classes)
- Modify: `src/core/adapters/embeddings/errors.ts` (re-export
  `EmbeddingModelMismatchError`)
- Create: `src/core/contracts/types/qdrant-point-store.ts`
- Modify: `src/core/infra/collection-name.ts:12`,
  `src/core/infra/embedding-model-guard.ts:9-10`

**Interfaces:**

- Consumes: `TeaRagsError`, `InputValidationError` (already in `infra/errors.ts`
  / `api/errors.ts`).
- Produces: `CollectionNotProvidedError`, `ProjectNotRegisteredError`,
  `StaleProjectAliasError`, `EmbeddingModelMismatchError` all exported from
  `src/core/infra/errors.ts`; the former modules re-export them so no external
  consumer changes.

- [ ] **Step 1: Read both source classes before moving**

```bash
sed -n '26,50p;77,90p' src/core/api/errors.ts
grep -n "StaleProjectAliasError" -A 20 src/core/api/errors.ts
grep -n "EmbeddingModelMismatchError" -A 20 src/core/adapters/embeddings/errors.ts
```

`InputValidationError` is the abstract base of the three `api` classes. It
extends `TeaRagsError`, which already lives in `infra/errors.ts`, so the base
must move too, or the three classes must be re-parented. Move
`InputValidationError` as well and re-export it from `api/errors.ts`; that keeps
`instanceof` checks in `mcp/` intact.

- [ ] **Step 2: Move the classes into `infra/errors.ts`**

Append the class bodies verbatim (no logic edits) after `UnknownError`, keeping
their `code`, message construction and JSDoc. Order: `InputValidationError`
(abstract), then `CollectionNotProvidedError`, `ProjectNotRegisteredError`,
`StaleProjectAliasError`, then `EmbeddingModelMismatchError`.

- [ ] **Step 3: Turn the old locations into re-exports**

```typescript
// src/core/api/errors.ts — replace the moved class bodies with:
export {
  CollectionNotProvidedError,
  InputValidationError,
  ProjectNotRegisteredError,
  StaleProjectAliasError,
} from "../infra/errors.js";

// src/core/adapters/embeddings/errors.ts — replace the moved class body with:
export { EmbeddingModelMismatchError } from "../../infra/errors.js";
```

Keep every other class in both files where it is.

- [ ] **Step 4: Re-point the two infra consumers**

```typescript
// src/core/infra/collection-name.ts
// src/core/infra/embedding-model-guard.ts
import {
  CollectionNotProvidedError,
  EmbeddingModelMismatchError,
  ProjectNotRegisteredError,
  StaleProjectAliasError,
} from "./errors.js";
```

- [ ] **Step 5: Retype the guard's Qdrant dependency to a port**

`embedding-model-guard.ts:10` still holds
`import type { QdrantManager } from "../adapters/qdrant/client.js"`. Read which
methods it calls first:

```bash
grep -n "this.qdrant\." src/core/infra/embedding-model-guard.ts
```

Create `src/core/contracts/types/qdrant-point-store.ts` with exactly those
methods:

```typescript
/**
 * Single-collection point operations.
 *
 * `EmbeddingModelGuard` stays in `infra` (it is consumed only by `api` and
 * `bootstrap`) but must not import `adapters`; it depends on this port and
 * receives the concrete `QdrantManager` by DI from the composition root.
 */
export interface CollectionPointStore {
  getPoint: (
    collectionName: string,
    pointId: string,
  ) => Promise<{ payload?: Record<string, unknown> } | null>;
  upsertPoints: (
    collectionName: string,
    points: readonly { id: string; payload: Record<string, unknown> }[],
  ) => Promise<void>;
  deletePoints: (
    collectionName: string,
    selector: { points: readonly string[] },
  ) => Promise<void>;
}
```

Match every member name, parameter and return type to `QdrantManager`'s real
signatures as printed above — the port mirrors the client, it does not redesign
it. Then switch the guard's annotation to `CollectionPointStore`. Construction
at `bootstrap/factory.ts:202` is unchanged: `QdrantManager` already satisfies
the port structurally.

- [ ] **Step 6: Verify the three edges are gone**

```bash
grep -n "api/errors\|adapters/embeddings/errors\|adapters/qdrant/client" src/core/infra/*.ts
```

Expected: no output.

- [ ] **Step 7: Type-check, lint, run the suite**

```bash
npx tsc --noEmit && npx eslint src/ tests/ && npx vitest run
```

Expected: green. `tests/core/infra/errors.test.ts` and the `api` error tests
cover the classes; neither needs editing because the export surface is
unchanged. `tests/core/infra/embedding-model-guard.test.ts` keeps passing with
its existing Qdrant double — a structural port accepts the same stub.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(api): relocate input-validation errors to infra and port the model guard" -m "Why: infra/collection-name.ts and embedding-model-guard.ts reached up into api/ and adapters/ for error classes and the Qdrant client. Classes move down and former modules re-export them; the client becomes a contracts port the existing QdrantManager satisfies structurally, so consumers and test doubles are untouched."
```

### Task 5: Collapse the three structural type duplicates

**Files:**

- Modify: `src/core/infra/file-classification/classify.ts:6-11` (delete local
  interface, import from contracts)
- Create: `src/core/contracts/types/commit-diff-memo.ts`
- Modify: `src/core/contracts/types/provider.ts:134` (reference the port instead
  of the by-value shape)
- Modify: `src/core/domains/trajectory/git/infra/walk-commits.ts:39`,
  `src/core/domains/trajectory/git/infra/chunk-reader.ts:20-27`
- Modify: `src/core/infra/commit-diff-memo.ts` (declare `implements`)

**Interfaces:**

- Produces: `CommitDiffMemoPort` in
  `src/core/contracts/types/commit-diff-memo.ts`; `FileClassification` has a
  single declaration in `src/core/contracts/types/file-classification.ts`.

- [ ] **Step 1: Confirm the two shapes are identical before merging**

```bash
sed -n '1,25p' src/core/contracts/types/file-classification.ts
sed -n '1,25p' src/core/infra/file-classification/classify.ts
sed -n '125,150p' src/core/contracts/types/provider.ts
sed -n '35,50p' src/core/domains/trajectory/git/infra/walk-commits.ts
grep -n "class CommitDiffMemo" -A 30 src/core/infra/commit-diff-memo.ts
```

If a field differs, the merged declaration must be the union of both and the
step notes which consumer gains a field. Do not silently drop one.

- [ ] **Step 2: Point infra at the contracts `FileClassification`**

```typescript
// src/core/infra/file-classification/classify.ts — delete the local interface,
// delete the "declared locally because infra may not import contracts" comment,
// and add:
import type { FileClassification } from "../../contracts/types/file-classification.js";

export type { FileClassification };
```

The re-export keeps `infra/file-classification/index.ts` consumers working.

- [ ] **Step 3: Create the memo port**

Create `src/core/contracts/types/commit-diff-memo.ts`:

```typescript
/**
 * Run-scoped memo of per-(commitSha, filePath) diff hunks.
 *
 * The concrete memo lives in the ingest domain (it is created per indexing run
 * by the chunk-enrichment phase); the git trajectory consumes it through this
 * port so the two domains stay mutually isolated.
 */
export interface CommitDiffMemoPort {
  get: (
    commitSha: string,
    filePath: string,
  ) => readonly [number, number][] | undefined;
  set: (
    commitSha: string,
    filePath: string,
    hunks: readonly [number, number][],
  ) => void;
}
```

Match the method names and value type to what `commit-diff-memo.ts` actually
exposes as read from Step 1 — this block is the shape to reconcile, not to
invent.

- [ ] **Step 4: Replace the two duplicate declarations**

```typescript
// src/core/contracts/types/provider.ts — the by-value shape at :134 becomes

// ...and the field's type becomes CommitDiffMemoPort

// src/core/domains/trajectory/git/infra/walk-commits.ts — delete the local
// WalkCommitDiffMemo interface and re-export the port under its old name so
// chunk-reader.ts keeps compiling in this task:
import type { CommitDiffMemoPort } from "../../../../contracts/types/commit-diff-memo.js";
import type { CommitDiffMemoPort } from "./commit-diff-memo.js";

export type { CommitDiffMemoPort as WalkCommitDiffMemo };
```

- [ ] **Step 5: Declare the implementation**

```typescript
// src/core/infra/commit-diff-memo.ts
import type { CommitDiffMemoPort } from "../contracts/types/commit-diff-memo.js";

export class CommitDiffMemo implements CommitDiffMemoPort {
```

- [ ] **Step 6: Type-check — this is the real test**

```bash
npx tsc --noEmit
```

Expected: green. A mismatch here means the three shapes were not identical;
reconcile per Step 1's rule rather than loosening the port.

- [ ] **Step 7: Run the suite**

```bash
npx vitest run
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(contracts): single declaration for FileClassification and the commit-diff memo"
```

---

## Wave 3 — Small relocations

### Task 6: Move the Qdrant required-version reader into `adapters/qdrant/`

`infra/qdrant-version.ts` resolves `.qdrant-required-version` from the package
root. Its consumers are `adapters/qdrant/embedded/{download,daemon}.ts`,
`bootstrap/config/qdrant-compat.ts` and `cli/update-check/version-source.ts` —
all legal importers of `adapters`.

**Files:**

- Move: `src/core/infra/qdrant-version.ts` ->
  `src/core/adapters/qdrant/required-version.ts`
- Move: `tests/core/infra/qdrant-version.test.ts` ->
  `tests/core/adapters/qdrant/required-version.test.ts`
- Modify: the four importers above

**Interfaces:**

- Produces: same exported functions, new path
  `src/core/adapters/qdrant/required-version.js`.

- [ ] **Step 1: Move source and test with history**

```bash
git mv src/core/infra/qdrant-version.ts src/core/adapters/qdrant/required-version.ts
git mv tests/core/infra/qdrant-version.test.ts tests/core/adapters/qdrant/required-version.test.ts
```

- [ ] **Step 2: Fix the package-root walk**

The file resolves the version file three levels up from its own directory
(`src/core/infra/` -> package root). From `src/core/adapters/qdrant/` it is four
levels. Update `resolveVersionFilePath`:

```typescript
// Works for both `src/core/adapters/qdrant/required-version.ts` (dev via
// tsx/vitest) and `build/core/adapters/qdrant/required-version.js`
// (published package layout): in both cases the file lives four levels up at
// the package root.
const here = dirname(fileURLToPath(import.meta.url));
return join(here, "..", "..", "..", "..", VERSION_FILE_NAME);
```

- [ ] **Step 3: Re-point importers and the test**

```typescript
// src/core/adapters/qdrant/embedded/download.ts and .../daemon.ts
import { ... } from "../required-version.js";

// src/bootstrap/config/qdrant-compat.ts
import { ... } from "../../core/adapters/qdrant/required-version.js";

// src/cli/update-check/version-source.ts — keep the same symbol, new path
```

`cli` may not import `core/adapters` directly (matrix rule). Check
`version-source.ts` in this step: if it imports the reader directly, re-export
the function through `src/core/api/public/index.ts` and import it from there.

- [ ] **Step 4: Verify the resolved path at runtime**

```bash
npx vitest run tests/core/adapters/qdrant/required-version.test.ts
```

Expected: PASS. If the test only asserts a parsed semver string and never
touches the filesystem, add one assertion that the resolved path ends in
`/.qdrant-required-version` and that the file exists — the four-levels-up change
is exactly the kind of thing a mock would hide.

- [ ] **Step 5: Type-check, lint, full suite, commit**

```bash
npx tsc --noEmit && npx eslint src/ tests/ && npx vitest run
git add -A
git commit -m "refactor(qdrant): move required-version reader into adapters/qdrant" -m "Why: single-external-system pin sat in infra; deep-silo file, single author."
```

### Task 7: Move `MapHierarchyView` into the codegraph trajectory

`infra/graph/hierarchy-view.ts` is typed against `contracts/types/codegraph.ts`
and consumed only by `domains/trajectory/codegraph/symbols/provider.ts` (plus
the `api/internal/composition.ts` and `bootstrap/factory.ts` wiring that
constructs it).

**Files:**

- Move: `src/core/infra/graph/hierarchy-view.ts` ->
  `src/core/domains/trajectory/codegraph/hierarchy-view.ts`
- Move: `tests/core/infra/graph/hierarchy-view.test.ts` ->
  `tests/core/domains/trajectory/codegraph/hierarchy-view.test.ts`
- Modify: `src/core/infra/graph/index.ts` (drop the re-export),
  `src/core/domains/trajectory/codegraph/symbols/provider.ts`,
  `src/core/domains/trajectory/codegraph/index.ts` (export it),
  `src/core/api/internal/composition.ts`, `src/bootstrap/factory.ts`

**Interfaces:**

- Produces: `MapHierarchyView` exported from
  `src/core/domains/trajectory/codegraph/index.js`. `bootstrap` and
  `api/internal` import it from there.

- [ ] **Step 1: Confirm who constructs it**

```bash
grep -rn "MapHierarchyView\|HierarchyView" src --include="*.ts" | grep -v "^src/core/infra/graph/hierarchy-view.ts"
```

Record every construction site — each must be re-pointed in Step 3.
`bootstrap -> domains` is forbidden: if `bootstrap/factory.ts` constructs it
directly, the construction moves into `api/internal/composition.ts` and
`bootstrap` receives the instance (or the factory) from there.

- [ ] **Step 2: Move source and test**

```bash
git mv src/core/infra/graph/hierarchy-view.ts src/core/domains/trajectory/codegraph/hierarchy-view.ts
git mv tests/core/infra/graph/hierarchy-view.test.ts tests/core/domains/trajectory/codegraph/hierarchy-view.test.ts
```

- [ ] **Step 3: Re-point imports and drop the barrel entry**

```typescript
// src/core/infra/graph/index.ts — remove the hierarchy-view export line, keep
// page-rank and tarjan-scc exports.

// src/core/domains/trajectory/codegraph/symbols/provider.ts
import { MapHierarchyView } from "../hierarchy-view.js";

// src/core/domains/trajectory/codegraph/index.ts — add:
export { MapHierarchyView } from "./hierarchy-view.js";
```

- [ ] **Step 4: Type-check, lint, full suite, commit**

```bash
npx tsc --noEmit && npx eslint src/ tests/ && npx vitest run
git add -A
git commit -m "refactor(trajectory): move MapHierarchyView into the codegraph domain" -m "Why: codegraph-typed view sat in infra/graph next to language-agnostic algorithms; single consumer, silo-owned file."
```

### Task 8: Move `CommitDiffMemo` into the ingest enrichment phase

**Files:**

- Move: `src/core/infra/commit-diff-memo.ts` ->
  `src/core/domains/ingest/pipeline/enrichment/commit-diff-memo.ts`
- Move: `tests/core/infra/commit-diff-memo.test.ts` ->
  `tests/core/domains/ingest/pipeline/enrichment/commit-diff-memo.test.ts`
- Modify: `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts:22`

**Interfaces:**

- Consumes: `CommitDiffMemoPort` from Task 5.
- Produces: `CommitDiffMemo` at the new path; every non-ingest consumer refers
  to the port, never the class.

- [ ] **Step 1: Confirm nothing outside ingest imports the class**

```bash
grep -rn "commit-diff-memo" src tests --include="*.ts" | sed 's|src/core/||'
```

Expected after Task 5: only `chunk-phase.ts` (runtime) and the test. The git
trajectory must reference `CommitDiffMemoPort` / `WalkCommitDiffMemo` instead.
If a runtime import remains outside ingest, stop and finish Task 5 first.

- [ ] **Step 2: Move source and test**

```bash
git mv src/core/infra/commit-diff-memo.ts src/core/domains/ingest/pipeline/enrichment/commit-diff-memo.ts
git mv tests/core/infra/commit-diff-memo.test.ts tests/core/domains/ingest/pipeline/enrichment/commit-diff-memo.test.ts
```

- [ ] **Step 3: Re-point the importer and the port import inside the moved
      file**

```typescript
// src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts

// the moved file's own port import
import type { CommitDiffMemoPort } from "../../../../contracts/types/commit-diff-memo.js";
import { CommitDiffMemo } from "./commit-diff-memo.js";
```

- [ ] **Step 4: Type-check, lint, full suite, commit**

```bash
npx tsc --noEmit && npx eslint src/ tests/ && npx vitest run
git add -A
git commit -m "refactor(ingest): move CommitDiffMemo next to its only constructor"
```

### Task 9: Move `SchemaDriftMonitor` into maintenance

The monitor is constructed at `bootstrap/factory.ts:700` and consumed as a type
by `api/internal/{facades/explore-facade,ops/explore-ops}.ts`. `bootstrap` may
not import `domains`, so construction moves into `api/internal`.

**Files:**

- Move: `src/core/infra/schema-drift-monitor.ts` ->
  `src/core/domains/maintenance/schema-drift-monitor.ts`
- Move: `tests/core/infra/schema-drift-monitor.test.ts` ->
  `tests/core/domains/maintenance/schema-drift-monitor.test.ts`
- Modify: `src/bootstrap/factory.ts:46,700`,
  `src/core/api/internal/facades/explore-facade.ts:23`,
  `src/core/api/internal/ops/explore-ops.ts:36`,
  `src/core/api/internal/composition.ts` (new construction site),
  `src/core/domains/maintenance/index.ts` if one exists

**Interfaces:**

- Consumes: `StatsCache` from `src/core/infra/stats-cache.js` (unchanged, stays
  in infra), `resolveCollectionName` from `src/core/infra/collection-name.js`.
- Produces: `SchemaDriftMonitor` exported from
  `src/core/domains/maintenance/schema-drift-monitor.js`; `api/internal` owns
  its construction and passes the instance where `bootstrap` used to.

- [ ] **Step 1: Read the current construction call**

```bash
sed -n '695,715p' src/bootstrap/factory.ts
```

Record every constructor argument — the same values must reach the new
construction site. If an argument is only available in `bootstrap` (e.g. parsed
config), pass it into `api` rather than recomputing it.

- [ ] **Step 2: Move source and test**

```bash
git mv src/core/infra/schema-drift-monitor.ts src/core/domains/maintenance/schema-drift-monitor.ts
git mv tests/core/infra/schema-drift-monitor.test.ts tests/core/domains/maintenance/schema-drift-monitor.test.ts
```

- [ ] **Step 3: Fix the moved file's own imports**

```typescript
import { resolveCollectionName } from "../../infra/collection-name.js";
import { StatsCache } from "../../infra/stats-cache.js";
```

- [ ] **Step 4: Move the construction into `api/internal/composition.ts`**

Build the monitor there with the arguments recorded in Step 1 and expose it on
the composition result. `bootstrap/factory.ts` drops its `SchemaDriftMonitor`
import and reads the instance off the composition instead of constructing it.

- [ ] **Step 5: Check the second drift test**

```bash
grep -n "import" tests/core/infra/schema-drift.test.ts | head
```

If it imports the monitor, move it to
`tests/core/domains/maintenance/schema-drift.test.ts` as well. If it targets
`schema-drift` detection elsewhere (e.g. the ingest-side drift check), leave it.

- [ ] **Step 6: Type-check, lint, full suite, commit**

```bash
npx tsc --noEmit && npx eslint src/ tests/ && npx vitest run
git add -A
git commit -m "refactor(drift): move SchemaDriftMonitor into the maintenance domain" -m "Why: index-staleness detection is product policy, not a foundation helper; construction moves to api/internal because bootstrap may not import domains. Deep-silo file, single author."
```

---

## Wave 4 — Registry

### Task 10: Introduce `CollectionRegistryPort` and switch the type-only consumers

Prep task: no files move. It de-risks Task 11 by making the two cross-domain
type dependencies port-based first.

**Files:**

- Create: `src/core/contracts/types/registry.ts`
- Modify: `src/core/domains/ingest/pipeline/base.ts:19`,
  `src/core/domains/maintenance/worktree/worktree-provisioner.ts:6`,
  `src/core/infra/collection-name.ts:13`
- Modify: `src/core/infra/registry/collection-registry.ts` (declare
  `implements`)

**Interfaces:**

- Produces: `CollectionRegistryPort` — the subset of `CollectionRegistry` its
  cross-module consumers call. Task 11 relies on this name.

- [ ] **Step 1: Find which methods the three consumers actually call**

```bash
grep -n "registry\.\|this.registry" src/core/domains/ingest/pipeline/base.ts src/core/domains/maintenance/worktree/worktree-provisioner.ts src/core/infra/collection-name.ts
```

The port carries exactly those methods, not the whole class surface.

- [ ] **Step 2: Write the port**

Create `src/core/contracts/types/registry.ts`:

```typescript
/**
 * Project-registry port.
 *
 * The concrete `CollectionRegistry` lives in the maintenance domain; consumers
 * in other modules (ingest pipeline, collection-name resolution) depend on this
 * interface and receive the instance by DI, so domains stay mutually isolated
 * and `infra` never reaches upward.
 */
import type { CollectionEntry } from "./registry-entry.js";

export interface CollectionRegistryPort {
  get: (logicalName: string) => CollectionEntry | undefined;
  findByPath: (absolutePath: string) => CollectionEntry | undefined;
}
```

Replace the member list with Step 1's findings. If `CollectionEntry` is not yet
in `contracts`, move that type here too (`registry/types.ts` is a type-only
module; the guard spec's own violation table already prescribed
`CollectionEntry type -> contracts`).

- [ ] **Step 3: Switch the consumers to the port type**

```typescript
// src/core/domains/ingest/pipeline/base.ts
// src/core/domains/maintenance/worktree/worktree-provisioner.ts
import type {
  CollectionRegistryPort,
  CollectionRegistryPort,
} from "../../../contracts/types/registry.js";
// src/core/infra/collection-name.ts
import type { CollectionRegistryPort } from "../contracts/types/registry.js";
```

Rename the annotated parameter/field types from `CollectionRegistry` to
`CollectionRegistryPort` at each use site. No runtime change.

- [ ] **Step 4: Declare the implementation**

```typescript
// src/core/infra/registry/collection-registry.ts
export class CollectionRegistry implements CollectionRegistryPort {
```

- [ ] **Step 5: Type-check — the real test for this task**

```bash
npx tsc --noEmit
```

Expected: green. A failure means the port is missing a method a consumer calls;
add it rather than widening the annotation back to the class.

- [ ] **Step 6: Lint, suite, commit**

```bash
npx eslint src/ tests/ && npx vitest run
git add -A
git commit -m "refactor(contracts): add CollectionRegistryPort for cross-module registry access"
```

### Task 11: Move `registry/**` into `domains/maintenance/registry/`

One task, not three: taskIds `#1` and `#4` show `collection-registry.ts`,
`registry-file.ts` and `constants.ts` have always changed together.

**Files:**

- Move:
  `src/core/infra/registry/{collection-registry,registry-file,constants,env-groups,types,index}.ts`
  -> `src/core/domains/maintenance/registry/`
- Move: `src/core/adapters/registry/errors.ts` ->
  `src/core/domains/maintenance/registry/errors.ts` (delete the
  `adapters/registry/` directory)
- Move: `tests/core/infra/registry/**` ->
  `tests/core/domains/maintenance/registry/**`
- Modify: `src/bootstrap/factory.ts:45`, `src/core/api/index.ts:49-50`,
  `src/core/api/public/index.ts:73-76`,
  `src/core/api/internal/ops/{project-registry-ops,worktree-ops,trace-path-ops,explore-ops}.ts`,
  `src/core/api/internal/facades/{explore-facade,ingest-facade,graph-facade}.ts`,
  `src/core/api/internal/infra/schema-builder.ts:16`,
  `src/core/api/public/app.ts:22`,
  `src/core/domains/maintenance/{footprint,worktree}/*` (relative depth changes)

**Interfaces:**

- Consumes: `CollectionRegistryPort` (Task 10).
- Produces: `CollectionRegistry`, `PROJECT_NAME_RE`, `REGISTRY_ENV_GROUPS`,
  `REGISTRY_ENV_ALLOWLIST`, and the four registry error classes exported from
  `src/core/domains/maintenance/registry/index.js`; the same names still
  re-exported from `src/core/api/public/index.js` so `cli`/`mcp` are untouched.

- [ ] **Step 1: Baseline and inventory**

```bash
npx vitest run tests/core/infra/registry && grep -rn "infra/registry" src tests --include="*.ts" | wc -l
```

Record the count — Step 5 must drive it to zero.

- [ ] **Step 2: Move sources with history**

```bash
mkdir -p src/core/domains/maintenance/registry
git mv src/core/infra/registry/collection-registry.ts src/core/domains/maintenance/registry/
git mv src/core/infra/registry/registry-file.ts src/core/domains/maintenance/registry/
git mv src/core/infra/registry/constants.ts src/core/domains/maintenance/registry/
git mv src/core/infra/registry/env-groups.ts src/core/domains/maintenance/registry/
git mv src/core/infra/registry/types.ts src/core/domains/maintenance/registry/
git mv src/core/infra/registry/index.ts src/core/domains/maintenance/registry/
git mv src/core/adapters/registry/errors.ts src/core/domains/maintenance/registry/errors.ts
mkdir -p tests/core/domains/maintenance/registry
git mv tests/core/infra/registry/* tests/core/domains/maintenance/registry/
```

- [ ] **Step 3: Fix the moved files' own imports**

`collection-registry.ts` and `registry-file.ts` currently import
`../../adapters/registry/errors.js`; that becomes `./errors.js`. The moved
`errors.ts` extends `InfraError` — re-point it to `../../../infra/errors.js` and
delete its "KNOWN LAYERING CAVEAT" comment block, which no longer describes
reality.

- [ ] **Step 4: Re-point every consumer**

`api/*` files: depth changes from `../../../infra/registry/index.js` to
`../../../domains/maintenance/registry/index.js` (adjust `../` count per file).
`bootstrap/factory.ts:45` must NOT import the domain. Switch it to:

```typescript
import { CollectionRegistry } from "../core/api/public/index.js";
```

`api/public/index.ts:73-76` and `api/index.ts:49-50` re-export from the new
path. `domains/maintenance/{footprint,worktree}/*` shorten to
`../registry/index.js`.

- [ ] **Step 5: Verify no reference to the old path survives**

```bash
grep -rn "infra/registry\|adapters/registry" src tests --include="*.ts"
```

Expected: no output.

- [ ] **Step 6: Type-check, lint, full suite**

```bash
npx tsc --noEmit && npx eslint src/ tests/ && npx vitest run
```

Expected: green, including
`tests/core/domains/maintenance/registry/collection-registry.worktree.test.ts`
(worktree provenance) — the highest-value behavioural check in this task.

- [ ] **Step 7: Verify tests were moved, not modified**

```bash
git diff --cached -M --stat tests/
```

Expected: every registry test shows as a rename with at most import-line
changes. A test whose assertions changed means the refactor altered behaviour —
revert and investigate.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(config): move the project registry into domains/maintenance" -m "Why: alias catalogue, worktree provenance and env replay are product state, not foundation helpers. Error classes return from adapters/registry, closing the documented KNOWN LAYERING CAVEAT. Deep-silo files (100% single-author on registry-file/constants), coordinated per taskIds #1/#4."
```

---

## Wave 5 — Migration

### Task 12: Introduce the migration ports

Prep task: no files move.

**Files:**

- Create: `src/core/contracts/types/migration.ts`
- Modify: `src/core/domains/ingest/factory.ts:32` (retype the DI slot)
- Modify: `src/core/infra/migration/migrator.ts`,
  `src/core/infra/migration/{schema,sparse}-migrator.ts` (declare `implements`)
- Modify: `src/core/infra/migration/adapters/snapshot-store-adapter.ts` (consume
  the injected access port)
- Create: `src/core/domains/ingest/sync/snapshot/sharded-snapshot-access.ts`

**Interfaces:**

- Produces:
  - `MigratorPort` — `run(pipeline)` plus the `latestVersion` readings
    `SchemaManager` needs.
  - `ShardedSnapshotAccess` + `ShardedSnapshotAccessFactory` — the two-method
    surface `SnapshotStoreAdapter` uses (`save`, `load`).
  - `DatabaseMigrationApplier` — used by Task 13.

- [ ] **Step 1: Write the ports**

Create `src/core/contracts/types/migration.ts`:

```typescript
/**
 * Migration ports.
 *
 * The migration pipelines live in the maintenance domain; the ingest pipeline
 * triggers them and the DuckDB pool applies graph DDL. Both reach the concrete
 * implementations through these interfaces, wired by the composition root —
 * the same pattern `contracts/types/footprint.ts` uses for footprint stores.
 */

export type MigrationPipelineName = "schema" | "snapshot" | "sparse";

/** Result shape a pipeline run reports back. Mirrors MigrationSummary. */
export interface MigrationRunSummary {
  applied: number;
  fromVersion: number;
  toVersion: number;
}

export interface MigratorPort {
  run: (pipeline: MigrationPipelineName) => Promise<MigrationRunSummary>;
}

/** Latest schema/sparse versions the collection creator stamps. */
export interface MigrationVersions {
  schema: number;
  sparse: number;
}

/** The sharded-snapshot operations the snapshot migration steps need. */
export interface ShardedSnapshotAccess {
  save: (
    codebasePath: string,
    files: Map<string, { mtime: number; size: number; hash: string }>,
  ) => Promise<void>;
  load: () => Promise<{
    codebasePath: string;
    files: Map<string, { mtime: number; size: number; hash: string }>;
  } | null>;
}

/** Builds a {@link ShardedSnapshotAccess} bound to (snapshotDir, collectionName, shardCount). */
export type ShardedSnapshotAccessFactory = (
  snapshotDir: string,
  collectionName: string,
  shardCount: number,
) => ShardedSnapshotAccess;

/** Applies pending graph DDL to a freshly opened DuckDB collection. */
export type DatabaseMigrationApplier = (
  client: MigrationCapableGraphClient,
) => Promise<void>;

/** The client surface the DDL runner needs — mirrors MigrationCapableClient. */
export interface MigrationCapableGraphClient {
  run: (sql: string) => Promise<void>;
  all: <T>(sql: string) => Promise<T[]>;
}
```

Reconcile `MigrationRunSummary` with `MigrationSummary` in
`src/core/infra/migration/types.ts` and `MigrationCapableGraphClient` with
`MigrationCapableClient` in `.../database/runner.ts` before writing — if the
existing shapes differ, the port mirrors the existing one exactly. Do not
introduce a second vocabulary.

- [ ] **Step 2: Implement the snapshot access in ingest**

Create `src/core/domains/ingest/sync/snapshot/sharded-snapshot-access.ts`:

```typescript
import type {
  ShardedSnapshotAccess,
  ShardedSnapshotAccessFactory,
} from "../../../../contracts/types/migration.js";
import { ShardedSnapshotManager } from "./sharded-snapshot.js";

/**
 * Adapts ShardedSnapshotManager to the migration-side access port so the
 * maintenance migration steps never import the ingest domain.
 */
export const createShardedSnapshotAccess: ShardedSnapshotAccessFactory = (
  snapshotDir,
  collectionName,
  shardCount,
): ShardedSnapshotAccess => {
  const manager = new ShardedSnapshotManager(
    snapshotDir,
    collectionName,
    shardCount,
  );
  return {
    save: (codebasePath, files) => manager.save(codebasePath, files),
    load: () => manager.load(),
  };
};
```

- [ ] **Step 3: Switch `SnapshotStoreAdapter` to the injected factory**

Replace its `ShardedSnapshotManager` import and both construction sites
(`writeSharded` at :89-94, the invalidation path at :119-140) with a
constructor-injected `ShardedSnapshotAccessFactory`. The adapter keeps its own
filesystem checks (`getFormat`, `readShardCount`) — only manager construction
moves behind the port.

- [ ] **Step 4: Retype the ingest DI slot**

```typescript
// src/core/domains/ingest/factory.ts:32
createMigrator: (collectionName: string, codebasePath: string) => MigratorPort;
```

with `import type { MigratorPort } from "../../contracts/types/migration.js";`.
`SchemaManager` construction at :52-59 keeps working for now — it still reads
`schemaMigrator.latestVersion` from the concrete class in the same file.

- [ ] **Step 5: Verify the ingest edge is gone from the adapter**

```bash
grep -n "domains/ingest" src/core/infra/migration/adapters/*.ts
```

Expected: no output.

- [ ] **Step 6: Type-check, lint, suite, commit**

```bash
npx tsc --noEmit && npx eslint src/ tests/ && npx vitest run
git add -A
git commit -m "refactor(contracts): add migration ports and inject sharded-snapshot access"
```

### Task 13: Inject the DuckDB DDL applier

Behaviour-touching task, landed while the DDL still lives in `infra/migration/`
so the injection mechanism is verified independently of the subtree move.

**Files:**

- Modify: `src/core/adapters/duckdb/pool.ts:63-80` (options), `:514-540`
  (`openCollection`)
- Modify: `src/core/adapters/duckdb/daemon/entry.ts:41-73`
  (`DaemonRuntimeOptions`), `:220-231` (pool construction)
- Modify: `src/bootstrap/factory.ts:343` (spawn args), `:420`, `:718` (pool
  construction)
- Modify: `src/core/domains/trajectory/codegraph/factory.ts:165` (pool
  construction)
- Create: `src/core/infra/migration/database/module-path.ts` (moves with the
  subtree in Task 14)

**Interfaces:**

- Consumes: `DatabaseMigrationApplier`, `MigrationCapableGraphClient` (Task 12).
- Produces: `GraphDbClientPoolOptions.applyMigrations` (required);
  `DaemonRuntimeOptions.migrationsModulePath` (required);
  `DATABASE_MIGRATIONS_MODULE_URL`.

- [ ] **Step 1: Write the failing test**

Create `tests/core/adapters/duckdb/pool-applies-migrations.test.ts`:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NoopGlobalSymbolTable } from "../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import { GraphDbClientPool } from "../../../../src/core/adapters/duckdb/pool.js";

describe("GraphDbClientPool — migration injection", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "pool-migrations-"));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("calls the injected applier exactly once per opened collection", async () => {
    const calls: string[] = [];
    const pool = new GraphDbClientPool({
      rootDir,
      symbolTableFactory: () => new NoopGlobalSymbolTable(),
      applyMigrations: async () => {
        calls.push("applied");
      },
    });

    const handle = await pool.acquireWrite("test_collection");
    await handle.release();
    await pool.closeAll();

    expect(calls).toEqual(["applied"]);
  });
});
```

Match `acquireWrite` / `release` to the pool's real API as read from `pool.ts` —
if the write handle is acquired differently, use that call and keep the
single-invocation assertion.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/core/adapters/duckdb/pool-applies-migrations.test.ts
```

Expected: FAIL — `applyMigrations` is not a known option (type error) and the
pool still imports the runner itself.

- [ ] **Step 3: Add the option and use it**

```typescript
// src/core/adapters/duckdb/pool.ts — in GraphDbClientPoolOptions
/**
 * Applies pending graph DDL to a freshly opened collection. Required: the
 * migration steps live in the maintenance domain, which `adapters` may not
 * import, so the composition root injects them.
 */
applyMigrations: DatabaseMigrationApplier;
```

In `openCollection` (and the daemon-handle path if it opens files too) replace
the two dynamic imports with:

```typescript
await graphDb.init();
await this.options.applyMigrations(graphDb);
```

- [ ] **Step 4: Export the module URL for cross-process delivery**

Create `src/core/infra/migration/database/module-path.ts`:

```typescript
/**
 * Resolved URL of the DDL migration module.
 *
 * The codegraph daemon runs in its own process and creates graph databases, so
 * it must apply DDL itself. It lives in `adapters`, which may not import the
 * migration module directly — the spawner passes this URL and the daemon
 * imports it in-process (the module-path DI pattern already used for worker
 * threads).
 */
export const DATABASE_MIGRATIONS_MODULE_URL = new URL(
  "./index.js",
  import.meta.url,
).href;
```

Note `./index.js` resolves against `database/` — the same directory that holds
`migrations/index.ts`; point it at whichever module exports both `runMigrations`
and `DATABASE_MIGRATIONS`, adding a barrel there if neither does.

- [ ] **Step 5: Wire the three in-process construction sites**

`bootstrap/factory.ts:420` and `:718` build the applier from the migration
module (legal: `bootstrap -> infra` today, `bootstrap -> api/public` after
Task 14) and pass it as `applyMigrations`.
`domains/trajectory/codegraph/factory.ts:165` receives the applier through
`CodegraphWorkerConfig` — add the field and thread it from the composition root
rather than importing the module inside the domain.

- [ ] **Step 6: Wire the daemon**

```typescript
// src/core/adapters/duckdb/daemon/entry.ts — DaemonRuntimeOptions
/** URL of the module exporting `runMigrations` + `DATABASE_MIGRATIONS`. */
migrationsModulePath: string;
```

In `runDaemon`, before constructing the pool:

```typescript
const { runMigrations, DATABASE_MIGRATIONS } = (await import(
  options.migrationsModulePath
)) as {
  runMigrations: (
    client: MigrationCapableGraphClient,
    migrations: unknown[],
  ) => Promise<unknown>;
  DATABASE_MIGRATIONS: unknown[];
};
```

and pass
`applyMigrations: (db) => runMigrations(db, DATABASE_MIGRATIONS).then(() => undefined)`.
`bootstrap/factory.ts:343` adds the URL to the spawn argv (and the daemon entry
parses it next to the existing args), so `adapters` holds no literal domain
path.

- [ ] **Step 7: Run the new test, then the full suite**

```bash
npx vitest run tests/core/adapters/duckdb/pool-applies-migrations.test.ts
npx tsc --noEmit && npx eslint src/ tests/ && npx vitest run
```

Expected: all green. Any pool construction site missed in Steps 5-6 is a type
error, not a silent skip. That is why the option is required.

- [ ] **Step 8: Live gate — fresh graph DB**

```bash
DEBUG=1 npx tea-rags index-codebase --project tea-rags --wait-enrichments --force --json
```

Expected: completes; the JSON reports `codegraphResolve` stats. Then confirm
health:

```bash
DEBUG=1 npx tea-rags status --project tea-rags
```

Expected: `codegraph.symbols` file and chunk both healthy. This is the one gate
that proves the daemon path applies DDL — it cannot be replaced by a unit test.
Reindex is user-gated: ask before running, per `.claude/rules/.local/`
build/reindex policy.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(adapters): inject the graph DDL applier into the DuckDB pool" -m "Why: adapters may not import the migration module once it moves to maintenance; the daemon runs in its own process and creates DBs, so it receives the module URL at spawn (module-path DI, same pattern as worker threads)."
```

### Task 14: Move `migration/**` into `domains/maintenance/migration/`

**Files:**

- Move: `src/core/infra/migration/**` (30 files) ->
  `src/core/domains/maintenance/migration/`
- Move: `tests/core/infra/migration/**` ->
  `tests/core/domains/maintenance/migration/**`
- Modify: `src/core/domains/ingest/factory.ts:12-19,52-59,69-86` (drop migration
  imports; the composition supplies the migrator and versions)
- Modify: `src/core/api/internal/composition.ts` (new composition site),
  `src/bootstrap/factory.ts` (applier import path),
  `src/core/api/public/index.ts` (export the applier factory for `bootstrap`)

**Interfaces:**

- Consumes: `MigratorPort`, `MigrationVersions`, `ShardedSnapshotAccessFactory`,
  `DatabaseMigrationApplier` (Tasks 12-13).
- Produces: `createMigrator(...)` and `createDatabaseMigrationApplier()`
  exported from `src/core/domains/maintenance/migration/index.js`, re-exported
  through `api/public` for `bootstrap`.

- [ ] **Step 1: Baseline the migration suites**

```bash
npx vitest run tests/core/infra/migration
```

Expected: green. Record the test count.

- [ ] **Step 2: Move the subtree with history**

```bash
mkdir -p src/core/domains/maintenance/migration
git mv src/core/infra/migration/* src/core/domains/maintenance/migration/
mkdir -p tests/core/domains/maintenance/migration
git mv tests/core/infra/migration/* tests/core/domains/maintenance/migration/
```

- [ ] **Step 3: Fix the moved files' own imports**

Each moved file's relative depth changes by one level and its layer prefix
changes. The three Qdrant store adapters now import
`../../../../adapters/qdrant/client.js` (legal: `domains -> adapters`);
`enrichment-store-adapter.ts` imports `../../../../contracts/constants.js` (Task
3); `snapshot-store-adapter.ts` imports only
`../../../../contracts/types/migration.js` (Task 12).

- [ ] **Step 4: Compose the migrator in `api/internal`**

Move the `createMigrator` body from `ingest/factory.ts:69-86` into
`api/internal/composition.ts`, building the four stores, the three pipelines and
the `Migrator` there, plus `createShardedSnapshotAccess` from ingest as the
injected factory. Pass the result into `IngestFacadeDeps` so `reindexing.ts:220`
still calls `this.deps.createMigrator(...)` unchanged.

Supply `SchemaManager` with a `MigrationVersions` value from the same
composition instead of reading `schemaMigrator.latestVersion` inside
`ingest/factory.ts`.

- [ ] **Step 5: Verify no reference to the old path survives**

```bash
grep -rn "infra/migration" src tests --include="*.ts"
```

Expected: no output.

- [ ] **Step 6: Type-check, lint, full suite**

```bash
npx tsc --noEmit && npx eslint src/ tests/ && npx vitest run
```

- [ ] **Step 7: Verify tests moved, not modified**

```bash
git diff --cached -M --stat tests/
```

Expected: renames with import-line-only changes.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(config): move the migration framework into domains/maintenance" -m "Why: schema/snapshot/sparse/DDL upgrades are index-lifecycle maintenance; composition moves to api/internal because ingest may not import a sibling domain. Deep-silo subtree, single author."
```

### Task 15: Enable the infra deny patterns and run the acceptance gates

**Files:**

- Modify: `eslint.config.js` (uncomment the `infra` deny group from Task 1)
- Modify: `tests/eslint-layer-guard.test.ts` (unskip the `infra -> domains`
  case)
- Modify: `.claude/rules/domain-boundaries.md` (final module list)

- [ ] **Step 1: Prove there is nothing left to catch**

```bash
grep -rnE 'from "\.\..*(domains|adapters|api)/' src/core/infra --include="*.ts"
```

Expected: no output. Any hit means an earlier task is incomplete. Fix it there,
not here.

- [ ] **Step 2: Enable the patterns and unskip the test**

Uncomment the `group` line authored in Task 1 Step 6, delete the placeholder
group and the `TODO(wave-5)` comment, and change the skipped fixture case back
to `it(...)`.

- [ ] **Step 3: Lint and run the fixture test**

```bash
npx eslint src/ tests/ && npx vitest run tests/eslint-layer-guard.test.ts
```

Expected: eslint exits 0; all four fixture cases pass.

- [ ] **Step 4: Confirm the target shape**

```bash
git ls-files src/core/infra | xargs wc -l | tail -1
```

Expected: 1329 total. A different number means a module landed somewhere the
spec did not plan — reconcile against the spec's placement tables before
committing.

- [ ] **Step 5: Full gates**

```bash
npx tsc --noEmit && npx eslint src/ tests/ && npm run test:coverage
```

Expected: suite green and coverage at or above the current thresholds (never
lower a threshold — if coverage dips, the moved tests did not move with their
subject).

- [ ] **Step 6: Cycle check**

Run `mcp__tea-rags__find_cycles` for the project and compare with the pre-branch
baseline. Expected: no new cycle. Requires a reindex of the branch — user-gated,
same as Task 13 Step 8.

- [ ] **Step 7: Update the rule doc's module list and commit**

```bash
git add -A
git commit -m "fix(config): enable the infra layer guard now that no upward edge remains"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: foundation order and guard
repair -> Task 1 and 15; the 17 upward edges -> Tasks 2, 3, 4, 12, 13, 14 (infra
-> domains/adapters/api) and Task 1 (the contracts edges become legal); the
three type duplicates -> Task 5; the six relocations -> Tasks 6, 7, 8, 9, 11,
14; the four wirings -> W1 in Tasks 10-11, W2 in Tasks 12 and 14, W3 in Task 13,
W4 in Task 4. The first pass of this plan left W4's `CollectionPointStore` port
in prose with no step; it is now Task 4 Step 5, which is also where the guard's
last edge (`import type { QdrantManager }`) dies.

**Placeholder scan.** No "TBD"/"handle edge cases"/"similar to Task N". Steps
that cannot be fully pre-written (exact port member lists, exact constructor
argument lists) instead name the command that produces the answer and the rule
for reconciling it — deliberate, because inventing a member list the code does
not have is the failure mode those steps guard against.

**Type consistency.** `CollectionRegistryPort` (Task 10) is consumed by Task 11.
`CommitDiffMemoPort` (Task 5) is consumed by Task 8. `MigratorPort`,
`ShardedSnapshotAccessFactory`, `DatabaseMigrationApplier`,
`MigrationCapableGraphClient` (Task 12) are consumed by Tasks 13-14.
`INDEXING_METADATA_ID` (Task 3) is consumed by Task 14 Step 3. No task
references a symbol another task did not declare.
