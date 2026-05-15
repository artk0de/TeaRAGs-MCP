# Unified Signal Confidence — Design Spec (label clamp + score dampening)

## Goal

Introduce a **single `confidence` declaration** on each raw payload signal that
drives BOTH:

- **Score-side continuous dampening** — replacing today's hardcoded
  `dampeningSource` constants and `FALLBACK_THRESHOLD` fields scattered across
  derived signal classes (`BugFixSignal` and any future confidence-aware derived
  signal).
- **Label-side categorical clamp** — new functionality that fixes the user's
  reported failure mode where `bugFixRate: { value: 63, label: "critical" }` is
  presented to the agent with `commitCount=3`.

One source of truth per signal: "I am unreliable when sibling X is low. Here's
how score-side and label-side should respond."

First applied to `bugFixRate`. After this spec ships, other small-N-sensitive
signals (`churnVolatility`, `relativeChurn`, `recencyWeightedFreq`,
`blameDominantAuthorPct`, `recentDominantAuthorPct`, chunk-scope equivalents)
opt in via a **one-line descriptor addition** — no infrastructure changes, no
per-signal class edits.

## Problem

Two facets of one underlying issue: `bugFixRate` is statistically unreliable
when `commitCount` is small, and the system currently handles this
**asymmetrically**.

### Facet 1: Score-side dampening exists but is declared awkwardly

`BugFixSignal.extract`
(`src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.ts:22-29`)
applies confidence dampening for **ranking**:

```ts
const k = ctx?.dampeningThreshold ?? BugFixSignal.FALLBACK_THRESHOLD;
value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
```

The fact "support for `bugFixRate` is `commitCount` at file scope, dampen with
threshold `k=10`" is hardcoded across THREE places:

- `BugFixSignal.dampeningSource = GIT_FILE_DAMPENING` (constant)
- `BugFixSignal.FALLBACK_THRESHOLD = 10` (private static)
- `GIT_FILE_DAMPENING` constant in `helpers.ts` resolving to `commitCount`

Adding a second confidence-aware derived signal duplicates this scattering.

### Facet 2: Label-side is not dampened at all

Label resolution (`src/core/domains/explore/label-resolver.ts:11`, called from
`reranker.ts:462`):

```ts
const label = resolveLabel(
  value,
  descriptor.stats.labels,
  signalStats.percentiles,
);
```

`resolveLabel` sees only `value` and percentile thresholds. No access to
`commitCount`. It bins `63%` as `"critical"` regardless of sample size.

### Combined failure mode

Agent sees in overlay:

```
bugFixRate:  { value: 63, label: "critical" }
commitCount: { value: 3,  label: "typical"  }
```

— and over-weights the bug signal. The score-side dampening is invisible to the
agent (it only affects internal ranking). The label is what the agent reads.

The fix needs to address **both facets** AND collapse the two ways of declaring
"confidence depends on sibling X" into one descriptor.

## Design Decisions

### D1: One `confidence` block per raw signal descriptor

The unified declaration lives on **PayloadSignalDescriptor**
(`payload-signals.ts`) — confidence is a property of the **raw signal** (the
source of statistical noise), not of derived computations or label resolvers.
Both consumers (derived signal score path, label resolver) read the same
declaration.

```ts
export interface SignalConfidence {
  support: string; // bare sibling name, same-scope
  score?: { threshold: number }; // optional continuous dampening
  label?: { rules: ConfidenceClampRule[] }; // optional categorical clamp
}

export interface ConfidenceClampRule {
  whenSupportBelow: number;
  ceiling: string; // must exist in stats.labels
}
```

Either sub-block (`score` or `label`) can be absent — `confidence` declares the
support; what to do with it is opt-in per consumer.

### D1b: Universal mechanism, scoped initial application

The mechanism is generic; this spec applies it to `bugFixRate` (file + chunk
scope) only. Other small-N-sensitive signals (`churnVolatility`,
`relativeChurn`, `recencyWeightedFreq`, `blameDominantAuthorPct`,
`recentDominantAuthorPct`) opt in via a descriptor addition — each is a
follow-up evidence-driven decision.

### D2: Label ceiling clamp, not full re-binning

```
If commitCount <  5  → label ceiling = "healthy"   (binned label is min(actual, "healthy"))
If commitCount <  10 → label ceiling = "concerning"
Otherwise            → unchanged
```

Examples:

| `bugFixRate` | `commitCount` | Pre-fix label | Post-fix label  |
| ------------ | ------------- | ------------- | --------------- |
| 63           | 3             | critical      | typical         |
| 63           | 8             | critical      | concerning      |
| 63           | 50            | critical      | critical        |
| 30           | 4             | concerning    | typical         |
| 12           | 2             | healthy       | healthy (no-op) |

Raw `value` is preserved in overlay; only `label` shifts. The agent still sees
`63%` but the label tells it the binning was capped due to small N.

### D3: Generic `LabelContext` with sibling values

**File:** `src/core/domains/explore/label-resolver.ts`

`resolveLabel` gains an optional context carrying sibling raw signal values plus
the resolved descriptor (so the resolver can read declarative clamp rules from
it):

```ts
export interface LabelContext {
  siblingValues?: Record<string, number>;
  descriptor?: { stats?: SignalStatsWithClamp };
}

export function resolveLabel(
  value: number,
  labels: Record<string, string>,
  percentiles: Record<string, number>,
  ctx?: LabelContext,
): string;
```

Callers that pass no `ctx` get current behavior. Callers that pass `ctx` but
whose descriptor declares no `confidenceClamp` also get current behavior. Clamp
is opt-in per descriptor.

### D4: Reranker builds scope-aware sibling map

**File:** `src/core/domains/explore/reranker.ts:462` (approximate)

When resolving labels, reranker builds a numeric sibling map at the **same
scope** as the signal being labeled (file or chunk), passes it plus the
descriptor:

```ts
const siblingValues = collectNumericSiblings(rawSignals, scope);
const label = resolveLabel(
  value,
  descriptor.stats.labels,
  signalStats.percentiles,
  {
    siblingValues,
    descriptor,
  },
);
```

`collectNumericSiblings` extracts numeric raw signals from `rawSignals` at the
matching scope only. Out-of-scope reads (e.g. file-scope `commitCount` for
clamping chunk-scope `bugFixRate.label`) — explicitly not supported in this
spec; a follow-up can introduce dotted-form (`"file.commitCount"`) if
cross-scope clamping becomes a real need.

### D5: `bugFixRate` opt-in to unified `confidence` block

**File:** `src/core/contracts/types/trajectory.ts` (interface extension) and
`src/core/domains/trajectory/git/payload-signals.ts` (bugFixRate opt-in).

`SignalStatsRequest` (existing) gains an optional `confidence` sibling defined
in D1 above. `bugFixRate` descriptors declare both score and label paths:

```ts
{
  key: "git.file.bugFixRate",
  stats: {
    labels: { p50: "healthy", p75: "concerning", p95: "critical" },
    confidence: {
      support: "commitCount",
      score: { threshold: 10 },              // replaces FALLBACK_THRESHOLD
      label: {
        rules: [
          { whenSupportBelow: 5,  ceiling: "healthy"    },
          { whenSupportBelow: 10, ceiling: "concerning" },
        ],
      },
    },
  },
}
```

Same struct on `git.chunk.bugFixRate` — `support: "commitCount"` is bare and
resolves to `chunk.commitCount` because that's the scope of the descriptor (D4
scope convention).

**Label-resolver algorithm** (in `resolveLabel`):

1. Compute base label via percentile binning (current behavior).
2. If `descriptor.stats.confidence?.label` is undefined → return base.
3. Read `support = ctx.siblingValues[confidence.support]`. If undefined → return
   base (cannot apply confidence without support).
4. Walk `confidence.label.rules` ascending by `whenSupportBelow`. For the first
   matching rule (`support < rule.whenSupportBelow`), take `rule.ceiling`.
   Compare to base label via label-ordering derived from `labels` percentile
   keys (lower percentile = less severe). Return the less-severe of {base,
   ceiling}.

**Score-path consumer** (D8 below) reads `confidence.support` +
`confidence.score.threshold` from the same descriptor and passes them into
`ExtractContext.dampeningThreshold` for derived signal extraction.

**Why struct, not function:** serializable (published via MCP resource so agents
see clamp rules alongside labelMap), introspectable (`get_index_metrics` can
list clamp rules), documentable (auto-generate tables for
`signal-interpretation.md`), validatable (Zod enforces
`ceiling ∈ Object.values(labels)` and `support ∈ peer signal keys` at
descriptor-load time). A function variant loses all four properties for
flexibility that none of the six candidate signals need.

### D8: Migrate score-side dampening to read from `confidence` block

**Files:**

- `src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.ts`
- `src/core/domains/trajectory/git/rerank/derived-signals/helpers.ts`
  (`GIT_FILE_DAMPENING` constant becomes legacy or is removed)
- `src/core/domains/explore/reranker.ts` (constructs `ExtractContext` with
  values from raw descriptor's `confidence.score`)

Today `BugFixSignal` carries the dampening configuration on the derived-signal
class:

```ts
readonly dampeningSource = GIT_FILE_DAMPENING;
private static readonly FALLBACK_THRESHOLD = 10;
extract(rawSignals, ctx) {
  const k = ctx?.dampeningThreshold ?? BugFixSignal.FALLBACK_THRESHOLD;
  value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
}
```

After this spec:

```ts
// BugFixSignal becomes self-contained derived-signal logic;
// confidence parameters arrive via ExtractContext from raw descriptor.
extract(rawSignals, ctx) {
  if (ctx?.confidence) {
    const supportValue = readSibling(rawSignals, ctx.confidence.support, ctx.scope);
    value *= confidenceDampening(supportValue, ctx.confidence.score.threshold);
  }
}
```

`dampeningSource` constant and `FALLBACK_THRESHOLD` removed from `BugFixSignal`.
Reranker, when extracting a derived signal whose raw source carries
`stats.confidence.score`, populates `ExtractContext` with
`{ support, threshold }` and `scope` so `extract` can find the right sibling
value.

**Acceptance:** numerically identical score output for `bugFix` derived signal
before and after this refactor (same `commitCount`, same `bugFixRate`, same
`k=10` → same dampened value). Refactor is structural, not behavioral.

**If other derived signals currently use `confidenceDampening`** (plan stage
will enumerate) — they migrate in the same change. The migration is mechanical:
remove `dampeningSource` constant + `FALLBACK_THRESHOLD` from the derived class;
add `confidence.score` to the corresponding raw descriptor in
`payload-signals.ts`. If migration of additional signals turns out to be
non-trivial, the score-side refactor is split into a follow-up spec and this
spec keeps only `BugFixSignal` + the new mechanism — never leaving the system in
a "two declarations for one fact" state for non-bugFixRate signals.

### D6: Backwards compatibility

- `LabelContext` is optional in `resolveLabel`. Existing callers compile
  unchanged.
- No payload schema change — `commitCount` and `bugFixRate` are already in
  payload. No reindex required.
- No `get_index_metrics` API change — `labelMap` still describes percentile
  thresholds; the clamp is a **runtime** projection, not a different binning
  scheme.

### D7: `get_index_metrics` documentation

**File:** `.claude-plugin/tea-rags/rules/references/signal-interpretation.md`
(metrics section, brief one-liner) and `src/mcp/resources/registry.ts` (labelMap
docs):

State that `bugFixRate.label` in overlay is clamped when `commitCount` is below
project thresholds. `get_index_metrics` labelMap shows the percentile
thresholds; clamping is overlay-side. This is documentation only, not code, and
doubles as the rationale link from spec 4 (anti-pattern doc).

## Out of Scope

- Opt-in for other signals: the mechanism supports them, but this spec adds
  `confidenceClamp` only to `bugFixRate`. Follow-up candidates and their
  probable `supportSignal`:

  | Signal                           | Support                  | Why small-N hurts label                        |
  | -------------------------------- | ------------------------ | ---------------------------------------------- |
  | `churnVolatility`                | `commitCount`            | timing variance noisy with ≤2 commits          |
  | `recencyWeightedFreq`            | `commitCount`            | weighted decay degenerate at N=1               |
  | `relativeChurn`                  | `commitCount`            | churn/size unstable when one commit dominates  |
  | `blameDominantAuthorPct`         | `blameContributorCount`  | 100% over 1 owner ≠ "silo", just "only author" |
  | `recentDominantAuthorPct`        | `recentContributorCount` | analogous for recent activity                  |
  | chunk-scope equivalents of above | chunk-scope siblings     | smaller sample sizes amplify same failure      |

  Each = one-line `confidenceClamp` block in descriptor when evidence warrants.
  Not blanket-applied in this spec to keep the change reviewable.

- **Cross-scope clamping** — clamping chunk-scope label by file-scope support
  (or vice versa). `supportSignal` is bare-name same-scope only. If a future
  need surfaces (e.g. very small chunks where file-scope `commitCount` is the
  more reliable support), introduce dotted-form (`"file.commitCount"`) as a
  separate spec.

- **Per-language clamp thresholds** — `5/10` for `bugFixRate` is global. If
  Python/Ruby projects show consistent miss-clamping, revisit with
  language-aware thresholds.

- **UI marker on clamped labels** (e.g., `"typical_clamped"` or a
  `clamped: true` overlay field) — current decision: clamp transparently to
  existing label vocabulary. Agent reads the same labels, no new vocabulary to
  learn. Reconsider if evidence shows agents need to distinguish clamped from
  natural labels.

- **Continuous (not categorical) confidence** — score-side `confidenceDampening`
  is continuous (multiplier in [0, 1]). Label-side `confidenceClamp` is
  categorical (ceiling). Different abstractions for different consumers (ranker
  vs agent overlay).

## Acceptance Criteria

1. `SignalConfidence` + `ConfidenceClampRule` types exported from
   `contracts/types/trajectory.ts`; Zod schema validates that `support` resolves
   to an existing peer signal at the descriptor's scope and that every `ceiling`
   ∈ `Object.values(stats.labels)`.
2. `git.file.bugFixRate` and `git.chunk.bugFixRate` descriptors declare the
   unified `confidence` block with `support: "commitCount"`,
   `score.threshold: 10`, and label rules
   `[{ <5 → typical }, { <10 → concerning }]`.
3. **Score-side refactor (D8):** `BugFixSignal` no longer carries
   `dampeningSource` or `FALLBACK_THRESHOLD`. `confidenceDampening` is invoked
   using parameters delivered via `ExtractContext` from the raw descriptor's
   `confidence.score`. Numerically identical score output verified by
   snapshot/regression test on a representative payload.
4. **Label-side resolver (D3, D4, D5):** `LabelContext` accepted by
   `resolveLabel`; reranker builds scope-aware sibling map; resolver handles (a)
   no `confidence.label` → no-op, (b) missing support → no-op, (c) value below
   first threshold → ceiling applied, (d) ceiling never raises severity.
5. Unit tests for label resolver: `commitCount<5` clamps `bugFixRate` to
   `typical`; `<10` to `concerning`; `>=10` no-op; raw `value` preserved across
   all cases.
6. Unit tests for mechanism genericity: a synthetic descriptor with
   `support: "fooCount"` and arbitrary rules behaves identically to
   `bugFixRate`-specific behavior — both score path and label path.
7. The user's trigger case (`bugFixRate=63, commitCount=3`) now emits
   `{ value: 63, label: "healthy" }` in overlay AND `bugFix` derived score is
   dampened to the same value as before the refactor.
8. No payload migration, no `get_index_metrics` API contract change, no reindex
   required.
9. `confidence` block may be exposed via an MCP resource for agent introspection
   — decision deferred to follow-up; not blocking this spec.
10. If non-`BugFixSignal` derived signals currently use `confidenceDampening`,
    they are either migrated in this spec or explicitly split off with a
    tracking note — the system MUST NOT ship with both old (`dampeningSource`)
    and new (`confidence.score`) mechanisms coexisting for the same signal.

## Plugin Version Bump

None. This spec touches `src/`. The documentation cross-reference in
`signal-interpretation.md` (D7) is the only `.claude-plugin/` touch and goes in
the dependent spec (`small-n-bugfixrate-anti-pattern-design.md`).

## Effort

~2 days, broken down:

- **~1 day** — universal mechanism implementation (types, Zod, label resolver +
  tests, descriptor opt-in for `bugFixRate`).
- **~1 day** — score-side migration (D8): refactor `BugFixSignal`, update
  reranker to populate `ExtractContext.confidence` from raw descriptor,
  regression test for numerical equivalence, audit other derived signals for
  `confidenceDampening` usage.

If the audit in D8 finds more than one or two extra signals using
`confidenceDampening` and each requires non-trivial migration, the
non-`BugFixSignal` score-side migrations split off into a follow-up spec (still
adopting the new mechanism, not introducing a divergent path). Worst-case effort
stays at 2 days for this spec.

## Risks

- **Risk:** Clamp at chunk scope reads chunk-level `commitCount` (often same as
  file-level for small files but diverges for hotspot chunks in large files).
  Decision: use chunk-scope `commitCount` when clamping chunk-scope
  `bugFixRate.label`, file-scope when clamping file-scope.
- **Risk:** Some agents rely on `"critical"` as a hard trigger word. Mitigation:
  the clamp **reduces** label severity, never increases it, so any agent
  treating `critical` as a flag misses a clamped case (correctly — small-N is
  not flag-worthy).
