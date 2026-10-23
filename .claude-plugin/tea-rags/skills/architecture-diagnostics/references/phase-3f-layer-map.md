# Phase 3f — LAYER MAP — architecture-diagnostics

Loaded by `SKILL.md` Phase 3f.

`response.layerMap` exists ONLY when the request carried `layerMap` — skip this
phase otherwise. The map is the layering model read as a VIEW: per-node `level`
/ `depth` / `inKnot` + inner afferent/efferent counts.

| Option             | Read as                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scopePathPattern` | nodes whose path matches live INSIDE the map; absent = whole repository, no boundary findings                                                                               |
| `granularity`      | `"directory"` (default) nodes = components; `"file"` nodes = FILES leveled on raw file edges (partition excludes intra-component edges — component deps cannot level files) |
| `directoryDepth`   | with `"directory"`: collapse every directory DEEPER than this many segments below the scope root into its ancestor; `0` = one node                                          |

| Field            | Read as                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `boundaryOut`    | edge leaving the scope — names the EXTERNAL component and its `externalLevel` in the WHOLE-repo stack                                                                                                                                |
| `boundaryIn`     | edge entering the scope — same shape                                                                                                                                                                                                 |
| `moveCandidates` | inner node, 0 inner afferents, every outward edge points into ONE other domain — move-it-there signal                                                                                                                                |
| `knots`          | cycles among the map's own nodes, with the cut that levels them; `composition: true` = parent ↔ own nested parts — the summary reports those as `compositionCycle`, not `knot`, so `knotCount` + `compositionCycleCount` = map knots |
| `summary.*`      | `nodeCount`, `innerEdgeCount`, `boundaryOutEdgeCount`, `boundaryInEdgeCount`                                                                                                                                                         |

Empty scope = empty map (`nodeCount: 0`), not an error. Bad `granularity` =
validation error naming the enum, before any detector runs.
