# Signal Interpretation

Read tea-rags ranking overlay architecturally. Single signals ambiguous —
combinations reveal meaning.

## Core thesis

**A signal is a gradient, not a diagnosis.**

One high signal → _something happening_ — never _what_. Churn alone ≠ "active
development". Age alone ≠ "legacy". Ownership alone ≠ "silo". Architectural
meaning emerges only from pairs/triples.

Reranker gives ranking; this file gives interpretation layer. Consult before
concluding anything from overlay.

## Signal reference

### Git signals (payload.git.file._ / payload.git.chunk._)

Two ownership signal families coexist — answer different questions:

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

| Signal          | What it measures                                                  |
| --------------- | ----------------------------------------------------------------- |
| `imports`       | fan-in PROXY — how many files import this (raw import-line count) |
| `pathRisk`      | path-based risk (e.g., `adapters/`, `legacy/`)                    |
| `chunkSize`     | chunk line count                                                  |
| `documentation` | doc density                                                       |

`imports` = critical disambiguator for churn-based patterns. Without it, god
module and bug attractor look identical.

#### Codegraph signals (only when codegraph is active)

Present ONLY when prime `## Enrichment` lists `codegraph.symbols`; absent
otherwise. Real call/import-edge measures, **supersede `imports` proxy** where
both exist — `imports` counts import lines, `fanIn` counts actual graph edges.

| Signal             | Scope      | What it measures                                          |
| ------------------ | ---------- | --------------------------------------------------------- |
| `fanIn`            | file/chunk | incoming edges — who depends on this (true blast radius)  |
| `fanOut`           | file/chunk | outgoing edges — how much this drives                     |
| `isHub`            | file       | high-fan-in backbone flag (the structural centre)         |
| `instability`      | file       | `fanOut / (fanIn + fanOut)` — efferent coupling (Martin)  |
| `connectionCount`  | file       | `fanIn + fanOut` — total coupling / confidence support    |
| `transitiveImpact` | file       | reachable dependents — systemic blast radius beyond 1 hop |
| `pageRank`         | chunk      | global centrality of a method in the call graph           |
| cycle membership   | file/chunk | member of an SCC (`find_cycles`) — circular coupling      |

Codegraph off → fall back to `imports` proxy, say structural centrality is
approximate (see search-cascade "Graph navigation").

## When to use `recent*` vs `blame*` (ownership-pair selection)

**Pick `blame*` for authority, knowledge, or risk from changing code.** Tells
who currently owns live lines.

- "Who must approve this change?" → `blameDominantAuthor` (live-line owner)
- "Is this a knowledge silo?" → `blameContributorCount`,
  `blameDominantAuthorPct.label` (`silo` / `deep-silo`)
- "Bus factor for this module" → `blameAuthors` length
- Style copy when generating new code → match `blameDominantAuthor`'s style (the
  code currently there is theirs)

**Pick `recent*` for activity, momentum, or fast review turnaround.** Tells
who's been committing lately, regardless of whether their lines survived
rewrites.

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

Presets `ownership` and `knowledgeSilo` consume `blame*`; preset
`recentActivityConcentration` consumes `recent*`. Custom weights mirror this
split — see "Custom rerank weights" below.

## Pair diagnostics

Pairs/triples map to architectural patterns. Single → ambiguous; pair → likely;
triple → confident.

### Churn-driven patterns

| Primary | Companion(s)                                           | Pattern                         |
| ------- | ------------------------------------------------------ | ------------------------------- |
| churn ↑ | `imports` ↑ + `recentContributorCount` ↑               | **God module / Coupling point** |
| churn ↑ | `bugFixRate` ↑ + `imports` ↓                           | **Bug attractor**               |
| churn ↑ | `recentDominantAuthorPct` ↑ + `ageDays` ↓              | **Feature-in-progress**         |
| churn ↑ | `ageDays` ↑ + `imports` ↓                              | **Local tech debt**             |
| churn ↑ | `pathRisk=dto/schema/generated` + `bugFixRate`=healthy | **Boilerplate churn**           |
| churn ↑ | `recentContributorCount` ↑ + `pathRisk`=shared         | **Shared infrastructure**       |

**Disambiguation rule for high churn:** always check `imports` first. High
fan-in shifts meaning from "activity" to "coupling".

### Ownership-driven patterns

Ownership patterns read **`blame*`** (live-line ownership) by default — "silo"
means _one person owns the live code_, not _one person committed last week_.

| Primary                                        | Companion(s)                                                  | Pattern                                                            |
| ---------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `blameDominantAuthorPct` silo+ (mono)          | `bugFixRate` ↑                                                | **Toxic silo**                                                     |
| `blameDominantAuthorPct` silo+ (mono)          | churn ↓ + `ageDays` ↑ + `bugFixRate`=healthy                  | **Healthy owner**                                                  |
| `recentDominantAuthorPct` ↑ (mono)             | `ageDays` ↓ + churn ↑                                         | **Feature-in-progress** (active sole author, distinct from "silo") |
| `blameDominantAuthor` ≠ `recentDominantAuthor` | non-trivial overlap (>20% recent activity by non-blame-owner) | **Knowledge handoff in progress**                                  |
| `blameContributorCount` ↑ (diffuse)            | churn ↑ + `imports` ↑                                         | **God module**                                                     |
| `blameContributorCount` ↑ (diffuse)            | churn ↓                                                       | **Dead utility**                                                   |

**Disambiguation rule for mono ownership:** single author NOT automatically a
problem. Problem only when paired with instability (bugFixRate) or with
churn+age (nobody else can maintain volatile code).

**Disambiguation rule for `recent*` mono activity:**
`recentDominantAuthorPct silo+` does NOT mean one person owns the file — means
one person is dominant committer recently. Pair with `blameDominantAuthorPct`:
matching → reinforced silo; diverging → handoff or active rewrite.

### Age-driven patterns

| Primary | Companion(s)                         | Pattern                    |
| ------- | ------------------------------------ | -------------------------- |
| age ↑   | churn ↓ + `bugFixRate`=healthy       | **Stable / proven**        |
| age ↑   | churn ↑ + `bugFixRate` ↑             | **Legacy minefield**       |
| age ↑   | `bugFixRate` ↑                       | **Fragile legacy**         |
| age ↑   | churn ≈ 0 + imports ≈ 0              | **Dead / dormant code**    |
| age ↓   | churn ↑ + `recentContributorCount` ↑ | **Emerging coupling zone** |

**Disambiguation rule for high age:** age inverts meaning on churn. Old

- low churn = don't touch; old + high churn = must rewrite.

## Method-level (chunk) pair diagnostics

File-level → _which file_ is a god module. Chunk-level → _which method inside_
is the problem. Orthogonal — always combine both layers when available.

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

`chunk.blameContributorCount = 1` → method whose live lines all come from one
author (method-level silo). `chunk.recentContributorCount ↑` → method currently
a coordination point (many people committing, regardless of whose lines
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

File-level → pattern; chunk-level refines WHERE work is:

- **Coupling point** (file): find method with high
  `chunk.recentContributorCount` — overloaded API entry point where many recent
  committers meet.
- **Legacy minefield** (file): find method with highest `chunk.bugFixRate
  - chunk.relativeChurn` — the actual minefield; rest of file may be rewritable
    piecemeal.
- **Toxic silo** (file): check `chunk.blameContributorCount` — every method
  `= 1` → full silo; one method with diffuse blame authorship (≥ 2 live-line
  owners) inside an otherwise siloed file → that method is public API, ownership
  transfer partial.
- **Bug attractor** (file): find method with highest `chunk.bugFixRate` —
  fix-the-abstraction effort starts there, not at file boundaries.
- **Feature-in-progress** (file): `chunk.ageDays ↓` across most methods
  confirms; some old methods → file mixes new and legacy code.

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
`churn ↑ + fanIn ↑ / isHub (or imports ↑ proxy) + recentContributorCount ↑ + blameContributorCount ↑`
**What it is:** Central file imported by many, edited by many (recent activity
AND surviving authorship distributed) — any change passes through. Not a quality
problem per se — architectural coupling problem. Example:
`adapters/qdrant-client.ts` (65 commits over project life). **Codegraph:** real
`fanIn` / `isHub` confirms centre far more precisely than `imports` proxy; high
`instability` (fanOut-dominated) → coupling SOURCE, high fanIn → coupling SINK.
**Remediation:** decouple or stabilize interface; freeze signature.

### Bug attractor

**Signature:** `churn ↑ + bugFixRate ↑ + imports ↓` (codegraph: `fanIn ↓`)
**What it is:** Broken abstraction. High fix-rate + low fan-in → bugs originate
here, don't propagate from elsewhere. Single file misbehaves. **Remediation:**
redesign the abstraction, not patch another fix.

### Blast-radius hub (codegraph)

**Signature:**
`isHub / fanIn ↑ + transitiveImpact ↑ + (churn ↑ or bugFixRate ↑)` **What it
is:** High-fan-in backbone that ALSO carries git risk — worst combo,
fault/change propagates to every dependent (wide `transitiveImpact`). Distinct
from clean hub (high fanIn, healthy git = stable backbone, NOT risk). The
escalation the risk-assessment structural amplifier surfaces. **Remediation:**
harden + freeze interface, add regression net before touching; treat changes as
high-blast.

### Cyclic coupling (codegraph)

**Signature:** member of an SCC from `find_cycles` (file or method scope).
**What it is:** Two+ units mutually depend, directly or transitively — none
understood/tested/replaced in isolation. Invisible to churn/ownership signals.
Cross-boundary cycles (one member in a domain, one outside) most damaging.
**Remediation:** break loop at weakest edge (often found via `get_callers` on a
cycle member); introduce interface seam or invert one dependency.

### Toxic silo

_For low-churn silo with bug-history, see Fragile silo below._

**Signature:**
`blameDominantAuthorPct silo+ + bugFixRate ↑ + (churn ↑ or age ↑)` **What it
is:** One author owns live lines of volatile/fragile code. Bus factor + quality
risk combined. Must be `blame*`, not `recent*` — recent-only mono author may be
feature-in-progress, not silo. **Remediation:** pair rotation, knowledge
transfer, or splitting ownership.

### Fragile silo

**Signature:**
`blameDominantAuthorPct silo+ + bugFixRate concerning+ + churn typical/low + ageDays typical/recent`

**What it is:** Stable-looking, low-churn module owned by single author whose
commit history is dominated by bug fixes. Distinct from Toxic silo (requires
high churn or legacy age) and Fragile legacy (requires high age). Doesn't look
like a hotspot — not touched recently — but every historical commit was a
regression fix. Often a domain-edge component (calculation, invariant
enforcement, data conversion) where each defect is subtle and the silo owner
alone knows the invariants.

**Remediation:**

- Regression-suite hardening on the silo owner's invariants before any change.
- Pair review on touch — the silo owner co-reviews any external change.
- NOT merge coordination (no merge contention — file is calm).
- NOT strangler rewrite (no legacy debt — file is recent).

**Disambiguators:**

- **Confidence-clamped label suppresses small-N matches automatically.** When
  unified `stats.confidence` mechanism active, `bugFixRate.label` for files with
  `commitCount < 5` clamped to `healthy`, `< 10` to `concerning`. Noise-only
  file (e.g. 2 fix commits of 3) does NOT satisfy the `bugFixRate concerning+`
  floor — gets `healthy`, falls out of Fragile silo. Correct: real risk tier
  requires structural evidence, not small-N noise.
- **Edge band `commitCount` 5..9.** Raw `bugFixRate` ≥ critical threshold
  clamped to `concerning`, which DOES match. Mark such classifications "moderate
  confidence" in risk reports.
- **If reading raw values not labels:** apply anti-pattern #8 (class-level
  small-N rule). Don't conclude "Fragile silo" from raw `value: 63%` alone if
  `commitCount < 5`.
- **Upgrade paths:** if `bugFixRate concerning+` AND `commitCount high+` →
  upgrade to **Bug attractor** when `imports ↓`, or **Toxic silo** when churn
  rises with it.

Discover Fragile silo files via search: `Fragile Silo discovery` recipe in
`use-cases.md`.

### Healthy owner

**Signature:**
`blameDominantAuthorPct silo+ + churn ↓ + age ↑ + bugFixRate=healthy` **What it
is:** Mature component; maintainer authored the live code. Low change rate +
clean fix history → owner got design right, it's stable. NOT a risk.
**Remediation:** none. Preserve as-is. (Even better signal:
`recentContributorCount` low or zero — owner nominally responsible but code
dormant.)

### Legacy minefield

**Signature:** `age ↑ + churn ↑ + bugFixRate ↑` **What it is:** Old code that
won't stabilize. Every touch risks regression. Different from tech debt — active
instability, not static debt. **Remediation:** strangler-pattern rewrite.

### Fragile legacy

**Signature:** `age ↑ + bugFixRate ↑ + churn ≈ typical` **What it is:** Old code
that mostly works but breaks when touched. Knowledge evaporated.
**Remediation:** defer changes; document invariants before touching.

_For recent code with similar bug-history signature, see Fragile silo._

### Feature-in-progress

**Signature:**
`churn ↑ + recentDominantAuthorPct ↑ + age ↓ + bugFixRate=healthy + imports ↓`
**What it is:** New feature under active build. Extreme churn expected. NOT a
risk. Usually one recent developer, low fan-in (not yet integrated). Read via
`recent*` (commit activity), not `blame*` — for new code they coincide, but
conceptual signal is "active solo work", not "silo ownership of mature code".
**Remediation:** none; revisit after stabilization.

### Boilerplate churn

**Signature:**
`churn ↑ + bugFixRate=healthy + imports low + path ~ dto/schema/generated`
**What it is:** DTO, schema, mapping, or generated-like file. Commits accumulate
because every feature adds a field. High churn is cosmetic, not structural. No
single git signal detects this — use path heuristic + healthy bugFixRate + low
fan-in. **Remediation:** consider code generation; otherwise ignore.

### Emerging coupling zone

**Signature:**
`age ↓ + churn ↑ + recentContributorCount ↑ + imports ↑ (growing)` **What it
is:** Young file already imported widely and edited by many. Early signal of god
module forming. Easier to fix now than later. **Remediation:** split before it
crystallizes.

### Dead / dormant code

**Signature:**
`age ↑ + churn ≈ 0 + blameContributorCount = 1 + recentContributorCount = 0 + imports ≈ 0`
**What it is:** Code nobody touches, nobody imports. Original author nominally
owns lines but no recent commits. Silo signal here meaningless — nothing depends
on this knowledge. **Remediation:** verify fan-in, then delete.

### Shared infrastructure

**Signature:**
`churn ↑ + recentContributorCount ↑ + blameContributorCount ↑ + imports ↑ + bugFixRate=typical + pathRisk=shared (e.g., adapters/, core/)`
**What it is:** Infrastructure seam (HTTP client, DB adapter, config). Naturally
high fan-in and cross-team churn (historically and recently). Overlaps god
module but bugFixRate stays healthy — code is mostly mechanical.
**Remediation:** review process and ownership rotation, not redesign.

## Interpretation anti-patterns

Agents consistently make these mistakes reading overlay:

1. **"high churn = active development"** — wrong. Could be coupling, attractor,
   boilerplate, legacy thrash, or real development. Check `imports`, `ageDays`,
   `bugFixRate`, `blockPenalty` before deciding.
2. **"mono ownership = problem"** — wrong. Healthy owner of stable mature code
   is a strength. Toxic only when paired with instability. **Always read mono
   ownership via `blame*`** (live-line) — `recentDominantAuthorPct` mono is just
   "active sole committer", could be feature-in-progress, not silo.
3. **"high age = legacy to rewrite"** — wrong. Old + low churn = proven. Old +
   high churn = minefield. Age inverts on churn.
4. **"high fan-in = god module"** — incomplete. High `imports` on stable
   contract (types, errors) with low churn = healthy foundation, not god module.
   Coupling problem requires `imports ↑ + churn ↑`.
5. **"bugFixRate concerning = bug magnet"** — incomplete. With `imports ↓` → bug
   attractor (local problem). With `imports ↑` → coupling spreading bugs
   downstream (different remediation).
6. **Forcing a single classification.** Real code often shows hybrid patterns
   (e.g., god module also emerging legacy). Report both when overlay supports
   it.
7. **Concluding from one signal.** Only one strong signal, rest typical/missing
   → insufficient evidence. Say so instead of guessing a class.
8. **"label severity = signal severity"** — incomplete when signal declares a
   `stats.confidence` block. Any signal whose descriptor names a `support`
   sibling (`bugFixRate → commitCount`,
   `blameDominantAuthorPct → blameContributorCount`, etc.) is a ratio/aggregate
   whose reliability depends on that sibling. When `support` is low, label and
   raw value mean **less** than identical values with high support —
   small-sample noise looks like structural signal.

   Concrete: `commitCount=3` with 2 fix commits → `bugFixRate = 67%`, looks
   identical to `200/300 = 67%`. First is noise; second is structural. Overlay's
   label is auto-clamped to less-severe bin when `support` is below descriptor's
   threshold (clamping in reranker overlay path), but reading raw `value`
   directly → apply this rule yourself.

   **How to read confidence-aware signals:**
   - **Always pair the signal's label with its `support` sibling's label.** If
     `support` is `low` or below stated thresholds → treat value/label as
     suggestive only. Use to _ask_ "worth a closer look?", not to conclude.
   - **`support` typical+ → trust the label.** Structural fix left label as-is —
     sample large enough.
   - **Discoverability:** per-signal `confidence` block published via
     index-metrics resource — `support` field name + threshold rules
     introspectable. Don't guess; look up.

   Examples of confidence-aware signals (set will grow): `bugFixRate` (support
   `commitCount`). Full authoritative set = union of raw signal descriptors
   carrying `stats.confidence`.

## Custom rerank weights for architectural queries

No preset fits → build custom weights. Examples:

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

Prioritizes fan-in. Negative `ownership` surfaces diffuse-ownership files — many
live-line owners, classic god module. Pair `recentActivityConcentration` negated
for "actively edited by many right now":

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

Both lean on `ownership` (blame-based). For active-sole-committer flavor of
feature-in-progress, swap in `recentActivityConcentration`.

### Bug attractor (excluding coupling)

```json
{ "custom": { "bugFix": 0.5, "churn": 0.3, "imports": -0.2 } }
```

Negative weight on imports suppresses coupling points.

### Emerging coupling (early warning)

```json
{ "custom": { "imports": 0.4, "churn": 0.3, "recency": 0.3 } }
```

Surfaces young files already widely imported.

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

High `ownership` (one person still owns lines) + low recent concentration (many
committing now) + active churn → handoff zone where new contributors take over a
previously-siloed module. Useful for routing mentorship/review pairings.

## Limitations

1. **Line drift.** `bugFixRate` at chunk level approximate — git blame drifts
   across renames/reformats. Use file-level bugFixRate for exact numbers;
   chunk-level for relative ranking.
2. **Alpha-blending masks layers.** Derived signals blend file and chunk
   (`effective = alpha*chunk + (1-alpha)*file`). Architectural analysis
   sometimes needs raw `payload.git.file.*` WITHOUT blending — e.g., fan-in as
   file property, not chunk-mixed. Request `metaOnly=false`, read raw payload
   directly.
3. **Overlay masking.** Each preset curates a signal subset via `overlayMask`.
   `imports` absent from overlay → preset chose not to surface it, NOT that file
   has no imports. Switch preset or use custom rerank with explicit weight keys
   (weighted signals appear in overlay automatically).
4. **Single-snapshot bias.** All signals reflect a single index build. Rapidly
   evolving files (feature branches) may show churn from merged history, not
   live activity.

## Workflow

Interpreting any multi-signal overlay:

1. **List strong signals** (level `high+` or `concerning+` in labelMap terms).
2. **Look up the pair** in tables above. Start with highest-level signal.
3. **Check the disambiguator** named in the relevant rule (usually `imports`,
   `bugFixRate`, or `ageDays`).
4. **Pick one or two patterns** from catalog. Hybrid allowed.
5. **If only one signal strong** → report insufficient evidence, do not
   classify.
6. **If overlay missing a disambiguator** → switch preset or add custom weight
   to surface it; do not guess.
