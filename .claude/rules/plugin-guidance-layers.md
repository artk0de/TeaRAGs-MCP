---
paths:
  - ".claude-plugin/**"
  - "src/mcp/resources/**"
  - "src/mcp/tools/**"
  - "src/cli/prime/**"
  - "src/core/api/internal/infra/schema-builder.ts"
---

# Plugin Guidance Layers — where new agent-facing knowledge goes

tea-rags ships guidance to the consuming agent on **four layers**. Each owns a
different KIND of fact and lives in a different place. When you have a new piece
of knowledge to add (a heuristic, a warning, a preset description, a routing
rule), route it to the layer that OWNS that kind of fact — do not bolt it onto
the first file you happen to open.

## The four layers

| Layer               | Owns (kind of fact)                                                                                  | Lives in                                                                                     | Delivered to agent          |
| ------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------- |
| **tea-rags prime**  | **Live runtime STATE** — index status, staleness, schema drift, infra health, this project's signal thresholds / labelMap, polyglot set, package version | `src/cli/prime/format.ts` (digest builder) — emitted by `tea-rags prime`                     | SessionStart hook, once     |
| **MCP tool schema** | **Call CONTRACT** — params, enums, defaults, addressing, pagination shape, per-tool description     | `src/mcp/tools/**` (handler descriptions) + `src/core/api/internal/infra/schema-builder.ts` (generated Zod) | at tool-call time           |
| **MCP resources**   | **Exhaustive static REFERENCE** — full preset list, full signal catalog, filter operators, indexing options, signal-label maps | `src/mcp/resources/registry.ts` (→ `tea-rags://schema/*`), generated from the live registry  | on demand (`ReadMcpResource`) |
| **search cascade**  | **Agent SELECTION POLICY** — which tool for which intent, prohibited patterns, navigation routes, fallback chains, reindex triggers | `.claude-plugin/tea-rags/rules/*.md` (injected by `scripts/inject-rules.sh`)                  | SessionStart hook, once     |

## Placement decision — new knowledge of kind K → layer L

| If the new knowledge is...                                              | It belongs to...     | Add it in...                                                              |
| ---------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| A current numeric/state fact about an index or infra                   | **prime**            | `src/cli/prime/format.ts` — never hard-code state into a cascade rule    |
| What a tool accepts / what one param means                             | **tool schema**      | the tool's `description` in `src/mcp/tools/**` (schema is generated)      |
| The complete enumeration of presets / signals / filters / index opts   | **MCP resources**    | the relevant `tea-rags://schema/*` content behind `src/mcp/resources/`   |
| When/which tool to reach for, what NOT to do, how to recover, when to reindex | **search cascade** | a `.claude-plugin/tea-rags/rules/*.md` file (new file → wire into `inject-rules.sh` + bump plugin version) |

## Precedence — why placement matters (don't duplicate across layers)

When two layers would mention the same topic, the OWNER above wins; the others
are a stale copy or a shorter view. Placing knowledge on the wrong layer creates
drift.

- **State vs everything** — any *current* number (chunk count, "stale 2d ago",
  drift fields, a threshold cutoff) belongs to **prime only**. It changes every
  reindex; a copy in a cascade rule goes stale immediately. A cascade rule may
  say "read the threshold from prime", never "the threshold is 8".
- **Resources vs cascade** — both describe tool routing
  (`tea-rags://schema/search-guide` ↔ the cascade Decision Tree). Resources are
  the **exhaustive** reference (generated from the live registry → preset/signal/
  filter **names** are authoritative there); the cascade is the **opinionated
  short path**. Put a new heuristic in the cascade; put a new preset/signal/filter
  in the registry so the resource regenerates.
- **Resources vs schema** — schema is what one tool accepts *now*; resources are
  the catalog across tools. Wiring a call → schema is binding; discovering what
  exists → resources is the map.
- **Cascade vs prime** — cascade is policy (stable across sessions), prime is
  state (per session). The cascade tells the agent *what to do when* prime reports
  a condition — e.g. `index-freshness.md` keys its reindex triggers off prime's
  stale / schema-drift banners.

## Concrete example

The reindex-behavior knowledge ("if the index is stale → `index_codebase`
incremental; schema drift → `force_reindex` with consent") is **selection
policy**, so it was placed on the **search cascade** layer at
`.claude-plugin/tea-rags/rules/index-freshness.md` — keyed off the **prime**
layer's banners, not duplicating prime's live numbers. That is the routing this
rule prescribes.

## Cross-reference

- How the consuming agent READS the resource catalog + infra diagnosis:
  `.claude-plugin/tea-rags/rules/references/runtime-introspection.md`
- Where to add code components (DI wiring): `.claude/rules/wiring.md`
- Plugin version bump on `.claude-plugin/**` edits:
  `.claude/rules/plugin-versioning.md`
