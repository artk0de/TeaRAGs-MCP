# Codegraph Provider Gating — Design

**Status:** Draft (RFC) **Epic:** `tea-rags-mcp-igk6` **Authors:** Arthur
Korochansky **Date:** 2026-05-21

## Problem

When `codegraph.symbols` enrichment provider is disabled, the MCP client today
would still see:

1. Codegraph-specific tools (`get_callers`, `get_callees`, `find_cycles`) in the
   tool list, but calling them would error or return empty.
2. Composite rerank presets (`entryPoint`, potentially `architecturalHub`) in
   the preset enum, but their codegraph weights would silently contribute 0,
   producing degraded ranking with no signal to the client.
3. Provider-specific presets (`blastRadius`, `fanOutPerLine`) in the preset
   enum, with the same silent-degradation problem.
4. The `pageRank` / codegraph derived signals in the custom-weights schema, so a
   client building a custom rerank could reference them and get zero
   contribution, again silently.

This is a **leaky abstraction** — the MCP surface advertises capabilities the
runtime cannot honour.

## Goal

When the codegraph trajectory is not registered, the MCP surface (`list_tools`,
preset enums in `semantic_search`/`hybrid_search`/`rank_chunks`, custom-weight
schema in `rank_chunks`) **must not advertise** anything that depends on
codegraph signals.

Conversely, when codegraph IS registered, the surface behaves identically to
today.

## Non-goals

- Per-request gating. Gating is decided at composition time. Reloading the
  config requires a process restart (same as today for any trajectory change).
- Partial provider modes. `codegraph.symbols` is one provider — there is no
  "tools-only-no-presets" mode. Either the trajectory is registered or it isn't.
- Backwards-compat with old `codegraph.file.fanIn/fanOut/instability/...`
  signals — those were removed in earlier refactors (`557635b0`, `e3506a67`) and
  the schema-drift monitor already prompts force-reindex.

## Design

### One source of truth: `TrajectoryRegistry.getRegisteredKeys()`

`TrajectoryRegistry` already aggregates payload signals, derived signals,
filters, presets, and enrichment providers per trajectory. It exposes
`has(key: string): boolean` and (after this RFC) `getRegisteredKeys(): string[]`
returning the keys of trajectories that were actually registered in
`composition.ts`. This is the **only** runtime fact the rest of the system
consults; everything else reduces to "is this key in the set?".

### Two preset categories — gated by different mechanisms

The `RerankPreset` base interface stays untouched. Provider-dependency lives in
a separate interface `CompositeRerankPreset` that **only composite presets**
implement. Why split:

- **Provider-specific presets** (e.g. `BlastRadiusPreset`,
  `FanOutPerLinePreset`, every git preset, every static preset) live inside
  their owning trajectory's `rerank/presets/` directory. Their provider
  dependency is **implicit** — the class file is only loaded when the trajectory
  is registered. When `CodegraphTrajectory` is skipped in `composition.ts`, its
  presets never reach `TrajectoryRegistry.getAllPresets()` and the Reranker
  never sees them. No `requires` field needed; no per-preset declaration.

- **Composite presets** (e.g. `EntryPointPreset`, `ArchitecturalHubPreset`) live
  in `domains/explore/rerank/presets/` — outside any single trajectory. They
  blend weights across providers, so their dependency on multiple providers is
  **explicit** — the class itself doesn't belong to any trajectory's
  registration, so we must declare what it needs.

#### Contract

```ts
// contracts/types/reranker.ts — unchanged
interface RerankPreset {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly RerankerTool[];
  readonly weights: ScoringWeights;
  readonly overlayMask: OverlayMask;
  readonly groupBy?: ...;
  readonly signalLevel?: ...;
}

// NEW — only for composite presets that blend cross-provider signals
interface CompositeRerankPreset extends RerankPreset {
  readonly requires: readonly string[]; // trajectory keys, REQUIRED
}
```

Conventions:

- `requires` is **mandatory** on `CompositeRerankPreset` (no optional — every
  composite preset explicitly declares its dependencies).
- Provider-specific presets implement plain `RerankPreset`. They MUST live under
  their owning trajectory's directory. Reviewer enforces.
- Composite presets implement `CompositeRerankPreset`. They MUST live under
  `domains/explore/rerank/presets/`. Reviewer enforces.
- Values in `requires` are **trajectory keys** (e.g. `"git"`, `"static"`,
  `"codegraph.symbols"`), matching the keys `TrajectoryRegistry` registers
  under.

Example: `EntryPointPreset implements CompositeRerankPreset` with
`requires = ["codegraph.symbols", "git"]`.

### Two-layer filter — implicit + explicit

The Reranker assembly does the gating in two layers, both reducing to "is this
trajectory key registered?":

**Layer 1 (implicit) — provider-specific presets.**
`TrajectoryRegistry.getAllPresets()` already returns the union of presets from
registered trajectories. When `CodegraphTrajectory` isn't registered,
`BlastRadiusPreset` / `FanOutPerLinePreset` are never in the union. No code
change needed here — just don't register the trajectory.

**Layer 2 (explicit) — composite presets.** Composite presets aren't owned by
any trajectory, so we filter them by their declared `requires` against
`TrajectoryRegistry.getRegisteredKeys()`:

```ts
const registeredKeys = registry.getRegisteredKeys(); // Set<string>

const providerPresets = registry.getAllPresets(); // Layer 1 — implicit gate
const compositePresets = ALL_COMPOSITE_PRESETS.filter(
  // Layer 2 — explicit gate
  (p) => p.requires.every((k) => registeredKeys.has(k)),
);

this.resolvedPresets = [...providerPresets, ...compositePresets];
```

The `Reranker` constructor accepts the composite-preset list and the registry
(or a `Set<string>` derived from it) via DI. Downstream consumers
(`getPresetNames`, `getDescriptorInfo`, `SchemaBuilder`) read through
`resolvedPresets` and naturally only see what's available. No changes to
`SchemaBuilder` (DIP holds).

For the **custom weights schema**, `getDescriptorInfo()` returns derived signal
descriptors. Same implicit gate: descriptors are sourced from
`TrajectoryRegistry.getAllDerivedSignals()`, which only includes signals from
registered trajectories. Codegraph signals (e.g. `pageRank`, `transitiveImpact`)
disappear from the custom-weights Zod schema automatically when codegraph isn't
registered.

### MCP tool gating: `App.hasProvider`

`App` interface (`api/public/app.ts`) gets one new method:

```ts
hasProvider(key: string): boolean;
```

It delegates to `TrajectoryRegistry.has(key)`. The codegraph tool registrar
self-checks:

```ts
// src/mcp/tools/graph.ts (new file)
export function registerGraphTools(server, deps) {
  if (!deps.app.hasProvider("codegraph.symbols")) return;
  // ... register get_callers, get_callees, find_cycles
}
```

`registerAllTools` calls `registerGraphTools` **unconditionally**; the registrar
itself decides to no-op. This keeps the registration call site uniform and
locates the gating logic next to the tools it gates.

### Config plumbing

Add `config.codegraph.enabled: boolean` (default `true` for back-compat with
current behavior — codegraph is on by default). Surfaced from the
`ENABLE_CODEGRAPH` env var via `bootstrap/factory.ts`. In `composition.ts`:

```ts
if (config.codegraph?.enabled !== false) {
  registry.register(new CodegraphTrajectory(deps));
}
```

When `ENABLE_CODEGRAPH=false`:

1. `CodegraphTrajectory` is not constructed → no DuckDB allocation, no provider
   instantiation, no signal descriptors registered.
2. `registry.getRegisteredKeys()` returns `["git", "static"]` (no codegraph).
3. `Reranker` filters out presets requiring `"codegraph.symbols"`.
4. `app.hasProvider("codegraph.symbols")` returns `false`.
5. `registerGraphTools` no-ops.
6. `SchemaBuilder` regenerates Zod with neither codegraph presets in the preset
   enum nor codegraph derived signals in the custom-weights schema.

The MCP client receives a clean surface: as if codegraph never existed.

## Cascade diagram

```
ENABLE_CODEGRAPH=false
        │
        ▼
config.codegraph.enabled = false
        │
        ▼
composition.ts skips registry.register(CodegraphTrajectory)
        │
        ├──────────────────────────┬──────────────────────┐
        ▼                          ▼                      ▼
Layer 1 (IMPLICIT):           Layer 2 (EXPLICIT):    App.hasProvider:
TrajectoryRegistry           CompositePreset       delegates to
.getAllPresets() omits       filter:               registry.has()
BlastRadius/FanOutPerLine    requires.every(k =>   returns false
.getAllDerivedSignals()      registered.has(k))    for "codegraph.symbols"
omits pageRank etc           — EntryPoint dropped         │
        │                          │                      ▼
        └──────────┬───────────────┘             registerGraphTools no-ops
                   ▼
            Reranker.resolvedPresets =
            [providerPresets ∪ compositePresets]
                   │
                   ▼
            getPresetNames / getDescriptorInfo
                   │
                   ▼
            SchemaBuilder rebuilds Zod
                   │
                   ▼
            MCP `list_tools` clean
            MCP `semantic_search.rerank` enum clean
            MCP `rank_chunks.weights` schema clean
```

## Migration / compatibility

- **Default `enabled=true`** preserves existing behavior. Existing users see no
  change.
- **Disabled mode** is a new affordance, opt-in via env. No data migration.
- **Existing git/static presets** require no `requires` field — backwards
  compatible.

## Risks

| Risk                                                                                                            | Mitigation                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composite preset author forgets to declare a dependency in `requires`                                           | TS type system: `CompositeRerankPreset.requires` is **mandatory**, not optional — compiler refuses an empty implementation. T6 also adds a regression test: every composite preset's `weights` keys must resolve to descriptors owned by trajectories listed in `requires`.                                            |
| Provider-specific preset placed under `domains/explore/rerank/presets/` by mistake (would bypass implicit gate) | Reviewer-enforced — the two preset directories have different semantic, like `dto/` vs `internal/`. T6 adds a structural test: every preset under `trajectory/<X>/rerank/presets/` MUST be `RerankPreset` (NOT `CompositeRerankPreset`); every preset under `explore/rerank/presets/` MUST be `CompositeRerankPreset`. |
| Custom user-supplied weights bypass the schema gate                                                             | `Reranker` scoring path silently no-ops on unknown weight keys (current behavior). The schema gate is the user-facing UX; runtime stays graceful.                                                                                                                                                                      |
| `App.hasProvider` becomes a god-method as more providers gate tools                                             | Bounded — keep it a thin delegate to `TrajectoryRegistry.has`. If gating logic grows complex, move to a `ProviderRegistry` facet of `App`.                                                                                                                                                                             |
| `composition.ts` becomes a config-flag soup                                                                     | Each trajectory registers itself via a single `if (config.X?.enabled)` line. If we cross ~5 trajectories, refactor to a declarative registration table. Today we have 3 (static, git, codegraph).                                                                                                                      |

## Implementation tasks

See beads epic `tea-rags-mcp-igk6` and its 6 subtasks (`tyfr`, `zn0w`, `ablr`,
`gkhp`, `2i3m`, `dmsm`).

## Alternatives considered

**A. Runtime tool error.** Keep tools registered, return
`ProviderNotAvailableError` on call. Rejected: client doesn't know capability
before trying, leaks signals through preset names in enums, contradicts "MCP
surface = current capabilities".

**B. Per-tool config flags.** Add `ENABLE_GET_CALLERS`, `ENABLE_FIND_CYCLES`,
etc. Rejected: explodes config surface; gating is properly a property of the
provider, not individual tools.

**C. Derive `requires` from `weights` keys automatically.** Inspect each
preset's weights, look up which trajectory owns each derived-signal name, union
into a synthetic `requires` set. Rejected: implicit magic, harder to review, and
composite presets that intentionally reference signals via the custom-weight
escape hatch would behave surprisingly. Declarative `requires` keeps intent
visible.

## Open questions

1. Should the `requires` validation be a build-time check (preset class
   self-declares; CI verifies every preset that names a codegraph descriptor has
   codegraph in requires)? — T6 will add a runtime test; build-time enforcement
   deferred.

2. Should `App.hasProvider` accept `ProviderKey` typed union or stay `string`? —
   start `string` (matches `TrajectoryRegistry.has` signature); promote to union
   if confusion grows.
