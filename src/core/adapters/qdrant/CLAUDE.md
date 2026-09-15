# adapters/qdrant — the model-mixing guard, its weight canary, and the marker-catch rethrow

## Invariants

- **`readOrCreateMarker`'s catch DISABLES the guard, and its
  `EmbeddingModelMismatchError` rethrow is the only way out of it.** Every error
  raised inside that try block is converted into "guard disabled for this
  collection": the catch returns `undefined`, `decideVerdict` caches
  `model: null` (its `marker === undefined` arm), and the collection asserts
  nothing from then on. The sole exemption is the uncommented first line of the
  catch, `if (error instanceof EmbeddingModelMismatchError) throw error;`
  (`EmbeddingModelGuard#readOrCreateMarker`), and nothing exercises it — every
  mismatch case in `tests/core/adapters/qdrant/embedding-model-guard.test.ts` is
  decided in `decideVerdict`, after the marker read has already returned. Why: a
  throw that a later edit adds anywhere inside that try — a stricter marker
  parse, a new consistency check — is swallowed by the same catch, and the
  collection drops out of the guard with the suite still green. A new failure
  that must reach the caller needs its own arm beside that rethrow, or it
  belongs outside the try.

- **`invalidateAll()` reaches the guard through a slot in the composition root,
  and the slot is not incidental.** `resolveInfrastructure`
  (`bootstrap/factory.ts`) declares `modelGuardSlot`, then arms
  `OllamaEmbeddings.onFallbackSwitch` to call
  `modelGuardSlot.current?.invalidateAll()`; only after that is the guard
  constructed (`new EmbeddingModelGuard(…)`) and dropped into the slot
  (`modelGuardSlot.current = modelGuard`). The handler must be armed first
  because `resolveEmbeddingModelParameters` already talks to the provider and
  can trigger a failover before the guard is constructed — a handler closing
  over `modelGuard` directly would reference it inside its temporal dead zone.
  An edit must keep the handler reading `modelGuardSlot.current` at fire time
  and never capture the guard.

- **`recordModel` writes the cache; the marker point is created by the indexing
  lease.** `CollectionOps#create` calls `recordModel` immediately after
  `createCollection`, and the marker is first written by
  `storeIndexingMarker(…, complete=false, …)` in
  `IndexPipeline#setupCollection`, which publishes the lease as soon as the
  collection exists. `IndexPipeline#indexCodebase` and
  `ReindexPipeline#closeRun` (reached from three sites) all pass `complete=true`
  — they UPDATE that marker, they never create it. The two creation paths are
  DISJOINT: `create_collection` (`createApp` → `CollectionOps#create`) is
  `recordModel`'s only caller, while an index run creates its collection and the
  lease directly (`IndexPipeline#setupCollection`) and never touches the guard —
  that collection's verdict is first cached on its first `ensureMatch`, not at
  creation. Reading either path off the completing calls puts the creation in
  the wrong place entirely.

- **A cache reset is the only thing that can forget weight drift.** The name
  verdict is re-derived on every assert; the canary verdict survives only as the
  stored reason string, so `invalidate` / `invalidateAll` discard the sole
  record of it and the next `ensureMatch` pays a fresh embed to find it again.
  The reasoning is the `EmbeddingModelVerdict` docblock in
  `embedding-model-guard.ts`.

- **One check per collection, and a verdict never lands behind the invalidation
  meant to clear it.** `EmbeddingModelGuard#startCheck` carries both halves —
  registration before the first await, identity compare on each settle path.
  Read its docblock before touching either.

- **The create path withholds a clean verdict when the canary embed failed; the
  read path caches through it.** `cacheable` (the `createdNow` return and the
  read-path return of `EmbeddingModelGuard#decideVerdict`) is what expresses the
  asymmetry; the reasoning is the `EmbeddingModelGuard#embedCanary` docblock.

- **Two marker-shape rules to know before editing `readOrCreateMarker`:** the
  canary is folded into the payload of the create upsert rather than written by
  a `setPayload` behind it (the `payload` literal in
  `EmbeddingModelGuard#readOrCreateMarker`, reasoning in the comment above it),
  and the created marker's zero vector is sized from the collection rather than
  from `this.dimensions` (`zeroVector` from `collectionInfo.vectorSize`,
  reasoning in the comment above it).

## Mechanics

- **`EMBEDDING_CANARY_MIN_COSINE = 0.999` is PROVISIONAL, not a design
  decision.** Its docblock in `contracts/constants.ts` states that the
  cross-endpoint agreement it assumes has not been measured, that the
  measurement is the user-gated C4 step (bd `tea-rags-mcp-ie819`), and that a
  lower measured value is to be recorded there with the constant lowered to it
  minus 0.001. Do not treat 0.999 as design until ie819 measures it, and do not
  derive a second threshold from it meanwhile. The comparison itself is
  `similarity < EMBEDDING_CANARY_MIN_COSINE`
  (`EmbeddingModelGuard#compareCanary`) — strictly below.

- **`EMBEDDING_CANARY_TEXT` is frozen, and its docblock in
  `contracts/constants.ts` says why.** The marker point id is
  `INDEXING_METADATA_ID` (`contracts/constants.ts`).

- **The guard's answer to a width difference is `0`, not NaN.**
  `EmbeddingModelGuard#compareCanary` compares the two lengths before calling
  `cosine` and scores a mismatch as zero, which then fails the threshold. That
  `cosine` leaves the length question to its callers at all is the `cosine`
  docblock in `infra/vector-math.ts` — the contract lives there, and the guard
  is one of the two callers it names.

- **Entry points and what each costs.** `ensureMatch` — four call sites:
  `ExploreOps#searchCode`, `ExploreOps#resolveAndGuard`, `DocumentOps#add`,
  `IndexingOps#tryIncrementalIndex`, cache-served after the first.
  `invalidate(collectionName)` — one caller, `IndexingOps#clear` (clear index).
  `invalidateAll()` — the failover hook only. Everything else is served from
  `this.cache`, so the steady-state cost is one Qdrant read plus one canary
  embed per collection per process.

- **Exact matching on the `text`-indexed payload keys goes through
  `filters/text-indexed-exact.ts`** (lands in D1). `relativePath`, `symbolId`
  and `parentSymbolId` each carry a `text` index (`TEXT_INDEXED_KEYS`, looped in
  `SchemaManager#initializeSchema`) and nothing else: Qdrant keeps one index per
  key, so the `keyword` index schema v4 once put on `relativePath` was replaced
  by the v5 text index, and new collections never get it
  (`SchemaManager#initializeSchema`, bd tea-rags-mcp-ivp12).

## Gotchas

- **The canary throw puts a description where the error expects a model name.**
  `assertVerdict` passes `verdict.canaryMismatch` —
  `"<model> (same name, different weights: canary cosine 0.9412)"` — as the
  `actual` argument, where the name path passes `this.currentModel`. It also
  passes `CANARY_MISMATCH_HINT` (`embedding-model-guard.ts`); why the default
  hint cannot serve this path is the `EmbeddingModelMismatchError` docblock
  (`adapters/embeddings/errors.ts`).

- **The disable log is deliberately ungated while the backfill and create
  notices are `isDebug()`-gated** (the `Model-mixing guard disabled` line in the
  catch of `EmbeddingModelGuard#readOrCreateMarker` vs the `Backfilled` lines in
  `#writeCanary` and `#readOrCreateMarker` and its `Created marker` line); the
  reasoning is the comment in that catch. Quieting that line hides the moment a
  collection stopped being guarded.

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
