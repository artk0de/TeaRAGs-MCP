# Qdrant 1.18 TurboQuant Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Qdrant 1.18 TurboQuant 8x dense-vector quantization by default,
applied to new and existing collections without a tea-rags reindex, with
mandatory search-time rescore so recall stays at baseline.

**Architecture:** A `QDRANT_TURBO_QUANT` env (default ON) flows through
`QdrantTuneConfig` into `QdrantManager.createCollection` (new collections) and a
startup reconcile in `factory.ts` (existing collections, via
`update_collection`). All dense search paths inject
`params.quantization.{rescore,oversampling}` so quantized candidates are
re-scored on stored float vectors.

**Tech Stack:** TypeScript (ESM), vitest, `@qdrant/js-client-rest@1.18.0`, Zod
config.

## Global Constraints

- Foundation is DONE: pin 1.18.2, SDK 1.18.0 installed. quantization is a
  vector-storage config — **no tea-rags reindex, no schema-drift**.
- `createCollection` change is **ADDITIVE** (new optional 6th param). It MUST
  break zero existing positional callers and MUST keep the scalar-quant
  business-logic tests (`tests/core/adapters/qdrant/quantization.test.ts`) green
  unchanged.
- SDK 1.18.0 types (verified):
  `quantization_config: { turbo: { bits: "bits4", always_ram: true } }`;
  `params: { quantization: { rescore: true, oversampling: 2.0 } }`.
- TDD (vitest). `tsc --noEmit` 0 errors at every commit. Typed errors only (no
  bare `throw new Error`). Conventional commits, scoped, header ≤100, body lines
  ≤100, co-author footer.
- Build/`npm link`/reindex are **USER-GATED** (3 active worktrees). Do NOT
  merge/push.
- Beads epic `tea-rags-mcp-62zf`; each Task = one child task.

---

### Task 1: Config type + env wiring (`QDRANT_TURBO_QUANT`, default ON)

**Files:**

- Modify: `src/core/contracts/types/config.ts` (add `turboQuant` to
  `QdrantTuneConfig`)
- Modify: `src/bootstrap/config/schemas.ts` (Zod field, default true)
- Modify: `src/bootstrap/config/parse.ts` (`buildEnvInputs` reads
  `QDRANT_TURBO_QUANT`)
- Test: `tests/bootstrap/qdrant-tune-env.test.ts` (existing — extend)

**Interfaces:**

- Produces: `QdrantTuneConfig.turboQuant: boolean` (default `true`), surfaced
  from env `QDRANT_TURBO_QUANT`.

- [ ] **Step 1: Read the existing `QDRANT_TUNE_*` wiring to mirror its style.**

Read these to copy the established pattern exactly:

- `src/core/contracts/types/config.ts` — find the `QdrantTuneConfig` type (it
  has `upsertBatchSize`, etc.).
- `src/bootstrap/config/schemas.ts` — find the `QdrantTuneConfig` Zod schema
  block.
- `src/bootstrap/config/parse.ts` — find where `buildEnvInputs` reads
  `QDRANT_TUNE_*` env vars.
- `tests/bootstrap/qdrant-tune-env.test.ts` — the test conventions for env
  parsing.

- [ ] **Step 2: Write the failing env-parsing test.**

In `tests/bootstrap/qdrant-tune-env.test.ts`, add (adapt names to the file's
existing helpers for building config from env):

```ts
it("QDRANT_TURBO_QUANT defaults to true when unset", () => {
  const cfg = parseConfigFromEnv({}); // use the file's existing parse helper
  expect(cfg.qdrantTune.turboQuant).toBe(true);
});
it("QDRANT_TURBO_QUANT=false disables turbo", () => {
  const cfg = parseConfigFromEnv({ QDRANT_TURBO_QUANT: "false" });
  expect(cfg.qdrantTune.turboQuant).toBe(false);
});
it("QDRANT_TURBO_QUANT=true enables turbo", () => {
  const cfg = parseConfigFromEnv({ QDRANT_TURBO_QUANT: "true" });
  expect(cfg.qdrantTune.turboQuant).toBe(true);
});
```

Run: `npx vitest run tests/bootstrap/qdrant-tune-env.test.ts` Expected: FAIL
(turboQuant not on the type / not parsed).

- [ ] **Step 3: Add the type field.**

In `src/core/contracts/types/config.ts`, add to the `QdrantTuneConfig` type
(alongside the existing fields):

```ts
/** Enable Qdrant 1.18 TurboQuant 8x dense quantization (default true). */
turboQuant: boolean;
```

- [ ] **Step 4: Add the Zod field with default true + boolean coercion.**

In `src/bootstrap/config/schemas.ts`, in the `QdrantTuneConfig` Zod object,
mirror the existing boolean-coercion style (the file already coerces booleans
for other flags — match it). Add:

```ts
  turboQuant: z.coerce.boolean().default(true),
```

If the file uses a custom string→boolean coercion for env (e.g.
`"false"`→false), use that SAME helper instead of `z.coerce.boolean()` —
`z.coerce.boolean("false")` is truthy, so the project's existing env-boolean
helper MUST be reused. Confirm by reading how `QDRANT_TUNE_*` or
`CODEGRAPH_ENABLED` booleans are coerced and copy that.

- [ ] **Step 5: Read the env in `buildEnvInputs`.**

In `src/bootstrap/config/parse.ts#buildEnvInputs`, where the `qdrantTune` inputs
are assembled from `process.env.QDRANT_TUNE_*`, add a line reading
`process.env.QDRANT_TURBO_QUANT` into the qdrantTune input object key
`turboQuant` (mirror the exact assignment style used for the sibling QDRANT_TUNE
keys).

- [ ] **Step 6: Run tests + tsc.**

Run: `npx vitest run tests/bootstrap/qdrant-tune-env.test.ts` → PASS. Run:
`npx tsc --noEmit` → 0 errors.

- [ ] **Step 7: Commit.**

```bash
git add src/core/contracts/types/config.ts src/bootstrap/config/schemas.ts src/bootstrap/config/parse.ts tests/bootstrap/qdrant-tune-env.test.ts
git commit -m "feat(config): add QDRANT_TURBO_QUANT env (default on) to QdrantTuneConfig

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `createCollection` additive `turboQuant` param + emit turbo config

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts`
  (`QdrantManager.createCollection`, ~179-250)
- Modify: `src/core/api/internal/ops/collection-ops.ts:24` (production caller)
- Modify: `src/core/domains/ingest/operations/indexing.ts:296` (production
  caller — the index path)
- Modify: `tests/core/domains/ingest/__helpers__/test-helpers.ts:91`
  (`MockQdrantManager.createCollection` signature)
- Modify: `tests/integration/integration.test.ts:80` (Mock signature)
- Test: `tests/core/adapters/qdrant/quantization.test.ts` (extend — turbo
  branch)

**Interfaces:**

- Consumes: `QdrantTuneConfig.turboQuant` (Task 1).
- Produces:
  `createCollection(name, vectorSize, distance?, enableSparse?, quantizationScalar?, turboQuant?)`
  — 6th param OPTIONAL, default `false`. When `turboQuant` is true the
  collection config carries
  `quantization_config: { turbo: { bits: "bits4", always_ram: true } }`.

**Why additive, not options-object:** ~30+ positional call sites exist
(status-module.test.ts, client.test.ts, ingest enrichment tests). An additive
optional 6th param breaks none of them; an options-object refactor would force
rewriting all of them and risk business-logic test edits.

- [ ] **Step 1: Write the failing turbo test.**

In `tests/core/adapters/qdrant/quantization.test.ts`, add (the file already
mocks the Qdrant client + asserts `createCollection` config — mirror its
existing assertions):

```ts
it("emits turbo quantization_config when turboQuant=true", async () => {
  await manager.createCollection("test-col", 384, "Cosine", false, false, true);
  // assert the mock client.createCollection received quantization_config.turbo.bits = "bits4"
  const cfg = createCollectionSpy.mock.calls.at(-1)[1];
  expect(cfg.quantization_config).toEqual({
    turbo: { bits: "bits4", always_ram: true },
  });
});
it("turboQuant takes precedence over quantizationScalar", async () => {
  await manager.createCollection("test-col", 384, "Cosine", false, true, true);
  const cfg = createCollectionSpy.mock.calls.at(-1)[1];
  expect(cfg.quantization_config).toEqual({
    turbo: { bits: "bits4", always_ram: true },
  });
});
```

(Use the file's existing spy/mock handle name for the Qdrant client
`createCollection`; read the top of the file to get it.) Run:
`npx vitest run tests/core/adapters/qdrant/quantization.test.ts` Expected: FAIL
(turbo not emitted; 6th param unknown).

- [ ] **Step 2: Add the optional param + turbo branch in `createCollection`.**

In `src/core/adapters/qdrant/client.ts`, change the signature:

```ts
  async createCollection(
    name: string,
    vectorSize: number,
    distance: "Cosine" | "Euclid" | "Dot" = "Cosine",
    enableSparse = false,
    quantizationScalar = false,
    turboQuant = false,
  ): Promise<void> {
```

Extend the `CollectionConfig.quantization_config` interface type to also allow
turbo:

```ts
      quantization_config?:
        | { scalar: { type: "int8"; always_ram: boolean } }
        | { turbo: { bits: "bits4"; always_ram: boolean } };
```

Replace the existing `if (quantizationScalar) { ... }` block with a precedence
ladder (turbo wins):

```ts
if (turboQuant) {
  config.quantization_config = { turbo: { bits: "bits4", always_ram: true } };
} else if (quantizationScalar) {
  config.quantization_config = { scalar: { type: "int8", always_ram: true } };
}
```

- [ ] **Step 3: Run the test → PASS, and confirm scalar tests still green.**

Run: `npx vitest run tests/core/adapters/qdrant/quantization.test.ts` Expected:
PASS (new turbo tests + all pre-existing scalar tests unchanged).

- [ ] **Step 4: Thread `turboQuant` through the 2 production callers.**

Read each caller's surrounding context to find the `QdrantTuneConfig` in scope:

- `src/core/api/internal/ops/collection-ops.ts:24` — pass the turbo flag as the
  6th arg from the config available to `CollectionOps` (read the class to find
  how it accesses qdrantTune; if it has no qdrantTune, leave the default — only
  the index path strictly needs it, but pass it if available).
- `src/core/domains/ingest/operations/indexing.ts:296` — this is the real index
  path; pass `this.<config>.qdrantTune.turboQuant` as the 6th arg (read the
  class to get the exact config field name).

If a caller has no access to `QdrantTuneConfig`, do NOT fabricate a wiring —
note it and rely on the startup reconcile (Task 3) to apply turbo to that
collection instead. Prefer wiring the index path (indexing.ts) since that
creates the real collections.

- [ ] **Step 5: Update the Mock signatures (additive, no behavior change).**

In `tests/core/domains/ingest/__helpers__/test-helpers.ts:91` and
`tests/integration/integration.test.ts:80`, add the optional 6th param to
`MockQdrantManager.createCollection` so its signature matches (it can ignore the
value — the mock stores collection meta):

```ts
  async createCollection(
    name: string,
    vectorSize: number,
    distance: "Cosine" | "Euclid" | "Dot" = "Cosine",
    enableHybrid?: boolean,
    _quantizationScalar?: boolean,
    _turboQuant?: boolean,
  ): Promise<void> {
```

- [ ] **Step 6: Full type-check + the affected suites.**

Run: `npx tsc --noEmit` → 0 errors (proves no positional caller broke). Run:
`npx vitest run tests/core/adapters/qdrant/ tests/core/domains/ingest/operations/indexing.test.ts`
→ PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/core/adapters/qdrant/client.ts src/core/api/internal/ops/collection-ops.ts src/core/domains/ingest/operations/indexing.ts tests/core/domains/ingest/__helpers__/test-helpers.ts tests/integration/integration.test.ts tests/core/adapters/qdrant/quantization.test.ts
git commit -m "feat(qdrant): emit TurboQuant bits4 quantization config on new collections

Additive optional turboQuant param on createCollection; turbo takes precedence
over scalar. Zero positional callers broken; index path passes the config flag.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `updateCollectionQuantization` + idempotent startup reconcile

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts` (new
  `updateCollectionQuantization`, near `updateCollectionSparseConfig` ~1165; and
  `getCollectionInfo` may need to expose current quantization — read it)
- Modify: `src/bootstrap/factory.ts` (`resolveInfrastructure` — startup
  reconcile, surgical)
- Test: `tests/core/adapters/qdrant/client.test.ts`
  (updateCollectionQuantization)
- Test: a new/extended factory or reconcile test (see Step 5)

**Interfaces:**

- Produces:
  `QdrantManager.updateCollectionQuantization(name: string): Promise<void>`
  (PATCH `update_collection` with
  `quantization_config: { turbo: { bits: "bits4", always_ram: true } }`).
- Reconcile: on startup, for each existing collection, if its live
  `quantization_config` is not turbo-bits4 → call
  `updateCollectionQuantization`; else no-op (idempotent).

- [ ] **Step 1: Write the failing method test.**

In `tests/core/adapters/qdrant/client.test.ts`, add (mirror the existing
`updateCollectionSparseConfig` test if present; use the same mocked client
handle):

```ts
it("updateCollectionQuantization PATCHes turbo config via update_collection", async () => {
  await manager.updateCollectionQuantization("col");
  expect(updateCollectionSpy).toHaveBeenCalledWith("col", {
    quantization_config: { turbo: { bits: "bits4", always_ram: true } },
  });
});
```

Run: `npx vitest run tests/core/adapters/qdrant/client.test.ts` → FAIL (method
missing).

- [ ] **Step 2: Implement the method (templated on
      `updateCollectionSparseConfig`).**

In `src/core/adapters/qdrant/client.ts`, right after
`updateCollectionSparseConfig` (~line 1171), add:

```ts
  /**
   * Enables TurboQuant 8x quantization on an existing collection. Qdrant's
   * optimizer rebuilds quantized vectors from the stored float vectors in the
   * background — no re-embedding / reindex. Idempotent at the call site (the
   * startup reconcile only calls this when the live config differs).
   */
  async updateCollectionQuantization(collectionName: string): Promise<void> {
    await this.call(async () =>
      this.client.updateCollection(collectionName, {
        quantization_config: { turbo: { bits: "bits4", always_ram: true } },
      }),
    );
  }
```

Run: `npx vitest run tests/core/adapters/qdrant/client.test.ts` → PASS.

- [ ] **Step 3: Determine how to read a collection's live quantization config.**

Read `getCollectionInfo` (`client.ts:322`) and the SDK `getCollection` response.
The live quantization lives at `result.config.quantization_config` (turbo branch
has `.turbo.bits`). Add a small helper `isTurboBits4(info)` (pure) that returns
true iff the collection already has `turbo.bits === "bits4"`. Place it in
`client.ts` (private/module-level) OR inline in the reconcile — keep it
testable.

- [ ] **Step 4: Write the failing reconcile test.**

Add a focused test (in `tests/core/adapters/qdrant/client.test.ts` or a new
`tests/bootstrap/turbo-reconcile.test.ts`) for the reconcile logic. Test BOTH
branches:

```ts
it("reconcile calls updateCollectionQuantization when collection lacks turbo", async () => {
  // mock getCollection → no quantization_config; spy updateCollection
  await reconcileTurbo(manager, ["col"]); // the function from Step 5
  expect(updateCollectionSpy).toHaveBeenCalledWith(
    "col",
    expect.objectContaining({
      quantization_config: { turbo: { bits: "bits4", always_ram: true } },
    }),
  );
});
it("reconcile is a no-op when collection already has turbo bits4", async () => {
  // mock getCollection → quantization_config.turbo.bits = "bits4"
  await reconcileTurbo(manager, ["col"]);
  expect(updateCollectionSpy).not.toHaveBeenCalled();
});
```

Run → FAIL.

- [ ] **Step 5: Implement the reconcile + wire it into startup.**

Implement `reconcileTurbo(manager, collectionNames)` (a small exported function
— put it where it can be unit-tested; e.g. a new
`src/bootstrap/config/turbo-reconcile.ts` to keep `factory.ts` thin, consistent
with the existing `embedded-tuning.ts` helper pattern). It lists collections (or
takes the list), reads each via `getCollectionInfo`/`getCollection`, and calls
`updateCollectionQuantization` only when `!isTurboBits4(info)`. Then call it
from `src/bootstrap/factory.ts#resolveInfrastructure` AFTER the QdrantManager is
constructed and only when `config.qdrantTune.turboQuant` is true. Keep the
factory edit to a single guarded call:

```ts
if (appConfig.qdrantTune.turboQuant) {
  await reconcileTurbo(qdrant); // reads collection list internally
}
```

(Read `resolveInfrastructure` to place this where `qdrant` exists and is
healthy; wrap in the existing error-handling style so a reconcile failure does
not crash startup — log + continue.) Run reconcile tests → PASS.

- [ ] **Step 6: tsc + targeted suites.** Run: `npx tsc --noEmit` → 0 errors.
      Run:
      `npx vitest run tests/core/adapters/qdrant/client.test.ts tests/bootstrap/`
      → PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/core/adapters/qdrant/client.ts src/bootstrap/factory.ts src/bootstrap/config/turbo-reconcile.ts tests/core/adapters/qdrant/client.test.ts tests/bootstrap/turbo-reconcile.test.ts
git commit -m "feat(qdrant): auto-reconcile existing collections to TurboQuant on startup

New updateCollectionQuantization PATCHes turbo config; idempotent startup
reconcile applies it only when the live config differs. No reindex.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Search-time rescore across all dense paths (recall-critical)

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts` — `query` (~633), `queryGroups`
  (~683), `search` (~558), `hybridSearch` (~985)
- Test: `tests/core/adapters/qdrant/client.test.ts`

**Interfaces:**

- Produces: every dense/quantized query carries
  `params: { quantization: { rescore: true, oversampling: 2.0 } }` so quantized
  candidates are re-scored on stored float vectors.

**Why all four:** `hybridSearch` is the primary dense+sparse path;
`query`/`queryGroups` serve find_similar; `search` is the dense fallback.
Quantization affects the dense leg in every one. Without rescore, recall drops
~2–3 pp.

- [ ] **Step 1: Read the four methods to find each query-body assembly.**

Read `client.ts` ranges 558-601 (`search`), 629-729 (`query`, `queryGroups`),
985-1057 (`hybridSearch`). Each builds a params/body object passed to
`this.client.query`/`search`. Identify the object that becomes the request body
(e.g. `queryParams` in `query`).

- [ ] **Step 2: Write failing tests asserting the rescore param on each path.**

Add to `tests/core/adapters/qdrant/client.test.ts` (use the existing mocked
client spies for `query`/`search`):

```ts
const RESCORE = { quantization: { rescore: true, oversampling: 2.0 } };
it("query injects quantization rescore params", async () => {
  await manager.query("col", { positive: ["id1"], limit: 5 });
  expect(querySpy.mock.calls.at(-1)[1]).toMatchObject({ params: RESCORE });
});
it("hybridSearch injects quantization rescore params on the dense prefetch/query", async () => {
  await manager.hybridSearch(/* existing test args */);
  // assert the dense query body carries params: RESCORE (adapt to hybridSearch's body shape)
  expect(/* dense query body */).toMatchObject({ params: RESCORE });
});
// + analogous tests for queryGroups and search
```

Run → FAIL.

- [ ] **Step 3: Inject the param into each request body.**

In each method, add to the request-body object (e.g. in `query`, on
`queryParams`):

```ts
queryParams.params = { quantization: { rescore: true, oversampling: 2.0 } };
```

For `hybridSearch`, add it to the dense leg of the prefetch/query body (NOT the
sparse leg — sparse is not quantized). For `search`/`queryGroups`, add to their
body objects analogously. Use a single shared module-level constant to avoid
duplication:

```ts
const QUANTIZATION_SEARCH_PARAMS = {
  quantization: { rescore: true, oversampling: 2.0 },
} as const;
```

Reference it in all four methods.

- [ ] **Step 4: Tests + tsc.** Run:
      `npx vitest run tests/core/adapters/qdrant/client.test.ts` → PASS (new +
      existing). Run: `npx tsc --noEmit` → 0 errors.

- [ ] **Step 5: Commit.**

```bash
git add src/core/adapters/qdrant/client.ts tests/core/adapters/qdrant/client.test.ts
git commit -m "feat(qdrant): rescore quantized vectors on all dense search paths

Inject params.quantization {rescore, oversampling 2.0} into query, queryGroups,
search and the dense leg of hybridSearch so TurboQuant keeps baseline recall.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Documentation (F1 env-doc policy)

**Files:**

- Modify: `website/docs/config/environment-variables.md`
- Modify: `.env.example`
- Modify: `website/docs/config/qdrant.md`

**Interfaces:** documents `QDRANT_TURBO_QUANT` (default `true`) per bump spec
Section F1.

- [ ] **Step 1: Add the env row to the central table.**

In `website/docs/config/environment-variables.md`, add a row (in the Qdrant area
or a new "Quantization" sub-table, matching the existing
`| Variable | Description | Default |` format):

```markdown
| `QDRANT_TURBO_QUANT` | Enable Qdrant 1.18 TurboQuant 8x dense quantization
(rescored at search time, ~baseline recall) | `true` |
```

- [ ] **Step 2: Add a commented entry to `.env.example`.**

Append (matching the file's comment style):

```bash
# Enable TurboQuant 8x dense quantization (default true; set false to disable)
# QDRANT_TURBO_QUANT=true
```

- [ ] **Step 3: Mention it in `website/docs/config/qdrant.md`.**

Add a short "Quantization" note: TurboQuant is on by default (8x compression,
search-time rescore keeps recall at baseline), disabled via
`QDRANT_TURBO_QUANT=false`. Existing collections are auto-reconciled at startup
(no reindex).

- [ ] **Step 4: Lint the markdown.**

Run markdownlint on the three files (or `npx markdownlint-cli2` if configured).
Fix any issues.

- [ ] **Step 5: Commit.**

```bash
git add website/docs/config/environment-variables.md .env.example website/docs/config/qdrant.md
git commit -m "docs(qdrant): document QDRANT_TURBO_QUANT env (default on)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Live recall validation (USER-GATED)

**This task does NOT run automatically** — build + `npm link` + reindex are
user-gated (3 active worktrees + shared index + ollama).

**Files:** none (validation only).

- [ ] **Step 1: (user-triggered) Build + link the worktree, reconnect MCP.**

```bash
cd .claude/worktrees/qdrant-1.18-migration && npm run build && npm link
```

- [ ] **Step 2: (user-triggered) Index a `tea-rags-worktree` alias and confirm
      turbo + recall.**

Via the `test-self-reindex` skill: index the worktree, confirm new collections
carry turbo quantization (inspect collection config), run a set of
`semantic_search` / `hybrid_search` queries, and compare a recall proxy (e.g.
`resolveSuccessRate` or top-k overlap) against the pre-turbo baseline. Expected:
near-zero final-ranking change (rescore + hybrid + reranker compensate).

- [ ] **Step 3: Record the result in the merge decision.**

If recall holds → turbo plan is merge-ready. If a measurable recall drop appears
→ check rescore is actually wired on the path used (Task 4) before merging.

---

## Self-Review

- **Spec coverage:** A (env) → Task 1. B (createCollection) → Task 2 (additive
  param, impact-driven). C (reconcile) → Task 3. D (rescore) → Task 4 (extended
  to all dense paths). E (tests) → folded into each Task (TDD). F (docs) →
  Task 5. Recall validation → Task 6 (user-gated).
- **Placeholder scan:** the only deferred lookups are read-then-mirror steps for
  the project's existing `QDRANT_TUNE_*` Zod/parse style and the test files'
  existing mock-spy handles — operational reads, not content placeholders; all
  NEW code (turbo config, updateCollectionQuantization, rescore const,
  reconcile) is shown verbatim.
- **Type consistency:** `turboQuant: boolean` (config) ↔ 6th param
  `turboQuant = false` (createCollection) ↔ `QDRANT_TURBO_QUANT` env.
  `quantization_config: { turbo: { bits: "bits4", always_ram: true } }`
  identical across createCollection, updateCollectionQuantization, and the
  reconcile assertion.
  `params: { quantization: { rescore: true, oversampling: 2.0 } }` identical
  across all four search methods (one shared constant).

## Execution Handoff

Plan 2 of 3. Execute via **dinopowers:executing-plans** (subagent-driven). Tasks
1–5 are auto; Task 6 is user-gated.
