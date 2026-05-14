# bugFixRate Label Confidence — Design Spec

## Goal

Make `bugFixRate.label` aware of `commitCount` so a 63% ratio over 3 commits
does not get the same `"critical"` label as 63% over 300 commits. Raw `value`
stays honest; only the bin (label) is clamped. Cuts at the root of the "agent
over-reads small-N bug history" failure mode.

## Problem

`BugFixSignal.extract`
(`src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.ts:22-29`)
already applies confidence dampening for **ranking**:

```ts
value *= confidenceDampening(fileNum(rawSignals, "commitCount"), k);
```

— so the _score contribution_ from a 3-commit file's 63% is properly muted.

But `bugFixRate.label`, attached to the ranking overlay, **is not** dampened.
Label resolution lives in `src/core/domains/explore/label-resolver.ts:11`,
called from `reranker.ts:462`:

```ts
const label = resolveLabel(
  value,
  descriptor.stats.labels,
  signalStats.percentiles,
);
```

`resolveLabel` sees only `value` and percentile thresholds. It has no access to
`commitCount` from the same payload, so it bins `63%` as `"critical"` regardless
of sample size. The label is what the agent reads in overlay; the score-side
dampening is invisible to the agent.

Result: agent sees `bugFixRate: { value: 63, label: "critical" }` next to
`commitCount: { value: 3, label: "typical" }` and over-weights the bug signal —
the exact failure in the user's brainstorm trigger case.

## Design Decisions

### D1: Confidence applies to `bugFixRate` only (scoped fix)

Other signals (`churnVolatility`, `relativeChurn`, `recencyWeightedFreq`) have
their own statistical fragility profiles, but they are out of scope for this
spec. Only `bugFixRate` is fixed. Reason: the failure mode is documented and
reproducible _only_ for `bugFixRate`; expanding scope without measured evidence
violates YAGNI.

### D2: Label ceiling clamp, not full re-binning

```
If commitCount <  5  → label ceiling = "typical"   (binned label is min(actual, "typical"))
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

### D3: Plumb `commitCount` through label resolution

**File:** `src/core/domains/explore/label-resolver.ts`

`resolveLabel` signature gains an optional sibling-signals context:

```ts
export interface LabelContext {
  siblingValues?: Record<string, number>;
  clamp?: (label: string, ctx: LabelContext) => string;
}

export function resolveLabel(
  value: number,
  labels: Record<string, string>,
  percentiles: Record<string, number>,
  ctx?: LabelContext,
): string;
```

`bugFixRate` descriptor declares a `clamp` function in its `stats.labels`
context-aware variant. The clamp reads `ctx.siblingValues?.commitCount` and
demotes the label per D2. Other descriptors pass no `ctx` and get current
behavior.

### D4: Reranker passes sibling values

**File:** `src/core/domains/explore/reranker.ts:462` (approximate)

When resolving labels for a payload, build a sibling map of numeric raw signals
from the same scope (file or chunk) and pass it as `ctx.siblingValues`:

```ts
const siblingValues = collectNumericSiblings(rawSignals, scope);
const label = resolveLabel(
  value,
  descriptor.stats.labels,
  signalStats.percentiles,
  {
    siblingValues,
    clamp: descriptor.stats.labelClamp,
  },
);
```

`collectNumericSiblings` extracts file-scope or chunk-scope numbers depending on
which signal is being labeled. Out-of-scope siblings are not included (e.g.,
file-scope `commitCount` is not used to clamp a chunk-scope `bugFixRate` label —
would need separate clamp logic).

### D5: Declarative clamp in payload-signals descriptors

**File:** `src/core/domains/trajectory/git/payload-signals.ts`

`bugFixRate` descriptor extends `stats` with a `labelClamp`:

```ts
{
  key: "git.file.bugFixRate",
  type: "number",
  description: "Percentage of commits that are bug fixes",
  stats: {
    labels: { p50: "healthy", p75: "concerning", p95: "critical" },
    labelClamp: (label, ctx) => {
      const n = ctx.siblingValues?.commitCount ?? Infinity;
      if (n < 5)  return clampDown(label, "typical");
      if (n < 10) return clampDown(label, "concerning");
      return label;
    },
  },
}
```

`clampDown(label, ceiling)` is a helper that returns the lower-severity of the
two via the descriptor's own label ordering. The same `labelClamp` is applied at
chunk scope reading `chunk.commitCount` instead of file scope — the helper
checks which scope owns the label being resolved.

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

- Clamp logic for `relativeChurn`, `churnVolatility`, `recencyWeightedFreq` →
  separate spec if evidence accumulates.
- Per-language clamp thresholds — `k=5/10` is global. A polyglot-aware clamp can
  be a follow-up if Python or Ruby projects show different small-N
  distributions.
- UI changes to mark clamped labels (e.g., `"typical_clamped"`) — current
  decision: clamp transparently to the existing label vocabulary; agent reads
  the same labels, no new vocabulary to learn.

## Acceptance Criteria

1. `resolveLabel` accepts optional `LabelContext` without breaking existing
   callers.
2. `bugFixRate` descriptor declares `labelClamp`.
3. Reranker passes sibling `commitCount` to `resolveLabel` for `bugFixRate`.
4. Unit tests cover: `commitCount<5` clamps to `typical`, `<10` to `concerning`,
   `>=10` is no-op, value is never mutated.
5. The user's trigger case (`bugFixRate=63, commitCount=3`) now emits
   `label: "typical"` in overlay.
6. No payload migration, no `get_index_metrics` API change, no reindex.

## Plugin Version Bump

None. This spec touches `src/`. The documentation cross-reference in
`signal-interpretation.md` (D7) is the only `.claude-plugin/` touch and goes in
the dependent spec (`small-n-bugfixrate-anti-pattern-design.md`).

## Effort

Half a day. Most work is wiring sibling values through reranker call site and
writing the unit-test matrix for the clamp helper.

## Risks

- **Risk:** Clamp at chunk scope reads chunk-level `commitCount` (often same as
  file-level for small files but diverges for hotspot chunks in large files).
  Decision: use chunk-scope `commitCount` when clamping chunk-scope
  `bugFixRate.label`, file-scope when clamping file-scope.
- **Risk:** Some agents rely on `"critical"` as a hard trigger word. Mitigation:
  the clamp **reduces** label severity, never increases it, so any agent
  treating `critical` as a flag misses a clamped case (correctly — small-N is
  not flag-worthy).
