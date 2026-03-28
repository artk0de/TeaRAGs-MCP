# DI Wiring Chain

The application assembles through a single chain. Know where to look when adding
or modifying components.

## Bootstrap → Composition → App → MCP

```
createAppContext(config)          // src/bootstrap/factory.ts
  ├─ QdrantManager                // vector DB client
  ├─ EmbeddingProvider            // ONNX or remote
  ├─ createComposition()          // src/core/api/internal/composition.ts
  │   ├─ TrajectoryRegistry
  │   │   ├─ StaticTrajectory     // structural signals + presets
  │   │   └─ GitTrajectory        // git signals + presets
  │   ├─ Reranker(signals, presets, descriptors)
  │   └─ resolvedPresets
  ├─ SchemaBuilder(reranker)      // generates MCP Zod schemas
  ├─ IngestFacade(qdrant, embeddings, config, ...)
  ├─ ExploreFacade(qdrant, embeddings, reranker, registry, ...)
  └─ createApp(deps) → App        // src/core/api/public/app.ts
      └─ registerAllTools(server, { app, schemaBuilder })  // src/mcp/tools/
```

## Where to add things

| Adding...               | Touch these files                                            |
| ----------------------- | ------------------------------------------------------------ |
| New MCP tool            | `mcp/tools/`, `api/public/app.ts`, facade                    |
| New derived signal      | `trajectory/{domain}/rerank/derived-signals/` + barrel       |
| New rerank preset       | `trajectory/{domain}/rerank/presets/` + barrel               |
| New trajectory          | `trajectory/`, `api/internal/composition.ts` (register)      |
| New enrichment provider | Provider file + `pipeline/enrichment/trajectory/registry.ts` |
| New DTO                 | `api/public/dto/` + barrel                                   |
| New facade method       | Facade + `api/public/app.ts`                                 |
| New migration           | `infra/migration/{pipeline}_migrations/` + register in migrator |

## Key contracts

- `App` interface (`api/public/app.ts`) — the only thing MCP tools know about
- `TrajectoryRegistry` — source of truth for signals, presets, filters
- `SchemaBuilder` — derives MCP schemas from Reranker metadata (DIP)
- Facades orchestrate but don't contain business logic
