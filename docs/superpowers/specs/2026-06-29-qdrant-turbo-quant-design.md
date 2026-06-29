# Qdrant 1.18 TurboQuant Integration — Design

**Date:** 2026-06-29 **Status:** approved **Epic:** `tea-rags-mcp-62zf` (Migrate
to Qdrant 1.18) **Type:** `feat` — default ON **Depends on:**
`2026-06-29-qdrant-1.18-bump-design.md` (TurboQuant does not exist before 1.18)

Adopt Qdrant 1.18 TurboQuant quantization: 8x dense-vector compression with
near-baseline recall, enabled by default, applied to both new and existing
collections without a tea-rags reindex.

---

## 1. Recall analysis (why default ON is safe)

`bits4` = 8x compression. Qdrant benchmark recall@10 across 10 datasets:

|                             | Recall    |
| --------------------------- | --------- |
| float32 baseline            | 0.94–0.99 |
| TurboQuant `bits4` (8x)     | 0.90–0.94 |
| Raw gap **without rescore** | ~2–3 pp   |

The ~2–3 pp gap is **eliminated** by search-time rescoring: Qdrant stores the
original float vectors alongside the quantized ones, and with `rescore: true` +
`oversampling: 2.0` it re-evaluates the top candidates on full vectors. On top
of that, tea-rags compensates twice more:

1. **Hybrid RRF** — the sparse leg is **not** quantized, so it recovers dense
   misses.
2. **Reranker** — derived-signal reranking runs over the top-N; final ordering
   is not raw cosine.

Net effect on final ranked output: near-zero — **provided rescore is wired**
(Section D). Without it the loss is the honest 2–3 pp.

## 2. Decisions of record

| Item                 | Value                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Default              | **ON** (`QDRANT_TURBO_QUANT=true`)                                                           |
| Bit depth            | `bits4` (8x) with `always_ram: true`                                                         |
| Search params        | `rescore: true`, `oversampling: 2.0` (mandatory pairing)                                     |
| Existing collections | **Auto-reconcile on startup** via `update_collection` (no reindex)                           |
| Replaces             | the unfinished scalar-quant flag (`quantizationScalar`, beads `x99f`) becomes the turbo mode |

---

## 3. Changes by area — _what it gives / what changes_

### A. Config / env

**What it gives:** a single env switch, default-on, threaded through the
existing config-parse machinery.

**What changes:**

1. `src/core/contracts/types/config.ts` — add `turboQuant: boolean` to
   `QdrantTuneConfig`.
2. `src/bootstrap/config/schemas.ts` — Zod field for `QDRANT_TURBO_QUANT`
   (default `true`, boolean coercion).
3. `src/bootstrap/config/parse.ts#buildEnvInputs` — read the env var into the
   config object.

### B. New-collection creation

**What it gives:** new indexes get 8x compression at creation time.

**What changes:**

1. `src/core/adapters/qdrant/client.ts` `QdrantManager.createCollection`
   (currently 5 positional params ending in `quantizationScalar = false`) —
   migrate the signature to an **options object** carrying the quantization
   mode, and emit
   `quantization_config: { turbo: { bits: "bits4", always_ram: true } }` when
   turbo is enabled. The `MockQdrantManager` in test helpers mirrors the new
   signature.
2. `src/bootstrap/factory.ts` — the `createCollection` caller passes the turbo
   mode from `QdrantTuneConfig`.

### C. Auto-reconcile existing collections

**What it gives:** already-indexed collections (created without quantization)
pick up turbo **without a reindex** — Qdrant's background optimizer rebuilds the
quantized representation from the stored float vectors; the originals remain.

**What changes:**

1. `src/core/adapters/qdrant/client.ts` — new
   `QdrantManager.updateCollectionQuantization(name)`: PATCH `update_collection`
   with `quantization_config`, omitting the vector config. Written to the
   **existing pattern** of `updateCollectionSparseConfig` (`client.ts:1161`) —
   this de-risks the new method.
2. `src/bootstrap/factory.ts#resolveInfrastructure` — startup reconcile:
   `getCollectionInfo` → if the live `quantization_config` differs from the
   desired turbo config, call `updateCollectionQuantization`. **Idempotent** — a
   no-op when already matching, so repeated starts don't re-trigger the
   optimizer.

> **Cost note:** the first start after upgrade triggers a background optimizer
> pass over all points of each existing collection. This is Qdrant-internal (not
> a tea-rags reindex) and runs without blocking search, but on very large
> indexes it consumes CPU/IO for a while. The startup reconcile (Section C) must
> therefore be strictly idempotent.

### D. Search-time rescore — CRITICAL

**What it gives:** the recall recovery from Section 1. **Without this the bump
silently costs 2–3 pp recall.**

**What changes:**

1. `src/core/adapters/qdrant/client.ts` `QdrantManager.query` (`client.ts:629`)
   and `queryGroups` (`client.ts:683`) — inject
   `params: { quantization: { rescore: true, oversampling: 2.0 } }` whenever
   quantization is active on the collection.

### E. Tests (TDD)

**What it gives:** locks the recall-critical wiring.

**What changes:**

1. New/updated tests: createCollection emits the turbo config;
   `updateCollectionQuantization` issues the correct PATCH; startup reconcile is
   idempotent and only fires on mismatch; `query`/`queryGroups` inject rescore
   params; env parsing of `QDRANT_TURBO_QUANT` (default true + explicit false).

### F. Docs

**What it gives:** discoverability of the new default + the off-switch.

**What changes:** per the env-var documentation policy in the bump spec
(`2026-06-29-qdrant-1.18-bump-design.md`, Section F1), document
`QDRANT_TURBO_QUANT` (default `true`) in:

1. `website/docs/config/environment-variables.md` — central table (new
   "Quantization" sub-section or under Qdrant).
2. `.env.example` — commented entry with default.
3. `website/docs/config/qdrant.md` — quantization section.
4. `CHANGELOG.md` — feature entry. Release-notes `envChanges[]` (bump F2) picks
   up `QDRANT_TURBO_QUANT` automatically as a `new` env.

---

## 4. Reindex / schema-drift

- **No tea-rags reindex** (no re-chunk / re-embed / re-enrich): quantized
  vectors are built by Qdrant from the stored float vectors.
- **No schema-drift trigger**: quantization is a vector-storage config, not a
  payload-field change; the `schema-drift` guard (payload-version tracking) is
  unaffected.
- Existing collections: covered by auto-reconcile (Section C). A `force-reindex`
  also applies turbo naturally (it recreates the collection).

---

## 5. Open items for the plan

- Exact options-object shape for `createCollection` (which existing callers must
  be updated; keep the mock in lockstep).
- Whether `oversampling` should be configurable (`2.0` is the documented
  default; YAGNI unless a reason surfaces during validation).
- Live validation: measure `resolveSuccessRate` / a recall proxy before/after on
  a `tea-rags-worktree` alias to confirm near-zero final-ranking impact.
