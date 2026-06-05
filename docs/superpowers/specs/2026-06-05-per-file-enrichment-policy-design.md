# Per-File Enrichment Policy — Design

**Date:** 2026-06-05
**Status:** Approved (brainstorm), pending implementation plan
**Related:** kc93 (run-scoped cat-file reader), `.claude/rules/git-cat-file-batch.md`, codegraph `exclusion.ts`

## Problem

Git enrichment (file `git blame` + per-chunk churn walk) runs on **every**
indexed file regardless of whether git signals are meaningful or affordable for
that file:

- **Generated files** (`db/schema.rb`, `*.pb.go`, `*_pb2.py`, vendored code)
  produce **actively misleading** git signals: churn is regeneration noise, the
  "owner" is whoever last ran the generator, bugFixRate is meaningless. They are
  also frequently **huge** (`schema.rb` 10k+ lines) — the single most expensive
  `git blame` targets.
- **Documentation** (`.md`) is indexed **deliberately** (there is a
  `documentationRelevance` preset). File-level ownership ("who wrote this doc")
  is useful, but the per-chunk churn walk over prose is low value and pays the
  full cat-file blob-read cost.

Per the kc93 diagnosis, the two dominant costs of git enrichment are (1) `git
blame` on large files and (2) cat-file blob reads in the chunk-churn walk. Both
are spent in full on generated/doc files today.

### Source-of-truth fragmentation

The notion of "what kind of file is this" is already **fragmented across four
disconnected places**:

| Concept            | Where it lives today                                            |
| ------------------ | --------------------------------------------------------------- |
| generated files    | `codegraph/exclusion.ts` → `CODEGRAPH_GENERATED_PATTERNS` (`db/schema.rb`, `vendor/**`) |
| test files         | `codegraph/exclusion.ts` → `CODEGRAPH_TEST_PATTERNS`            |
| documentation      | `chunker/config.ts` → `LANGUAGE_DEFINITIONS[*].isDocumentation` / `CODE_LANGUAGES` |
| build/junk ignore  | `ingest/pipeline/ignore-defaults.ts` → `BUILTIN_IGNORE_PATTERNS` |

Only **codegraph** knows about generated files; git enrichment has no idea
`db/schema.rb` is generated. Adding a fifth, git-specific list would deepen the
fragmentation. The design must consolidate, not add.

## Decisions (locked during brainstorm)

1. **Skip semantics — a new axis orthogonal to `ignoreFilter`.** "Skip" means
   the file stays **indexed and searchable** (embedded, returned by search) but
   the expensive git enrichment is skipped for it. This is NOT the existing
   `ignoreFilter` (which removes a file from indexing/discovery entirely — `.md`
   docs are indexed on purpose and must stay searchable).
2. **Classification mechanism — layered:** `isDocumentation` (from language) +
   pattern config (generated/test globs) + content-marker scan
   (`Code generated … DO NOT EDIT`, `@generated`).
3. **Architecture — facts in foundation, policy in the domain.** A single
   classifier owns the FACTS; each enrichment provider owns its own POLICY. This
   resolves the apparent contradiction "single source of truth" vs "split across
   domains": the *fact* is centralized, the *policy* is per-domain.
4. **Skip depth — per category.** `shouldEnrich` returns a scope, not a boolean:
   - generated → `"none"` (skip BOTH file blame AND chunk churn — signals are
     harmful, files are huge)
   - documentation → `"file-only"` (keep cheap file-level ownership/ageDays,
     skip the expensive chunk-churn walk)
   - normal source → `"full"`
5. **codegraph adopts the same contract.** codegraph implements `shouldEnrich`
   too and migrates its `discoverSupportedFiles` exclusion to consult the shared
   classifier. Its policy DIFFERS from git's (generated → none, **test → none**
   — tests skew the fan-graph; docs irrelevant), which is exactly why the policy
   belongs to the provider, not to a shared flag.

## Architecture

### 1. The fact: `FileClassification` (single source of truth)

`classify()` is the one place that answers "what kind of file is this".

```ts
// shape (canonical type lives in contracts/types/file-classification.ts)
interface FileClassification {
  isSource: boolean;        // ordinary editable code
  isGenerated: boolean;     // schema.rb, *.pb.go, @generated marker, vendored
  isDocumentation: boolean; // markdown etc. (from language)
  isTest: boolean;          // *_spec.rb, *.test.ts, test dirs
}

// implementation + pattern data: infra/file-classification/
classify(relPath: string, opts?: {
  contentHead?: string;     // first ~5 lines, for content-marker detection
  isDocumentation?: boolean; // passed in from the already-detected language
}): FileClassification
```

**Consolidation moves (kill the duplication):**

- `CODEGRAPH_GENERATED_PATTERNS` and `CODEGRAPH_TEST_PATTERNS` **move** from
  `trajectory/codegraph/exclusion.ts` into `infra/file-classification/` as
  `GENERATED_PATTERNS` / `TEST_PATTERNS`. `codegraph/exclusion.ts` imports them
  from infra — the duplicate definitions are deleted, one source remains.
- `GENERATED_PATTERNS` is **extended** beyond the current two entries:
  `**/db/schema.rb`, `**/vendor/**`, `*.pb.go`, `*_pb2.py`, `*.generated.*`,
  `*.g.dart`, `**/migrations/**` (candidate — confirm in plan), plus
  content-marker detection.
- `isDocumentation` stays authoritatively in `LANGUAGE_DEFINITIONS`
  (chunker/config.ts) — it is already the single source for that fact. The
  classifier receives it as an input (`opts.isDocumentation`) rather than
  re-deriving it, so there is no second source.

#### Domain-boundary note (important for the implementer)

`core/infra/` imports **nothing** from `core/` — and the strict dependency
model applies that ban to `import type` as well (no `allowTypeImports`). So
`infra/file-classification/` **cannot** import `FileClassification` from
`contracts/`. Resolve this exactly like the existing
`ChunkSignalOptions.blobReader` ↔ `CatFileBatchReader` structural pairing:

- The **canonical** `FileClassification` type is declared in
  `contracts/types/file-classification.ts` (pure type, consumed by the
  `EnrichmentProvider` contract and by trajectory providers).
- `infra/file-classification/classify()` declares its return shape **locally**
  (a structurally identical `interface`), not by importing the contracts type.
- The two are kept in sync by structural assignability (TS) — document the
  pairing in both files, mirroring the `blobReader` precedent. Consumers in
  `trajectory/` (which may import both `contracts` and `infra`) annotate with
  the contracts type; `classify()`'s result is assignable to it.

### 2. The policy: `EnrichmentProvider.shouldEnrich`

New optional method on the `EnrichmentProvider` contract
(`contracts/types/provider.ts`), following the existing optional-method style:

```ts
/** Enrichment scope a provider wants for one file. */
export type EnrichmentScope = "full" | "file-only" | "none";

export interface EnrichmentProvider {
  // ...existing members...

  /**
   * Per-file enrichment policy. The coordinator classifies each file once per
   * run (FileClassification) and asks the provider how much enrichment it
   * wants for that file. Absent ⇒ "full" (backward-compatible default — every
   * existing provider enriches everything as before).
   *
   * Returned scope:
   *   "full"      — file-level AND chunk-level enrichment (default).
   *   "file-only" — file-level only; skip the expensive chunk-churn walk.
   *   "none"      — skip both. The file stays indexed/searchable; only this
   *                 provider's signals are omitted for it.
   *
   * `classification` is duck-typed structurally (contracts is pure — no infra
   * import); the canonical type is FileClassification in
   * contracts/types/file-classification.ts.
   */
  shouldEnrich?(file: {
    relPath: string;
    classification: { isSource: boolean; isGenerated: boolean; isDocumentation: boolean; isTest: boolean };
  }): EnrichmentScope;
}
```

**Git policy** (`trajectory/git/provider.ts`):

| classification    | scope         | rationale                                        |
| ----------------- | ------------- | ------------------------------------------------ |
| `isGenerated`     | `"none"`      | harmful signals + huge blame target              |
| `isDocumentation` | `"file-only"` | keep doc ownership, drop prose chunk-churn        |
| otherwise         | `"full"`      | normal source (tests included — legit ownership) |

**Codegraph policy** (`trajectory/codegraph/...`):

| classification        | scope    | rationale                              |
| --------------------- | -------- | -------------------------------------- |
| `isGenerated`         | `"none"` | no human edits, no real call graph      |
| `isTest` (if enabled) | `"none"` | tests skew fanOut/isHub/PageRank        |
| otherwise             | `"full"` | docs irrelevant to codegraph anyway     |

`CODEGRAPH_EXCLUDE_TESTS` continues to gate the test branch; `isTest` is the
fact, the env is the policy toggle.

### 3. Pipeline wiring

The classification is computed **once per file per run** and memoized on
`RunState` (mirrors how kc93 memoizes the run-scoped reader). The coordinator
already holds the per-file context; classification slots in next to
`ignoreFilter`.

- **`file-phase.ts`** — before dispatching a provider's file work for a file,
  consult `provider.shouldEnrich(...)`; `"none"` ⇒ skip this provider's file
  enrichment for that file.
- **`chunk-phase.ts`** — alongside the existing `filterByIgnore` (which already
  drops `ignoreFilter`-matched files from the chunk map at
  `chunk-phase.ts:206`/`:460`), add `filterByEnrichmentPolicy`: drop any file
  whose scope is not `"full"` (both `"none"` and `"file-only"` skip the
  chunk-churn walk). This is the path that actually saves the cat-file blob
  reads.
- **content head** — the marker scan needs the first few lines. `file-phase`
  reads file content for blame anyway; thread a small `contentHead` into the
  classifier (and memoize) so no extra file read is introduced.

### 4. codegraph discovery migration

`CodegraphEnrichmentProvider.discoverSupportedFiles` currently builds a bespoke
`Ignore` via `buildCodegraphExclusionFilter`. It is reframed to consult the
shared `classify()` / shared `GENERATED_PATTERNS` / `TEST_PATTERNS` — same
behaviour, single source. `buildCodegraphExclusionFilter` may remain as a thin
wrapper that pulls patterns from infra, or be replaced by direct
`classify()` checks; the plan decides. Existing codegraph exclusion tests must
stay green (regression guard).

### 5. Config / override

- `GENERATED_PATTERNS` / `TEST_PATTERNS` — built-in invariants in infra.
- A unified user override env (e.g. `TEA_RAGS_GENERATED_PATTERNS`) appends to
  the generated set globally, affecting BOTH git-skip and codegraph
  graph-exclusion (one knob, both consumers). The existing
  `CODEGRAPH_CUSTOM_EXCLUDE` keeps working (codegraph layers both) — no breaking
  change to current users.
- A `.contextignore`-style per-file override section is **out of scope** for the
  first slice (YAGNI); revisit if users need per-repo generated patterns beyond
  the env.

## Testing (TDD)

- **infra `classify()`** — pure-function tests: generated globs
  (`db/schema.rb`, `foo.pb.go`, vendored), test globs, content markers
  (`Code generated … DO NOT EDIT`, `@generated`), `isDocumentation` passthrough,
  and the `isSource` complement.
- **`GitEnrichmentProvider.shouldEnrich`** — `generated → none`,
  `documentation → file-only`, source/test → `full`.
- **`CodegraphEnrichmentProvider.shouldEnrich`** — `generated → none`,
  `test → none` when excludeTests, otherwise `full`.
- **file-phase** — provider returning `"none"` ⇒ its file enrichment is skipped
  for that file.
- **chunk-phase** — `filterByEnrichmentPolicy` drops `none` + `file-only` files
  from the chunk map; `full` files pass through.
- **codegraph regression** — existing `exclusion` tests green after the pattern
  source swap.

## Backward compatibility

- `shouldEnrich` is optional; providers without it enrich `"full"` — no behaviour
  change for any provider that does not opt in.
- Moving codegraph's pattern constants to infra is an internal relocation; the
  public env vars (`CODEGRAPH_EXCLUDE_TESTS`, `CODEGRAPH_CUSTOM_EXCLUDE`) keep
  their semantics.
- **Reindex impact:** files newly classified as generated/doc will *lose* their
  git chunk (and, for generated, file) signals on the next index. This is the
  intended outcome, but it is a payload-shape change for those files — note in
  the plan whether it needs a force-reindex on existing collections to take
  effect, or whether incremental reindex of changed files suffices.

## Expected effect

On a Rails app: `db/schema.rb` (10k+ lines) + `vendor/**` + generated protobufs
are removed from `git blame` and the chunk-churn walk — the most expensive blame
targets and the noisiest churn. Complements kc93: kc93 made the remaining walk
fast (one cat-file process per run); this shrinks the walk's *input set*.

## Out of scope / follow-ups

- `.contextignore`-style per-repo generated-pattern file.
- Applying `shouldEnrich` to a future non-git, non-codegraph provider (the
  contract supports it; no consumer yet).
- Tuning the documentation policy (currently `file-only`) per signal — e.g.
  keeping doc `taskIds` but dropping `bugFixRate`. Today the file/chunk split is
  the only granularity.
