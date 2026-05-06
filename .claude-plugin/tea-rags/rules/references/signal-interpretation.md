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

Two ownership signal families coexist because they answer different questions:

| Family    | Source                             | Question it answers                        |
| --------- | ---------------------------------- | ------------------------------------------ |
| `recent*` | Commit history (configured window) | _Who has been committing here lately?_     |
| `blame*`  | `git blame HEAD` (current code)    | _Who owns the lines that exist right now?_ |

| Signal                                  | Family   | What it measures                                                                                                                                         |
| --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relativeChurn`                         |          | churn normalized by file size                                                                                                                            |
| `commitCount`                           |          | raw lifetime commit count                                                                                                                                |
| `chunkChurn`                            |          | chunk's share of file churn                                                                                                                              |
| `burstActivity`                         |          | recent concentrated change bursts                                                                                                                        |
| `bugFixRate`                            |          | share of commits tagged as fixes                                                                                                                         |
| `ageDays`                               |          | file age (at file level only — chunk age≈0)                                                                                                              |
| `recentDominantAuthor`                  | `recent` | top recent committer (string, file-level)                                                                                                                |
| `recentDominantAuthorPct`               | `recent` | top recent committer's share of recent commits                                                                                                           |
| `recentAuthors`                         | `recent` | recent committer set (top-N, capped)                                                                                                                     |
| `recentContributorCount`                | `recent` | distinct recent committers (file or chunk)                                                                                                               |
| `blameDominantAuthor`                   | `blame`  | top live-line owner (string, file-level)                                                                                                                 |
| `blameDominantAuthorPct`                | `blame`  | top live-line owner's share of current lines                                                                                                             |
| `blameAuthors`                          | `blame`  | live-line author set (top-N, capped)                                                                                                                     |
| `blameContributorCount`                 | `blame`  | distinct live-line owners (file or chunk)                                                                                                                |
| `knowledgeSilo` (derived)               | `blame`  | derived from `blame*`: 1 owner=1.0, 2=0.5, 3+=0 (silo = sole owner of the live code, NOT sole recent committer)                                          |
| `ownership` (derived)                   | `blame`  | derived from `blameDominantAuthorPct + blameAuthors`. "Who owns this code right now?" — used by `rerank: "ownership"`.                                   |
| `recentActivityConcentration` (derived) | `recent` | derived from `recentDominantAuthorPct + recentAuthors`. "Is recent activity dominated by one person?" — used by `rerank: "recentActivityConcentration"`. |
| `blockPenalty`                          |          | **data-quality penalty** for block chunks without chunk-level git data (NOT a boilerplate/DTO indicator — reflects alpha confidence, not repetition)     |

### Structural signals (from static trajectory)

| Signal          | What it measures                                   |
| --------------- | -------------------------------------------------- |
| `imports`       | fan-in — how many files import this (blast radius) |
| `pathRisk`      | path-based risk (e.g., `adapters/`, `legacy/`)     |
| `chunkSize`     | chunk line count                                   |
| `documentation` | doc density                                        |

`imports` is the critical disambiguator for churn-based patterns. Without it,
god module and bug attractor look identical.

## When to use `recent*` vs `blame*` (ownership-pair selection)

**Pick `blame*` when the question is about authority, knowledge, or risk
introduced by changing code.** It tells you who currently owns the live lines.

- "Who must approve this change?" → `blameDominantAuthor` (live-line owner)
- "Is this a knowledge silo?" → `blameContributorCount`,
  `blameDominantAuthorPct.label` (`silo` / `deep-silo`)
- "Bus factor for this module" → `blameAuthors` length
- Style copy when generating new code → match `blameDominantAuthor`'s style (the
  code currently there is theirs)

**Pick `recent*` when the question is about activity, momentum, or fast review
turnaround.** It tells you who's been committing lately, regardless of whether
their lines survived rewrites.

- "Who's loaded in for the fastest review?" → `recentDominantAuthor`
- "Feature-in-progress detection" → `recentDominantAuthorPct ↑` + `ageDays ↓`
  (one author burst-committing on new code)
- "Recent activity hotspot" → `recentContributorCount` and burst signals
- Code-review preparation for last-N-day changes → `recent*`

**Watch for divergence — it carries information.**

| `blame*` says                    | `recent*` says               | Reading                                                                                     |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| Alice owns 92% (silo)            | Alice = 5%, Bob/Carol active | Alice's code survives but she stopped contributing — **knowledge handoff in progress**      |
| Distributed (4+ owners, no silo) | Bob = 80% recent             | Bob is currently rewriting a previously-shared module — **soft takeover**                   |
| Alice owns 90%                   | Alice = 90% recent           | Active sole maintainer (silo + active) — **single-author module**                           |
| Distributed                      | Distributed                  | Healthy multi-owner, both historically and currently                                        |
| Alice = 95% (deep-silo)          | No recent commits at all     | Mature stable code with original author still nominally responsible — **dormant ownership** |

The reranker presets `ownership` and `knowledgeSilo` consume `blame*`; the
preset `recentActivityConcentration` consumes `recent*`. Custom rerank weights
mirror this split — see "Custom rerank weights" below.

## Pair diagnostics

Pairs and triples of signals map to architectural patterns. Single signal →
lookup is ambiguous; pair → likely classification; triple → confident.

### Churn-driven patterns

| Primary | Companion(s)                                           | Pattern                         |
| ------- | ------------------------------------------------------ | ------------------------------- |
| churn ↑ | `imports` ↑ + `recentContributorCount` ↑               | **God module / Coupling point** |
| churn ↑ | `bugFixRate` ↑ + `imports` ↓                           | **Bug attractor**               |
| churn ↑ | `recentDominantAuthorPct` ↑ + `ageDays` ↓              | **Feature-in-progress**         |
| churn ↑ | `ageDays` ↑ + `imports` ↓                              | **Local tech debt**             |
| churn ↑ | `pathRisk=dto/schema/generated` + `bugFixRate`=healthy | **Boilerplate churn**           |
| churn ↑ | `recentContributorCount` ↑ + `pathRisk`=shared         | **Shared infrastructure**       |

**Disambiguation rule for high churn:** always check `imports` before deciding.
High fan-in shifts meaning from "activity" to "coupling".

### Ownership-driven patterns

Ownership patterns read **`blame*`** (live-line ownership) by default, because
the architectural meaning of "silo" is _one person owns the live code_ — not
_one person committed last week_.

| Primary                                        | Companion(s)                                                  | Pattern                                                            |
| ---------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `blameDominantAuthorPct` silo+ (mono)          | `bugFixRate` ↑                                                | **Toxic silo**                                                     |
| `blameDominantAuthorPct` silo+ (mono)          | churn ↓ + `ageDays` ↑ + `bugFixRate`=healthy                  | **Healthy owner**                                                  |
| `recentDominantAuthorPct` ↑ (mono)             | `ageDays` ↓ + churn ↑                                         | **Feature-in-progress** (active sole author, distinct from "silo") |
| `blameDominantAuthor` ≠ `recentDominantAuthor` | non-trivial overlap (>20% recent activity by non-blame-owner) | **Knowledge handoff in progress**                                  |
| `blameContributorCount` ↑ (diffuse)            | churn ↑ + `imports` ↑                                         | **God module**                                                     |
| `blameContributorCount` ↑ (diffuse)            | churn ↓                                                       | **Dead utility**                                                   |

**Disambiguation rule for mono ownership:** single author is NOT automatically a
problem. It is a problem only when paired with instability (bugFixRate) or when
paired with churn+age (nobody else can help maintain volatile code).

**Disambiguation rule for `recent*` mono activity:**
`recentDominantAuthorPct silo+` does NOT mean the file is owned by one person —
it means one person has been the dominant committer recently. Pair with
`blameDominantAuthorPct` to decide: matching → reinforced silo; diverging →
handoff or active rewrite.

### Age-driven patterns

| Primary | Companion(s)                         | Pattern                    |
| ------- | ------------------------------------ | -------------------------- |
| age ↑   | churn ↓ + `bugFixRate`=healthy       | **Stable / proven**        |
| age ↑   | churn ↑ + `bugFixRate` ↑             | **Legacy minefield**       |
| age ↑   | `bugFixRate` ↑                       | **Fragile legacy**         |
| age ↑   | churn ≈ 0 + imports ≈ 0              | **Dead / dormant code**    |
| age ↓   | churn ↑ + `recentContributorCount` ↑ | **Emerging coupling zone** |

**Disambiguation rule for high age:** age inverts meaning depending on churn.
Old

- low churn = don't touch; old + high churn = must rewrite.

## Method-level (chunk) pair diagnostics

File-level signals tell you _which file_ is a god module. Chunk-level signals
tell you _which method inside the file_ is actually the problem. They are
orthogonal — always combine both layers when available.

Chunk-level signals that exist (no chunk-variant for `imports`,
`*DominantAuthor*` strings, `*Authors[]` lists — those are file properties by
nature; chunk only carries scalar counts):

- `chunk.ageDays` — last modification to this specific chunk
- `chunk.bugFixRate` — fix-commit share for this chunk
- `chunk.relativeChurn` — churn normalized by chunk size
- `chunk.recentContributorCount` — distinct **recent committers** who touched
  this chunk
- `chunk.blameContributorCount` — distinct **live-line owners** of this chunk
  (from `git blame HEAD` restricted to chunk lines)
- `chunk.commitCount` — lifetime commits on this chunk
- `chunk.recencyWeightedFreq` — method-level burst activity
- `chunk.churnRatio` — this chunk's share of file churn

Use `chunk.blameContributorCount = 1` to detect a method whose live lines all
come from one author — the method-level silo. Use
`chunk.recentContributorCount ↑` to detect a method that's currently a
coordination point (many people are committing to it, regardless of whose lines
survive).

### Chunk × file combinations

| Chunk signal                      | File signal                         | Method-level pattern                                                                                                           |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `chunk.bugFixRate` ↑              | `file.bugFixRate` typical           | **Local bug nest** — one method is the offender, rest of file is healthy                                                       |
| `chunk.bugFixRate` typical        | `file.bugFixRate` ↑                 | **Buggy elsewhere** — this specific method is NOT the cause, look at siblings                                                  |
| `chunk.ageDays` ↑                 | `file.ageDays` ↑                    | **Fossil method** — untouched inside an old file (proven or dead)                                                              |
| `chunk.ageDays` ↓                 | `file.ageDays` ↑                    | **New method in legacy** — active extension of old file                                                                        |
| `chunk.ageDays` ↑                 | `file.ageDays` ↓                    | **Leftover method** — rest of file got rewritten, this chunk survived                                                          |
| `chunk.recentContributorCount` ↑  | `file.blameDominantAuthorPct` silo+ | **Public API surface** — one owner owns the file's lines, but this method is touched recently by everyone (public contract)    |
| `chunk.blameContributorCount` = 1 | `file.blameContributorCount` ↑      | **Private method in shared file** — owner-only code inside a shared module                                                     |
| `chunk.recentContributorCount` ↑  | `file.recentContributorCount` low   | **Coordination spot** — single author owns the file's recent activity overall, but this method recently attracted many commits |
| `chunk.relativeChurn` ↑           | `file.relativeChurn` typical        | **Hotspot method** — point problem, not file-wide thrashing                                                                    |
| `chunk.churnRatio` ↑              | (any)                               | **File churn concentrated here** — this chunk accounts for most of the file's changes                                          |
| `chunk.recencyWeightedFreq` ↑     | `file.recencyWeightedFreq` typical  | **Local refactoring burst** — recent spike on this method, file otherwise calm                                                 |

### Method-level classification refinements

When file-level points to a pattern, chunk-level refines WHERE the work is:

- **Coupling point** (file): find the specific method with high
  `chunk.recentContributorCount` — that's the overloaded API entry point where
  many recent committers meet.
- **Legacy minefield** (file): find the method with highest `chunk.bugFixRate
  - chunk.relativeChurn` — that's the actual minefield, the rest of the file may
    be rewritable piecemeal.
- **Toxic silo** (file): check `chunk.blameContributorCount` — if every method
  has `= 1`, full silo; if one method has diffuse blame authorship (≥ 2
  live-line owners) inside an otherwise siloed file, that method is the public
  API and ownership transfer is partial.
- **Bug attractor** (file): find the method with highest `chunk.bugFixRate` —
  fix-the-abstraction effort should start there, not at file boundaries.
- **Feature-in-progress** (file): `chunk.ageDays ↓` across most methods confirms
  — if some methods are old, file mixes new and legacy code.

### Useful chunk-only signatures (not derivable at file level)

| Signature                                                 | Pattern                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `chunk.bugFixRate ↑` + `chunk.recentContributorCount` ↑   | **Public method bug nest** (many recent committers, many fixes, concentrated)                 |
| `chunk.ageDays ↑` + `chunk.commitCount ≈ 1`               | **Write-once method** (likely stable, or dead)                                                |
| `chunk.relativeChurn ↑` + `chunk.bugFixRate` healthy      | **Active refactoring method** (healthy churn, evolving design)                                |
| `chunk.recencyWeightedFreq ↑` + `chunk.ageDays ↓`         | **New method, bursty** — feature-in-progress at method granularity                            |
| `chunk.recentContributorCount` ↑ + `chunk.churnRatio` ↑   | **Coordination method** — where everyone meets to add features                                |
| `chunk.blameContributorCount` = 1 + `chunk.commitCount` ↑ | **Method-level silo** — many commits but all by one person (live-line ownership concentrated) |

## Architectural patterns catalog

### God module / Coupling point

**Signature:**
`churn ↑ + imports ↑ + recentContributorCount ↑ + blameContributorCount ↑`
**What it is:** Central file imported by many, edited by many (recent activity
AND surviving authorship distributed), because any change passes through. Not a
quality problem per se — an architectural coupling problem. Example:
`adapters/qdrant-client.ts` (65 commits over project life). **Remediation:**
decouple or stabilize interface; freeze signature.

### Bug attractor

**Signature:** `churn ↑ + bugFixRate ↑ + imports ↓` **What it is:** Broken
abstraction. High fix-rate with low fan-in means bugs don't propagate from
elsewhere — they originate here. Single file misbehaves. **Remediation:**
redesign the abstraction, not patch another fix.

### Toxic silo

**Signature:**
`blameDominantAuthorPct silo+ + bugFixRate ↑ + (churn ↑ or age ↑)` **What it
is:** One author owns the live lines of volatile or fragile code. Bus factor +
quality risk combined. Note: must be `blame*`, not `recent*` — a recent-only
mono author may simply be a feature-in-progress, not a silo. **Remediation:**
pair rotation, knowledge transfer, or splitting ownership.

### Healthy owner

**Signature:**
`blameDominantAuthorPct silo+ + churn ↓ + age ↑ + bugFixRate=healthy` **What it
is:** Mature component with a maintainer who authored the live code. Low change
rate + clean fix history means the owner got the design right and it's stable.
NOT a risk. **Remediation:** none. Preserve as-is. (Even better signal:
`recentContributorCount` low or zero — owner still nominally responsible but
code is dormant.)

### Legacy minefield

**Signature:** `age ↑ + churn ↑ + bugFixRate ↑` **What it is:** Old code that
won't stabilize. Every touch risks a regression. Different from tech debt —
active instability, not static debt. **Remediation:** strangler-pattern rewrite.

### Fragile legacy

**Signature:** `age ↑ + bugFixRate ↑ + churn ≈ typical` **What it is:** Old code
that mostly works but breaks when touched. Knowledge has evaporated.
**Remediation:** defer changes; document invariants before touching.

### Feature-in-progress

**Signature:**
`churn ↑ + recentDominantAuthorPct ↑ + age ↓ + bugFixRate=healthy + imports ↓`
**What it is:** New feature under active build. Extreme churn is expected. NOT a
risk. Usually one recent developer, low fan-in (not yet integrated). Read via
`recent*` (commit activity), not `blame*` — for new code they coincide, but the
conceptual signal is "active solo work", not "silo ownership of mature code".
**Remediation:** none; revisit after stabilization.

### Boilerplate churn

**Signature:**
`churn ↑ + bugFixRate=healthy + imports low + path ~ dto/schema/generated`
**What it is:** DTO, schema, mapping, or generated-like file. Commits accumulate
because every feature adds a field. High churn is cosmetic, not structural. No
single git signal detects this directly — use path heuristic + healthy
bugFixRate + low fan-in. **Remediation:** consider code generation; otherwise
ignore.

### Emerging coupling zone

**Signature:**
`age ↓ + churn ↑ + recentContributorCount ↑ + imports ↑ (growing)` **What it
is:** Young file already imported widely and edited by many. Early signal of god
module forming. Easier to fix now than later. **Remediation:** split before it
crystallizes.

### Dead / dormant code

**Signature:**
`age ↑ + churn ≈ 0 + blameContributorCount = 1 + recentContributorCount = 0 + imports ≈ 0`
**What it is:** Code nobody touches, nobody imports. The original author still
nominally owns the lines but no one has committed recently. Silo signal here is
meaningless — nothing depends on this knowledge. **Remediation:** verify fan-in,
then delete.

### Shared infrastructure

**Signature:**
`churn ↑ + recentContributorCount ↑ + blameContributorCount ↑ + imports ↑ + bugFixRate=typical + pathRisk=shared (e.g., adapters/, core/)`
**What it is:** Infrastructure seam (HTTP client, DB adapter, config). Naturally
high fan-in and cross-team churn (both historically and recently). Overlaps with
god module but bugFixRate stays healthy because the code is mostly mechanical.
**Remediation:** review process and ownership rotation, not redesign.

## Interpretation anti-patterns

Agents consistently make these mistakes when reading overlay:

1. **"high churn = active development"** — wrong. Could be coupling, attractor,
   boilerplate, legacy thrash, or real development. Check `imports`, `ageDays`,
   `bugFixRate`, `blockPenalty` before deciding.
2. **"mono ownership = problem"** — wrong. Healthy owner of stable mature code
   is a strength. Only toxic when paired with instability. **Always read mono
   ownership via `blame*`** (live-line) — `recentDominantAuthorPct` mono is just
   "active sole committer", which can be feature-in-progress, not silo.
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

**Available weight keys for ownership-axis queries:**

| Weight key                    | Source family | High score means                                              |
| ----------------------------- | ------------- | ------------------------------------------------------------- |
| `ownership`                   | `blame`       | One person owns most of the live lines (silo of current code) |
| `knowledgeSilo`               | `blame`       | Single live-line owner — sharp binary version of `ownership`  |
| `recentActivityConcentration` | `recent`      | One person dominated recent commits (active sole committer)   |

Use **negative weights** to surface the inverse (e.g., diffuse authorship for
god-module detection).

### Detect god modules / coupling points

```json
{ "custom": { "imports": 0.5, "churn": 0.3, "ownership": -0.2 } }
```

Prioritizes fan-in. Negative `ownership` surfaces files where ownership is
diffuse — many live-line owners, classic god module. Pair
`recentActivityConcentration` negated if you want "actively edited by many right
now":

```json
{
  "custom": {
    "imports": 0.5,
    "churn": 0.3,
    "recentActivityConcentration": -0.2
  }
}
```

### Healthy owner vs toxic silo

```json
// Toxic silo (live-line silo + instability)
{ "custom": { "ownership": 0.4, "bugFix": 0.4, "churn": 0.2 } }

// Healthy stewardship (live-line owner of stable old code)
{ "custom": { "ownership": 0.4, "stability": 0.3, "age": 0.3 } }
```

Both queries lean on `ownership` (blame-based). For the active-sole-committer
flavor of feature-in-progress, swap in `recentActivityConcentration`.

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

### Knowledge handoff in progress (blame ≠ recent)

```json
{
  "custom": {
    "ownership": 0.4,
    "recentActivityConcentration": -0.3,
    "churn": 0.3
  }
}
```

High `ownership` (one person still owns the lines) + low recent concentration
(many people committing now) + active churn → handoff zone where new
contributors are taking over a previously-siloed module. Useful for routing
mentorship/review pairings.

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
