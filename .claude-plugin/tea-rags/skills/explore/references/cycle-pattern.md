# CYCLE Pattern

**Codegraph off** (explicit statement or tools absent) → "cycle detection
unavailable", never "no cycles"; never call/plan `find_cycles`.

Circular-dependency intents. `find_cycles` edge truth (SCCs of import/call
graph, pre-computed table, sub-ms) — NOT content matching.

- **"Circular dependencies?" / "cycles in X?" / "dependency loop"** →
  `find_cycles scope=file`. Each result = one SCC, length >= 2. Render as loop:
  `a.ts → b.ts → a.ts`.
- **"Circular calls between methods" / "recursive call cycle"** →
  `find_cycles scope=method`. Members = symbol ids
  (`Foo.bar → Baz.qux → Foo.bar`) + `memberLocations` `{symbolId, relativePath}`
  in `members` order. Symbol id unique per FILE → namesakes (two Go `init`,
  `main` in several scripts) told apart only by `relativePath`: render
  `path#symbol` when names collide; use that `relativePath` to pick declaration
  in `find_symbol`, never guess file. Empty `relativePath` = cycle not
  recomputed since index upgrade → reindex, don't search for file.
- **Model-closed cycles** — `hasModelEdge` (+ `modelEdgeCount`) → loop may be
  closed only by model verdict (probability `p`), not static edge; say so.
  `trace_path` `minP` read same way (weakest link).
- **Scope to module** → `pathPattern` (picomatch), e.g.
  `find_cycles scope=file pathPattern="**/domains/ingest/**"`. Cycle kept if ≥1
  member's file matches → cross-boundary cycles RETAINED (usually most
  interesting). `in/inside/within/under <X>` → `**/<X>/**` (main-flow scope
  extraction).

## Noise guard (large repos)

No-`pathPattern` run returns **>20 cycles** → don't dump. Report count, re-run
with `pathPattern` for subdomain user named (or deepest shared dir of first few
cycles), say list was scoped.

## Tail-suggestion (drill-down)

Offer `get_callers` on cycle member → who depends on loop from outside = edge
whose cut breaks blast radius. Method member → resolve exact id via
`find_symbol` first (`Class.method` / `Class#method`, not paths).

Empty result **with codegraph on** (graph tools in tool list) = valid answer:
"no cycles in `<scope>`" → DAG there; state plainly, no content-search fallback.
