# Reranker Decoupling & Trajectory Interface

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Make the reranker a fully generic scoring engine with zero
trajectory-specific knowledge. Introduce `Trajectory` as the central interface
(ISP over `EnrichmentProvider`). Fix stale filter keys.

**Architecture:** Trajectory declares its payload signals, derived signals,
filters, and presets. Registry aggregates. Reranker reads payload via
dot-notation from `PayloadSignalDescriptor.key`. Confidence dampening moves into
each descriptor's `extract()`. Collection-wide stats cached until reindex.

## Interfaces

### PayloadSignalDescriptor (contracts/)

Raw Qdrant payload field descriptor — just key + type + description:

```typescript
interface PayloadSignalDescriptor {
  key: string; // "git.file.commitCount" — full Qdrant path
  type: "string" | "number" | "boolean" | "string[]" | "timestamp";
  description: string;
}
```

### SignalStats / CollectionSignalStats (contracts/)

```typescript
interface SignalStats {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  count: number;
}

interface CollectionSignalStats {
  perSignal: Map<string, SignalStats>;
  computedAt: number;
}
```

### ExtractContext (contracts/)

```typescript
interface ExtractContext {
  bound?: number;
  collectionStats?: CollectionSignalStats;
}
```

### DerivedSignalDescriptor (contracts/) — updated

```typescript
interface DerivedSignalDescriptor {
  name: string;
  description: string;
  sources: string[];
  defaultBound?: number;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number;
  // REMOVED: needsConfidence, confidenceField
}
```

### Trajectory (contracts/) — new central interface

```typescript
interface Trajectory {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  // Query-side
  readonly payloadSignals: PayloadSignalDescriptor[];
  readonly derivedSignals: DerivedSignalDescriptor[];
  readonly filters: FilterDescriptor[];
  readonly presets: RerankPreset[];
  // Ingest-side (ISP)
  readonly enrichment: EnrichmentProvider;
}
```

### EnrichmentProvider (contracts/) — ingest-only

```typescript
interface EnrichmentProvider {
  resolveRoot(absolutePath: string): string;
  fileSignalTransform?: FileSignalTransform;
  buildFileSignals(
    root: string,
    options?: { paths?: string[] },
  ): Promise<Map<string, FileSignalOverlay>>;
  buildChunkSignals(
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>>;
}
```

## File Structure

```
contracts/
  types/trajectory.ts         ← Trajectory, PayloadSignalDescriptor, CollectionSignalStats, SignalStats, ExtractContext
  payload-signals.ts          ← BASE_PAYLOAD_SIGNALS: PayloadSignalDescriptor[]

trajectory/
  index.ts                    ← TrajectoryRegistry (moved from contracts/)
  git.ts                      ← class GitTrajectory implements Trajectory
  git/
    signals.ts                ← gitPayloadSignalDescriptors: PayloadSignalDescriptor[] (was Signal[], stripped of name/defaultBound)
    filters.ts                ← fixed keys (git.file.ageDays not git.ageDays) + level param
    provider.ts               ← GitEnrichmentProvider (ingest-only)
    rerank/
      presets/                ← unchanged
      derived-signals/        ← extract() updated to (rawSignals, ctx?), self-dampening

search/
  reranker.ts                 ← Generic scoring engine, PayloadSignalDescriptor[] in constructor
  search-module.ts            ← registry.buildFilter() replaces hardcoded filters

core/api/
  composition.ts              ← registry wiring, computeCollectionStats()

bootstrap/
  factory.ts                  ← thin — adapters only, delegates to core/api
```

## Reranker Changes

### Removed

- `CONFIDENCE_THRESHOLDS` map
- `DEFAULT_CONFIDENCE_THRESHOLD`, `CONFIDENCE_POWER` constants
- `signalConfidence()` exported function
- `getEffectiveConfidenceValue()` (duplicated alpha-blending)
- `readRawSource()` (git namespace knowledge)
- `extractRawSource()` (git namespace knowledge)

### Added

- `PayloadSignalDescriptor[]` in constructor → builds
  `signalKeyMap: Map<string, string>` (short name → Qdrant path)
- Generic `readPayloadPath(payload, path)` — dot-notation traversal
- `CollectionSignalStats` cache with `setCollectionStats()` /
  `invalidateStats()`
- Passes `ExtractContext { bound, collectionStats }` to each `extract()` call

### Overlay building

Uses `signalKeyMap` to resolve mask field names to Qdrant paths:

- `mask.file: ["ageDays"]` → lookup `"ageDays"` → `"git.file.ageDays"` →
  `readPayloadPath()`

### Adaptive bounds

Uses `PayloadSignalDescriptor.key` via `signalKeyMap` instead of hardcoded
`git.file.*` paths.

## Filter Changes

### filters.ts

- `git.dominantAuthor` → `git.file.dominantAuthor` (file-only)
- `git.ageDays` → `git.${level}.ageDays` (level-aware, default: chunk)
- `git.commitCount` → `git.${level}.commitCount` (level-aware, default: chunk)
- `git.lastModifiedAt` → `git.file.lastModifiedAt` (file-only)
- `git.taskIds` → `git.file.taskIds` (file-only)

### search-module.ts

~50 lines of hardcoded if/push blocks replaced with:

```typescript
const trajectoryFilter = registry.buildFilter(params, "chunk");
if (trajectoryFilter?.must) mustConditions.push(...trajectoryFilter.must);
```

## Collection Stats Cache

### Lifecycle

```
App start → no stats (descriptors use own defaults)
Index/Reindex completes → computeCollectionStats(qdrant, collection, payloadSignals) → reranker.setCollectionStats()
Reindex starts → reranker.invalidateStats()
```

### computeCollectionStats()

Generic — receives `PayloadSignalDescriptor[]` from registry, computes
`SignalStats` for all numeric signals. Lives in `core/api/composition.ts`. Zero
trajectory knowledge.

### Descriptor usage

Each descriptor picks the percentile it needs:

```typescript
// BugFixSignal — confidence needs low threshold
const stats = ctx?.collectionStats?.perSignal.get("git.file.commitCount");
const k = stats?.p25 ?? 8;

// RecencySignal — bound needs high ceiling
// Uses ctx.bound (per-batch p95, already adaptive)
```

## Deleted

| What                                                                        | From                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Signal` interface                                                          | `contracts/types/provider.ts`                                       |
| `needsConfidence`, `confidenceField`                                        | `DerivedSignalDescriptor`                                           |
| `CONFIDENCE_THRESHOLDS`, `DEFAULT_CONFIDENCE_THRESHOLD`, `CONFIDENCE_POWER` | `search/reranker.ts`                                                |
| `signalConfidence()`                                                        | `search/reranker.ts`                                                |
| Hardcoded filter if/push blocks                                             | `search/search-module.ts`                                           |
| `TrajectoryRegistry`                                                        | `contracts/trajectory-registry.ts` (moves to `trajectory/index.ts`) |

## Beads

Epic: `tea-rags-mcp-k62` (Domain Boundaries) Related open: `tea-rags-mcp-462`
(level param), `tea-rags-mcp-7w4` (generic search-module), `tea-rags-mcp-w07`
(wire registry), `tea-rags-mcp-d56` (dynamic MCP schema)
