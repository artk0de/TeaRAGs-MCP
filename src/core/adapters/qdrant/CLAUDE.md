# adapters/qdrant — the model-mixing guard, its weight canary, and the shared cosine

## Invariants

- **Name first, canary second — a wrong `EMBEDDING_MODEL` costs no provider
  round-trip.** `decideVerdict` returns on the name mismatch
  (embedding-model-guard.ts:162-165) before `compareCanary` can be reached. The
  ordering is not a micro-optimisation: `ensureMatch` sits on every read and
  write path (`api/internal/ops/explore-ops.ts:183,375`, `document-ops.ts:29`,
  `indexing-ops.ts:438`), and the canary leg is a live provider embed
  (:236-245). Putting the embed ahead of the string compare charges a
  misconfigured model a round-trip per collection to learn what its name already
  said.

- **A canary mismatch is sticky because it cannot be re-derived.**
  `assertVerdict` (:186-197) rebuilds the NAME throw from `verdict.model`, but
  the canary verdict survives only as the prose reason string on
  `EmbeddingModelVerdict.canaryMismatch` (:48-52) — re-deriving it would mean
  re-embedding on every call. What an edit must hold: anything that drops a
  cache entry drops the only record of weight drift, and the next `ensureMatch`
  pays a fresh embed to rediscover it.

- **The in-flight check is registered before the first await and installed only
  under an identity compare.** `startCheck` (:132-152) builds `settled`, then
  publishes it into `pending` (:150), so callers arriving in the same tick join
  it instead of starting their own; both settle paths then compare
  `this.pending.get(collectionName) === settled` (:136, :144) and decline to
  write when it no longer matches. `invalidate` / `invalidateAll` (:357-373)
  delete the registration, which is precisely what makes that compare fail, and
  `ensureMatch` reads the resulting `undefined` as "this measurement no longer
  applies" and asserts nothing (:118-121). Why it matters: without the identity
  compare, a check that began before an endpoint failover installs its verdict
  behind the invalidation meant to clear exactly that measurement — and since a
  canary verdict is sticky, that verdict then 409s every search for the rest of
  the process.

- **The create path withholds a clean verdict when the canary embed failed; the
  read path does not.** `cacheable` is false in exactly one case — this call
  created the marker, a provider exists, and no canary came back (:169-174). On
  the read path `compareCanary` returns `null` for a failed embed (:208-209) and
  the outcome is still cached (:176-182), as are the two outcomes that assert
  nothing: an unreachable marker caches `model: null` (:160) and a name mismatch
  caches its verdict (:164). The asymmetry is the point — a collection whose
  marker was just created still owes a canary, so the next check has to retry
  and backfill it, whereas an existing collection is already reported once and
  re-embedding it per search would be the round-trip the cache exists to avoid.

- **The canary is folded into the marker payload being created, never a
  `setPayload` behind it.** `readOrCreateMarker` merges
  `...(canary && { canary })` into the one upsert (:294-300). `setPayload`
  appears only on the backfill paths, which target a marker that already exists
  (`writeCanary` :248-259, the `embeddingModel` backfill :271-276). Splitting
  the create into two writes leaves a window in which the marker names a model
  and claims no canary, which is indistinguishable from a legacy collection.

- **The created marker's zero vector is sized from the collection, not from
  `this.dimensions`.** `collectionInfo.vectorSize || this.dimensions` (:288-289)
  — the constructor value is the model registry's guess frozen at bootstrap, and
  a wrong guess makes this very upsert fail, which routes into the catch and
  disables the guard for that collection (:325-335). `this.dimensions` is the
  fallback for a collection that reports no width, not the authority.

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

- **`recordModel` writes the cache only; the marker point is written by someone
  else.** `api/internal/ops/collection-ops.ts:39` calls it immediately after
  `createCollection`, while the marker itself is written later by
  `storeIndexingMarker` (`domains/ingest/pipeline/indexing-marker.ts:23`, called
  from `domains/ingest/operations/indexing.ts:194` and
  `domains/ingest/operations/reindexing.ts:185,207,617`). It also drops any
  in-flight check (:348): this is first-hand knowledge of the model that created
  the collection, and a check started earlier must not land on top of it.

## Mechanics

- **Constants.** `EMBEDDING_CANARY_TEXT` and
  `EMBEDDING_CANARY_MIN_COSINE = 0.999` are `contracts/constants.ts:24,36`; the
  marker point id `INDEXING_METADATA_ID` is `:11`. The comparison is
  `similarity < EMBEDDING_CANARY_MIN_COSINE` (:221) — strictly below fails — so
  0.999 is a same-build threshold, not a same-meaning one.

- **`cosine` is shared, and the length question is deliberately left outside
  it.** `infra/vector-math.ts:19-30` loops over `a` and reads `b` at the same
  indices, so ragged input is NaN by construction. Its two callers answer the
  length question differently and both answers are load-bearing:
  `infra/score-background.ts:39` filters its sample down to one arity, while the
  guard scores a width difference as `0` before calling at all (:220).
  Generalising `cosine` to tolerate ragged input takes that decision away from
  both callers at once. `.claude/rules/domain-boundaries.md` carries the
  two-consumer criterion that keeps this helper in `infra/` and the guard here.

- **Entry points and what each costs.** `ensureMatch` — the four call sites
  above, cache-served after the first. `invalidate(collectionName)` — one
  caller, `indexing-ops.ts:312` (clear index). `invalidateAll()` — the failover
  hook only. Everything else is served from `this.cache`, so the steady-state
  cost is one Qdrant read plus one canary embed per collection per process.

- **Exact matching on the `text`-indexed payload keys is not this directory's
  root concern.** `relativePath` and `symbolId` both carry a `text` index
  (schema-manager.ts:182,191; `relativePath` additionally carries a `keyword`
  one, :178). The rule that follows from that lives with
  `filters/text-indexed-exact.ts` — go there, and do not re-derive it at a call
  site.

## Gotchas

- **`NaN < 0.999` is false, so an unguarded width mismatch would PASS.** The
  `stored.vector.length === fresh.vector.length` test at :220 is the check, not
  defensive tidiness around it. Delete it and a changed vector width — a model
  change by itself — scores NaN, compares false against the threshold, and
  yields a clean verdict that then gets cached.

- **Editing `EMBEDDING_CANARY_TEXT` silently re-baselines every collection.**
  `compareCanary` treats `stored?.text !== EMBEDDING_CANARY_TEXT` as "this
  vector says nothing about the current canary" and overwrites it (:213-216) —
  the same branch that backfills legacy markers. So a text edit raises nothing,
  fails nothing, and discards every stored baseline; drift that existed before
  the edit becomes unobservable. Treat the text as frozen.

- **The canary throw reuses the error's `actual` slot to carry a description.**
  `assertVerdict` passes `verdict.canaryMismatch` —
  `"<model> (same name, different weights: canary cosine 0.9412)"` — where the
  name path passes `this.currentModel` (:190-196 against
  `adapters/embeddings/errors.ts:24-27`). It must also pass
  `CANARY_MISMATCH_HINT` (:70-73): the default hint's first suggestion is to
  point `EMBEDDING_MODEL` back at the stored name, which on this path is already
  the configured one.

- **Marker failures log unconditionally while the successes are debug-gated, and
  that inversion is deliberate.** The catch in `readOrCreateMarker` logs at
  `console.error` with no `isDebug()` guard (:331); the backfill and create
  notices are all behind `isDebug()` (:251-253, :278-280, :321-323). From the
  moment that line prints, the collection accepts vectors from any model — a
  debug-gated line would leave that invisible on the default path.

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
- `.claude/rules/domain-boundaries.md` — why the guard lives in this adapter
  rather than in `infra/`, and where tests for this directory go.
