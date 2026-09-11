# adapters/qdrant — the model-mixing guard, its weight canary, and the shared cosine

## Invariants

- **`readOrCreateMarker`'s catch DISABLES the guard, and `:326` is the only way
  out of it.** Every error raised inside that try block is converted into "guard
  disabled for this collection": the catch returns `undefined`, `decideVerdict`
  caches `model: null` (:160), and the collection asserts nothing from then on.
  The sole exemption is the uncommented first line of the catch,
  `if (error instanceof EmbeddingModelMismatchError) throw error;` (:326), and
  nothing exercises it — every mismatch case in
  `tests/core/adapters/qdrant/embedding-model-guard.test.ts` is decided in
  `decideVerdict`, after the marker read has already returned. Why: a throw that
  a later edit adds anywhere inside that try — a stricter marker parse, a new
  consistency check — is swallowed by the same catch, and the collection drops
  out of the guard with the suite still green. A new failure that must reach the
  caller needs its own arm on `:326`, or it belongs outside the try.

- **`invalidateAll()` reaches the guard through a slot in the composition root,
  and the slot is not incidental.** `bootstrap/factory.ts:195` declares
  `modelGuardSlot`; `:199-211` arms `OllamaEmbeddings.onFallbackSwitch` to call
  `modelGuardSlot.current?.invalidateAll()` (:210); the guard is constructed at
  `:243` and dropped into the slot at `:244`. The handler must be armed first
  because `resolveEmbeddingModelParameters` (:222) already talks to the provider
  and can trigger a failover before `:243` runs — a handler closing over
  `modelGuard` directly would reference it inside its temporal dead zone. An
  edit must keep the handler reading `modelGuardSlot.current` at fire time and
  never capture the guard.

- **`recordModel` writes the cache; the marker point is created by the indexing
  lease.** `api/internal/ops/collection-ops.ts:39` calls `recordModel`
  immediately after `createCollection`, and the marker is first written by
  `storeIndexingMarker(…, complete=false, …)` at
  `domains/ingest/operations/indexing.ts:352`, which publishes the lease as soon
  as the collection exists. `indexing.ts:194` and
  `domains/ingest/operations/reindexing.ts:185,207,617` all pass `complete=true`
  — they UPDATE that marker, they never create it. The window `recordModel`
  covers is therefore between `createCollection` and the lease write; reading it
  off the completing calls puts the window in the wrong place entirely.

- **A cache reset is the only thing that can forget weight drift.** The name
  verdict is re-derived on every assert; the canary verdict survives only as the
  stored reason string, so `invalidate` / `invalidateAll` discard the sole
  record of it and the next `ensureMatch` pays a fresh embed to find it again.
  The reasoning is `embedding-model-guard.ts:42-47`.

- **One check per collection, and a verdict never lands behind the invalidation
  meant to clear it.** `startCheck` (:132-152) carries both halves —
  registration before the first await, identity compare on each settle path.
  Read the docblock at `:124-131` before touching either.

- **The create path withholds a clean verdict when the canary embed failed; the
  read path caches through it.** `cacheable` (:169-174, :176-182) is what
  expresses the asymmetry; the reasoning is `:227-235`.

- **Two marker-shape rules to know before editing `readOrCreateMarker`:** the
  canary is folded into the payload of the create upsert rather than written by
  a `setPayload` behind it (:294-300, reasoning at :291-293), and the created
  marker's zero vector is sized from the collection rather than from
  `this.dimensions` (:288-289, reasoning at :284-287).

## Mechanics

- **`EMBEDDING_CANARY_MIN_COSINE = 0.999` is PROVISIONAL, not a design
  decision.** `contracts/constants.ts:26-35` states that the cross-endpoint
  agreement it assumes has not been measured, that the measurement is the
  user-gated C4 step (bd `tea-rags-mcp-ie819`), and that a lower measured value
  is to be recorded there with the constant lowered to it minus 0.001. Do not
  treat 0.999 as design until ie819 measures it, and do not derive a second
  threshold from it meanwhile. The comparison itself is
  `similarity < EMBEDDING_CANARY_MIN_COSINE` (`embedding-model-guard.ts:221`) —
  strictly below.

- **`EMBEDDING_CANARY_TEXT` is frozen, and `contracts/constants.ts:19-22` says
  why.** The marker point id is `INDEXING_METADATA_ID` (`constants.ts:11`).

- **The guard's answer to a width difference is `0`, not NaN.**
  `embedding-model-guard.ts:220` compares the two lengths before calling
  `cosine` and scores a mismatch as zero, which then fails the threshold. That
  `cosine` leaves the length question to its callers at all is
  `infra/vector-math.ts:13-17` — the contract lives there, and the guard is one
  of the two callers it names.

- **Entry points and what each costs.** `ensureMatch` — four call sites:
  `api/internal/ops/explore-ops.ts:183,375`, `document-ops.ts:29`,
  `indexing-ops.ts:438`, cache-served after the first.
  `invalidate(collectionName)` — one caller, `indexing-ops.ts:312` (clear
  index). `invalidateAll()` — the failover hook only. Everything else is served
  from `this.cache`, so the steady-state cost is one Qdrant read plus one canary
  embed per collection per process.

- **Exact matching on the `text`-indexed payload keys goes through
  `filters/text-indexed-exact.ts`** (lands in D1). `relativePath`, `symbolId`
  and `parentSymbolId` each carry a `text` index (`schema-manager.ts:182`,
  `:191`, `:196`); `relativePath` carries a `keyword` index as well (`:178`).

## Gotchas

- **The canary throw puts a description where the error expects a model name.**
  `assertVerdict` passes `verdict.canaryMismatch` —
  `"<model> (same name, different weights: canary cosine 0.9412)"` — as the
  `actual` argument, where the name path passes `this.currentModel` (:190-196).
  It also passes `CANARY_MISMATCH_HINT` (:70-73); why the default hint cannot
  serve this path is `adapters/embeddings/errors.ts:17-21`.

- **The disable log is deliberately ungated while the backfill and create
  notices are `isDebug()`-gated** (`:331` vs `:251-253`, `:278-280`,
  `:321-323`); the reasoning is `:327-330`. Quieting that line hides the moment
  a collection stopped being guarded.

## See also

- `.claude/rules/index-drift.md` — the compare-here / side-effect-elsewhere
  boundary. This guard is the named "throws on mismatch" case, so a comparison
  that only needs to be REPORTED belongs in `maintenance/drift/`, not here.
- `website/docs/operations/drift-detection.md`, `## Embedding model` — the
  user-facing half: both error messages as they render, the remedies offered,
  and what a collection indexed before the canary existed does on first contact.
- `.claude/rules/qdrant-required-version.md` — `required-version.ts` and
  `embedded/`.
- `.claude/rules/migrations.md` — `schema-manager.ts`, `sparse.ts`, `types.ts`.
- `.claude/rules/domain-boundaries.md` — records this guard's move OUT of
  `infra/`, under its rule that a module whose reason to change is a PRODUCT
  decision does not belong in the foundation; also where tests for this
  directory go.
