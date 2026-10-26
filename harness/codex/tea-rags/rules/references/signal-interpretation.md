# Signal Interpretation

Read ranking overlay architecturally. Single signal ambiguous — combos reveal
meaning.

## Core thesis

**A signal is a gradient, not a diagnosis.**

One high signal → _something happening_, never _what_. Churn alone ≠ "active
development"; age alone ≠ "legacy"; ownership alone ≠ "silo". Meaning only from
pairs/triples. Reranker = ranking; this file = interpretation. Consult before
concluding from overlay.

## Signal reference

Catalog + definitions: weight keys → `tea-rags://guide/signals`; labels +
resolution → `tea-rags://guide/signal-labels`; this project's bands →
`tea-rags://project/<alias>/metrics?section=labelMap&language=<lang>`. Below:
interpretation notes only.

### Git signals (payload.git.file._ / payload.git.chunk._)

Two ownership families — different questions:

| Family    | Source                             | Question it answers                        |
| --------- | ---------------------------------- | ------------------------------------------ |
| `recent*` | Commit history (configured window) | _Who has been committing here lately?_     |
| `blame*`  | `git blame HEAD` (current code)    | _Who owns the lines that exist right now?_ |

- `ageDays` — CANONICAL = overlay value, `age`/`recency` rerank, ageDays
  presets: query-time `now − lastModifiedAt`, never stale. Raw payload key
  `git.{file,chunk}.ageDays` = enrichment-time stamp (raw-filter escape hatch;
  frozen; `0` = < 1 day then, not "no data"; absent = no data). Chunk stamp
  absent where chunk walk found no commit.
- `recentDominantAuthorPct` label `solo` = exactly one recent committer (100% by
  construction) — NOT bus-factor finding; ownership → `blameDominantAuthorPct`.
  Band labels grade multi-committer files only.
- `recentDominantAuthor` / `blameDominantAuthor` (string) and `recentAuthors` /
  `blameAuthors` (top-N list) = file-level only.
- `knowledgeSilo` (derived, `blame`): 1 owner=1.0, 2=0.5, 3+=0 — silo = sole
  owner of LIVE code, NOT sole recent committer.
- `ownership` (derived, `blame`) → `rerank: "ownership"`;
  `recentActivityConcentration` (derived, `recent`) → same-name rerank.
- `blockPenalty` = **data-quality penalty** for block chunks lacking chunk git
  data (alpha confidence) — NOT boilerplate/DTO indicator.

### Structural signals

- `imports` = fan-in PROXY (raw import-line count) — critical disambiguator for
  churn patterns; without it god module ≡ bug attractor.
- `pathRisk` = path-based risk (`adapters/`, `legacy/`, …).

#### Codegraph signals (only when codegraph is active)

Present only with codegraph on (graph tools — `get_callers`, `trace_path`, … —
in tool list; unsure → `tea-rags://project/<alias>/metrics?section=registry`
shows `codegraph on|off`). Real edges **supersede `imports` proxy** — `imports`
counts import lines, `fanIn` counts graph edges. Keys: `fanIn` / `fanOut`
(file/chunk), `isHub`, `instability` (`fanOut / (fanIn + fanOut)`),
`connectionCount` (`fanIn + fanOut`, confidence support for `instability`),
`transitiveImpact` (systemic blast radius beyond 1 hop), `pageRank` (chunk),
cycle membership (SCC via `find_cycles`, file/chunk).

Codegraph off → fall back to `imports` proxy, say structural centrality
approximate (`tea-rags://guide/navigation` "Graph navigation").

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

**Filtering the search to one person** (vs reading the overlay) → typed params,
not raw signal filters: `author` = blame owner ("whose code is this" / bus
factor), `recentAuthor` = dominant recent committer ("what did X work on" → +
`modifiedAfter`), `contributor` = everything they touched. Same blame/recent
split as above. Intent map: `$filter-building`.

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

**Disambiguation rule for high age:** age inverts meaning on churn. Old + low
churn = don't touch; old + high churn = must rewrite.

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
- **Legacy minefield** (file): method with highest `chunk.bugFixRate` +
  `chunk.relativeChurn` = actual minefield; rest of file rewritable piecemeal.
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
problem per se — architectural coupling problem. **Codegraph:** real `fanIn` /
`isHub` confirms centre far more precisely than `imports` proxy; high
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

**What it is:** Stable-looking low-churn module, single owner, history dominated
by bug fixes. ≠ Toxic silo (needs high churn or legacy age), ≠ Fragile legacy
(needs high age). Not a hotspot — calm — yet every past commit = regression fix.
Often domain-edge component (calculation, invariant enforcement, data
conversion): subtle defects, only owner knows invariants.

**Remediation:**

- Regression-suite hardening on the silo owner's invariants before any change.
- Pair review on touch — the silo owner co-reviews any external change.
- NOT merge coordination (no merge contention — file is calm).
- NOT strangler rewrite (no legacy debt — file is recent).

**Disambiguators:**

- **Confidence clamp suppresses small-N automatically.** `bugFixRate` overlay
  label capped by SAME-scope `commitCount` (file label ← `git.file.commitCount`,
  chunk ← `git.chunk.commitCount`) vs ADAPTIVE cut-offs = collection p10 / p25
  of that `commitCount`, read at query time. Below p10 → max `healthy`; below
  p25 → max `concerning`. Fixed `5` / `10` = cold-start fallbacks only (index
  lacks percentile) — never assume. Clamp only lowers, never raises; raw `value`
  unclamped. Noise file (2 fixes of 3 commits) below p10 → `healthy` → not
  Fragile silo. Correct: risk tier needs structural evidence, not small-N noise.
- **Edge band `commitCount` p10..p25.** Raw `bugFixRate` ≥ critical threshold
  clamped to `concerning`, which DOES match. Mark such classifications "moderate
  confidence" in risk reports.
- **If reading raw values not labels:** apply anti-pattern #8 (class-level
  small-N rule). No "Fragile silo" from raw `value: 63%` alone when
  `commitCount` sibling labelled `low`.
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

Common overlay misreads:

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
8. **"label severity = signal severity"** — incomplete when signal declares
   `stats.confidence`. Signal naming a `support` sibling
   (`bugFixRate → commitCount`, `instability → connectionCount`) = ratio whose
   reliability depends on sibling. Low `support` → label + raw value mean
   **less** — small-sample noise mimics structure.

   `commitCount=3`, 2 fixes → `bugFixRate = 67%` ≡ `200/300 = 67%`. First noise,
   second structural. Overlay label auto-clamped to less-severe bin below
   threshold; reading raw `value` → apply rule yourself.

   **How to read confidence-aware signals:**
   - **Always pair label with `support` sibling's label.** `support` `low` →
     suggestive only: _ask_ "worth closer look?", never conclude.
   - **`support` typical+ → trust label.**
   - Support thresholds = collection p10 / p25 of sibling (see Fragile silo
     disambiguators) — never assume fixed numbers.

   Confidence-aware set = raw descriptors carrying `stats.confidence` (e.g.
   `bugFixRate`).

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

1. **Line drift.** Chunk `bugFixRate` approximate — blame drifts across
   renames/reformats. Exact numbers → file level; chunk → relative ranking.
2. **Alpha-blending masks layers.** Derived signals blend
   (`effective = alpha*chunk + (1-alpha)*file`). Need raw `payload.git.file.*`
   unblended (e.g. fan-in as file property) → `metaOnly=false`, read raw
   payload.
3. **Overlay masking.** Preset curates subset via `overlayMask`. `imports`
   absent → preset didn't surface it, NOT zero imports. Switch preset or custom
   rerank (weighted signals appear in overlay automatically).
4. **Single-snapshot bias.** Signals = one index build. Fast-moving files
   (feature branches) may show merged-history churn, not live activity.

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
