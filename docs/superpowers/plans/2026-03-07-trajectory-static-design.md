# trajectory/static — Static Trajectory Module

**Date:** 2026-03-07 **Branch:** feat/onnx-embedding-provider **Status:**
Approved

## Goal

Uniformity: all payload signals, derived signals, presets, and filters are
described in trajectory/. search/ becomes purely the Reranker engine with no
signal definitions.

## Structure

```
trajectory/
  static/
    index.ts                -> StaticTrajectory implements Trajectory
    provider.ts             -> StaticPayloadBuilder.buildPayload(chunk, codebasePath)
    payload-signals.ts      -> BASE_PAYLOAD_SIGNALS (from contracts/payload-signals.ts)
    filters.ts              -> staticFilters: FilterDescriptor[]
    rerank/
      derived-signals/      -> 6 files (from search/rerank/derived-signals/)
        similarity.ts
        chunk-size.ts
        chunk-density.ts
        documentation.ts
        imports.ts
        path-risk.ts
        index.ts            -> staticDerivedSignals[]
      presets/              -> 2 files (from search/rerank/presets/)
        relevance.ts
        decomposition.ts
        index.ts            -> STATIC_PRESETS[]
  git/                      -> unchanged
  index.ts                  -> TrajectoryRegistry (unchanged)
```

## Components

### 1. StaticPayloadBuilder (trajectory/static/provider.ts)

Single static method:
`buildPayload(chunk: CodeChunk, codebasePath: string): Record<string, unknown>`

Builds the entire base payload: content, contentSize, relativePath, startLine,
endLine, fileExtension, language, codebasePath, chunkIndex, name, chunkType,
parentName, parentType, symbolId, isDocumentation, imports, methodLines,
methodDensity.

Pipeline calls it directly (not through EnrichmentCoordinator).

### 2. StaticTrajectory (trajectory/static/index.ts)

```typescript
class StaticTrajectory implements Trajectory {
  key = "static";
  name = "Static";
  description =
    "Base payload signals, structural derived signals, and generic presets";
  payloadSignals = BASE_PAYLOAD_SIGNALS;
  derivedSignals = staticDerivedSignals;
  filters = staticFilters;
  presets = STATIC_PRESETS;
  // enrichment = undefined (optional on Trajectory)
}
```

### 3. Static Filters (trajectory/static/filters.ts)

```typescript
staticFilters: FilterDescriptor[] = [
  { param: "language", key: "language", type: "string" },
  { param: "fileExtension", key: "fileExtension", type: "string" },
  { param: "chunkType", key: "chunkType", type: "string" },
  { param: "isDocumentation", key: "isDocumentation", type: "boolean" },
]
```

Available through `registry.buildFilter()` and MCP tool schemas via
SchemaBuilder.

### 4. Trajectory.enrichment -> optional

- `enrichment?: EnrichmentProvider` on Trajectory interface
- `TrajectoryRegistry.getAllEnrichmentProviders()` filters undefined

### 5. composition.ts simplifies

```typescript
registry.register(new StaticTrajectory());
registry.register(new GitTrajectory());
const allDerivedSignals = registry.getAllDerivedSignals();
const resolvedPresets = resolvePresets(registry.getAllPresets(), []);
```

### 6. chunk-pipeline.ts delegates payload

```typescript
import { StaticPayloadBuilder } from "../../trajectory/static/provider.js";

const payload = StaticPayloadBuilder.buildPayload(
  item.chunk,
  item.codebasePath,
);
```

### 7. resolvePresets simplifies

2-level (presets + composite) instead of 3-level (generic + trajectory +
composite). All presets come through registry, no separate "generic" level.

## Deleted

- `search/rerank/derived-signals/` (6 files + index.ts)
- `search/rerank/presets/` (relevance.ts, decomposition.ts, index.ts)
- `contracts/payload-signals.ts`

## Unchanged

- Reranker engine (search/reranker.ts)
- Git trajectory
- EnrichmentCoordinator
- MCP tools (they use SchemaBuilder which reads from Reranker API)

## CLAUDE.md updates

- Project Structure: new `trajectory/static/` section
- `search/` description: "only Reranker engine, no signal definitions"
- Layer dependencies: trajectory/static -> contracts (same as git)
- Static filters documented
