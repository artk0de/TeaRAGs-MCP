# Signal Interpretation

How to read tea-rags ranking overlay architecturally. Single signals are
ambiguous — combinations reveal meaning.

## Core thesis

**A signal is a gradient, not a diagnosis.**

One high signal tells you _something is happening_ — it never tells you _what_.
Churn alone does not mean "active development". Age alone does not mean
"legacy". Ownership alone does not mean "silo". Architectural meaning emerges
only from pairs/triples.

The reranker gives a ranking; this file gives an interpretation layer. Consult
before concluding anything from overlay.

## Signal reference

### Git signals (payload.git.file._ / payload.git.chunk._)

| Signal              | What it measures                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relativeChurn`     | churn normalized by file size                                                                                                                        |
| `commitCount`       | raw lifetime commit count                                                                                                                            |
| `chunkChurn`        | chunk's share of file churn                                                                                                                          |
| `burstActivity`     | recent concentrated change bursts                                                                                                                    |
| `bugFixRate`        | share of commits tagged as fixes                                                                                                                     |
| `ageDays`           | file age (at file level only — chunk age≈0)                                                                                                          |
| `dominantAuthorPct` | top contributor share                                                                                                                                |
| `authors`           | distinct contributor count                                                                                                                           |
| `knowledgeSilo`     | derived: 1 author=1.0, 2=0.5, 3+=0                                                                                                                   |
| `blockPenalty`      | **data-quality penalty** for block chunks without chunk-level git data (NOT a boilerplate/DTO indicator — reflects alpha confidence, not repetition) |

### Structural signals (from static trajectory)

| Signal          | What it measures                                   |
| --------------- | -------------------------------------------------- |
| `imports`       | fan-in — how many files import this (blast radius) |
| `pathRisk`      | path-based risk (e.g., `adapters/`, `legacy/`)     |
| `chunkSize`     | chunk line count                                   |
| `documentation` | doc density                                        |

`imports` is the critical disambiguator for churn-based patterns. Without it,
god module and bug attractor look identical.

## Pair diagnostics

Pairs and triples of signals map to architectural patterns. Single signal →
lookup is ambiguous; pair → likely classification; triple → confident.

### Churn-driven patterns

| Primary | Companion(s)                                           | Pattern                         |
| ------- | ------------------------------------------------------ | ------------------------------- |
| churn ↑ | `imports` ↑ + `authors` ↑                              | **God module / Coupling point** |
| churn ↑ | `bugFixRate` ↑ + `imports` ↓                           | **Bug attractor**               |
| churn ↑ | `dominantAuthorPct` ↑ + `ageDays` ↓                    | **Feature-in-progress**         |
| churn ↑ | `ageDays` ↑ + `imports` ↓                              | **Local tech debt**             |
| churn ↑ | `pathRisk=dto/schema/generated` + `bugFixRate`=healthy | **Boilerplate churn**           |
| churn ↑ | `authors` ↑ + `pathRisk`=shared                        | **Shared infrastructure**       |

**Disambiguation rule for high churn:** always check `imports` before deciding.
High fan-in shifts meaning from "activity" to "coupling".

### Ownership-driven patterns

| Primary               | Companion(s)                                 | Pattern                 |
| --------------------- | -------------------------------------------- | ----------------------- |
| ownership ↑ (mono)    | `bugFixRate` ↑                               | **Toxic silo**          |
| ownership ↑ (mono)    | churn ↓ + `ageDays` ↑ + `bugFixRate`=healthy | **Healthy owner**       |
| ownership ↑ (mono)    | `ageDays` ↓ + churn ↑                        | **Feature-in-progress** |
| ownership ↓ (diffuse) | churn ↑ + `imports` ↑                        | **God module**          |
| ownership ↓           | churn ↓                                      | **Dead utility**        |

**Disambiguation rule for mono ownership:** single author is NOT automatically a
problem. It is a problem only when paired with instability (bugFixRate) or when
paired with churn+age (nobody else can help maintain volatile code).

### Age-driven patterns

| Primary | Companion(s)                   | Pattern                    |
| ------- | ------------------------------ | -------------------------- |
| age ↑   | churn ↓ + `bugFixRate`=healthy | **Stable / proven**        |
| age ↑   | churn ↑ + `bugFixRate` ↑       | **Legacy minefield**       |
| age ↑   | `bugFixRate` ↑                 | **Fragile legacy**         |
| age ↑   | churn ≈ 0 + imports ≈ 0        | **Dead / dormant code**    |
| age ↓   | churn ↑ + `authors` ↑          | **Emerging coupling zone** |

**Disambiguation rule for high age:** age inverts meaning depending on churn.
Old

- low churn = don't touch; old + high churn = must rewrite.

## Method-level (chunk) pair diagnostics

File-level signals tell you _which file_ is a god module. Chunk-level signals
tell you _which method inside the file_ is actually the problem. They are
orthogonal — always combine both layers when available.

Chunk-level signals that exist (no chunk-variant for `imports`,
`dominantAuthor*`, `authors` — those are file properties by nature):

- `chunk.ageDays` — last modification to this specific chunk
- `chunk.bugFixRate` — fix-commit share for this chunk
- `chunk.relativeChurn` — churn normalized by chunk size
- `chunk.contributorCount` — distinct authors who touched this chunk
- `chunk.commitCount` — lifetime commits on this chunk
- `chunk.recencyWeightedFreq` — method-level burst activity
- `chunk.churnRatio` — this chunk's share of file churn

### Chunk × file combinations

| Chunk signal                  | File signal                        | Method-level pattern                                                                               |
| ----------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `chunk.bugFixRate` ↑          | `file.bugFixRate` typical          | **Local bug nest** — one method is the offender, rest of file is healthy                           |
| `chunk.bugFixRate` typical    | `file.bugFixRate` ↑                | **Buggy elsewhere** — this specific method is NOT the cause, look at siblings                      |
| `chunk.ageDays` ↑             | `file.ageDays` ↑                   | **Fossil method** — untouched inside an old file (proven or dead)                                  |
| `chunk.ageDays` ↓             | `file.ageDays` ↑                   | **New method in legacy** — active extension of old file                                            |
| `chunk.ageDays` ↑             | `file.ageDays` ↓                   | **Leftover method** — rest of file got rewritten, this chunk survived                              |
| `chunk.contributorCount` ↑    | `file.dominantAuthorPct` ↑         | **Public API surface** — owner owns file, but this method is touched by everyone (public contract) |
| `chunk.contributorCount` ↓    | `file.contributorCount` ↑          | **Private method in shared file** — owner-only code inside a shared module                         |
| `chunk.relativeChurn` ↑       | `file.relativeChurn` typical       | **Hotspot method** — point problem, not file-wide thrashing                                        |
| `chunk.churnRatio` ↑          | (any)                              | **File churn concentrated here** — this chunk accounts for most of the file's changes              |
| `chunk.recencyWeightedFreq` ↑ | `file.recencyWeightedFreq` typical | **Local refactoring burst** — recent spike on this method, file otherwise calm                     |

### Method-level classification refinements

When file-level points to a pattern, chunk-level refines WHERE the work is:

- **Coupling point** (file): find the specific method with high
  `chunk.contributorCount` — that's the overloaded API entry point.
- **Legacy minefield** (file): find the method with highest `chunk.bugFixRate
  - chunk.relativeChurn` — that's the actual minefield, the rest of the file may
    be rewritable piecemeal.
- **Toxic silo** (file): check `chunk.contributorCount` — if one owner wrote all
  methods, full silo; if one method has diffuse authorship, that method is the
  public API and transfer is partial.
- **Bug attractor** (file): find the method with highest `chunk.bugFixRate` —
  fix-the-abstraction effort should start there, not at file boundaries.
- **Feature-in-progress** (file): `chunk.ageDays ↓` across most methods confirms
  — if some methods are old, file mixes new and legacy code.

### Useful chunk-only signatures (not derivable at file level)

| Signature                                            | Pattern                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `chunk.bugFixRate ↑` + `chunk.contributorCount` ↑    | **Public method bug nest** (many people, many fixes, concentrated) |
| `chunk.ageDays ↑` + `chunk.commitCount ≈ 1`          | **Write-once method** (likely stable, or dead)                     |
| `chunk.relativeChurn ↑` + `chunk.bugFixRate` healthy | **Active refactoring method** (healthy churn, evolving design)     |
| `chunk.recencyWeightedFreq ↑` + `chunk.ageDays ↓`    | **New method, bursty** — feature-in-progress at method granularity |
| `chunk.contributorCount ↑` + `chunk.churnRatio ↑`    | **Coordination method** — where everyone meets to add features     |

## Architectural patterns catalog

### God module / Coupling point

**Signature:** `churn ↑ + imports ↑ + authors ↑` **What it is:** Central file
imported by many, edited by many, because any change passes through. Not a
quality problem per se — an architectural coupling problem. Example:
`adapters/qdrant-client.ts` (65 commits over project life). **Remediation:**
decouple or stabilize interface; freeze signature.

### Bug attractor

**Signature:** `churn ↑ + bugFixRate ↑ + imports ↓` **What it is:** Broken
abstraction. High fix-rate with low fan-in means bugs don't propagate from
elsewhere — they originate here. Single file misbehaves. **Remediation:**
redesign the abstraction, not patch another fix.

### Toxic silo

**Signature:** `ownership ↑ + bugFixRate ↑ + (churn ↑ or age ↑)` **What it is:**
One author owns volatile or fragile code. Bus factor + quality risk combined.
**Remediation:** pair rotation, knowledge transfer, or splitting ownership.

### Healthy owner

**Signature:** `ownership ↑ + churn ↓ + age ↑ + bugFixRate=healthy` **What it
is:** Mature component with a maintainer. Low change rate + clean fix history
means the owner got the design right and it's stable. NOT a risk.
**Remediation:** none. Preserve as-is.

### Legacy minefield

**Signature:** `age ↑ + churn ↑ + bugFixRate ↑` **What it is:** Old code that
won't stabilize. Every touch risks a regression. Different from tech debt —
active instability, not static debt. **Remediation:** strangler-pattern rewrite.

### Fragile legacy

**Signature:** `age ↑ + bugFixRate ↑ + churn ≈ typical` **What it is:** Old code
that mostly works but breaks when touched. Knowledge has evaporated.
**Remediation:** defer changes; document invariants before touching.

### Feature-in-progress

**Signature:** `churn ↑ + ownership ↑ + age ↓ + bugFixRate=healthy + imports ↓`
**What it is:** New feature under active build. Extreme churn is expected. NOT a
risk. Usually one developer, low fan-in (not yet integrated). **Remediation:**
none; revisit after stabilization.

### Boilerplate churn

**Signature:**
`churn ↑ + bugFixRate=healthy + imports low + path ~ dto/schema/generated`
**What it is:** DTO, schema, mapping, or generated-like file. Commits accumulate
because every feature adds a field. High churn is cosmetic, not structural. No
single git signal detects this directly — use path heuristic + healthy
bugFixRate + low fan-in. **Remediation:** consider code generation; otherwise
ignore.

### Emerging coupling zone

**Signature:** `age ↓ + churn ↑ + authors ↑ + imports ↑ (growing)` **What it
is:** Young file already imported widely and edited by many. Early signal of god
module forming. Easier to fix now than later. **Remediation:** split before it
crystallizes.

### Dead / dormant code

**Signature:** `age ↑ + churn ≈ 0 + authors=1 + imports ≈ 0` **What it is:**
Code nobody touches, nobody imports. Probably dead. Silo signal here is
meaningless — nothing depends on this knowledge. **Remediation:** verify fan-in,
then delete.

### Shared infrastructure

**Signature:**
`churn ↑ + authors ↑ + imports ↑ + bugFixRate=typical + pathRisk=shared (e.g., adapters/, core/)`
**What it is:** Infrastructure seam (HTTP client, DB adapter, config). Naturally
high fan-in and cross-team churn. Overlaps with god module but bugFixRate stays
healthy because the code is mostly mechanical. **Remediation:** review process
and ownership rotation, not redesign.

## Interpretation anti-patterns

Agents consistently make these mistakes when reading overlay:

1. **"high churn = active development"** — wrong. Could be coupling, attractor,
   boilerplate, legacy thrash, or real development. Check `imports`, `ageDays`,
   `bugFixRate`, `blockPenalty` before deciding.
2. **"mono ownership = problem"** — wrong. Healthy owner of stable mature code
   is a strength. Only toxic when paired with instability.
3. **"high age = legacy to rewrite"** — wrong. Old + low churn = proven. Old +
   high churn = minefield. Age inverts on churn.
4. **"high fan-in = god module"** — incomplete. High `imports` on a stable
   contract (types, errors) with low churn is a healthy foundation, not a god
   module. Coupling problem requires `imports ↑ + churn ↑`.
5. **"bugFixRate concerning = bug magnet"** — incomplete. With `imports ↓` it's
   a bug attractor (local problem). With `imports ↑` it's coupling spreading
   bugs downstream (different remediation).
6. **Forcing a single classification.** Real code often shows hybrid patterns
   (e.g., god module that is also emerging legacy). Report both when overlay
   supports it.
7. **Concluding from one signal.** If overlay has only one strong signal and the
   rest are typical/missing → insufficient evidence. Say so instead of guessing
   a class.

## Custom rerank weights for architectural queries

When no preset fits, build custom weights. Examples:

### Detect god modules / coupling points

```json
{ "custom": { "imports": 0.5, "churn": 0.3, "authors": 0.2 } }
```

Prioritizes fan-in as primary signal.

### Healthy owner vs toxic silo

```json
// Toxic silo
{ "custom": { "ownership": 0.4, "bugFix": 0.4, "churn": 0.2 } }

// Healthy stewardship
{ "custom": { "ownership": 0.4, "stability": 0.3, "age": 0.3 } }
```

### Bug attractor (excluding coupling)

```json
{ "custom": { "bugFix": 0.5, "churn": 0.3, "imports": -0.2 } }
```

Negative weight on imports suppresses coupling points.

### Emerging coupling (early warning)

```json
{ "custom": { "imports": 0.4, "churn": 0.3, "recency": 0.3 } }
```

Surfaces young files that are already widely imported.

## Limitations

1. **Line drift.** `bugFixRate` at chunk level is approximate because git blame
   drifts across renames and reformats. Use file-level bugFixRate when exact
   numbers matter; chunk-level for relative ranking.
2. **Alpha-blending masks layers.** Derived signals blend file and chunk
   (`effective = alpha*chunk + (1-alpha)*file`). For architectural analysis you
   sometimes need raw `payload.git.file.*` WITHOUT blending — e.g., to see
   fan-in as a file property, not chunk-mixed. Request `metaOnly=false` and read
   the raw payload directly.
3. **Overlay masking.** Each preset curates a subset of signals via its
   `overlayMask`. If `imports` is absent from the overlay you see, the preset
   chose not to surface it — not that the file has no imports. Either switch
   preset or use custom rerank with explicit weight keys (signals with weights
   appear in overlay automatically).
4. **Single-snapshot bias.** All signals reflect a single index build. Rapidly
   evolving files (feature branches) may show churn from merged history, not
   live activity.

## Workflow

When interpreting any multi-signal overlay:

1. **List strong signals** (level `high+` or `concerning+` in labelMap terms).
2. **Look up the pair** in the tables above. Start with the signal that has the
   highest level.
3. **Check the disambiguator** named in the relevant rule (usually `imports`,
   `bugFixRate`, or `ageDays`).
4. **Pick one or two patterns** from the catalog. Hybrid is allowed.
5. **If only one signal is strong** → report insufficient evidence, do not
   classify.
6. **If overlay is missing a disambiguator** → switch preset or add custom
   weight to surface it; do not guess.
