---
paths:
  - ".claude-plugin/**"
  - "src/mcp/resources/**"
  - "src/mcp/tools/**"
  - "src/cli/prime/**"
  - "src/core/api/internal/infra/schema-builder.ts"
---

# Plugin Guidance Layers — where new agent-facing knowledge goes

tea-rags ships agent guidance on **four layers**. Each owns different KIND of
fact, lives different place. New knowledge (heuristic, warning, preset
description, routing rule) → route to layer that OWNS that fact kind — don't
bolt onto first file you open.

## The four layers

| Layer               | Owns (kind of fact)                                                                                                                                      | Lives in                                                                                                    | Delivered to agent            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **tea-rags prime**  | **Live runtime STATE** — index status, staleness, schema drift, infra health, this project's signal thresholds / labelMap, polyglot set, package version | `src/cli/prime/format.ts` (digest builder) — emitted by `tea-rags prime`                                    | SessionStart hook, once       |
| **MCP tool schema** | **Call CONTRACT** — params, enums, defaults, addressing, pagination shape, per-tool description                                                          | `src/mcp/tools/**` (handler descriptions) + `src/core/api/internal/infra/schema-builder.ts` (generated Zod) | at tool-call time             |
| **MCP resources**   | **Exhaustive static REFERENCE** — full preset list, full signal catalog, filter operators, indexing options, signal-label maps                           | `src/mcp/resources/registry.ts` (→ `tea-rags://schema/*`), generated from the live registry                 | on demand (`ReadMcpResource`) |
| **search cascade**  | **Agent SELECTION POLICY** — which tool for which intent, prohibited patterns, navigation routes, fallback chains, reindex triggers                      | `.claude-plugin/tea-rags/rules/*.md` (injected by `scripts/inject-rules.sh`)                                | SessionStart hook, once       |

## Placement decision — new knowledge of kind K → layer L

| If the new knowledge is...                                                    | It belongs to...   | Add it in...                                                                                               |
| ----------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| A current numeric/state fact about an index or infra                          | **prime**          | `src/cli/prime/format.ts` — never hard-code state into a cascade rule                                      |
| What a tool accepts / what one param means                                    | **tool schema**    | the tool's `description` in `src/mcp/tools/**` (schema is generated)                                       |
| The complete enumeration of presets / signals / filters / index opts          | **MCP resources**  | the relevant `tea-rags://schema/*` content behind `src/mcp/resources/`                                     |
| When/which tool to reach for, what NOT to do, how to recover, when to reindex | **search cascade** | a `.claude-plugin/tea-rags/rules/*.md` file (new file → wire into `inject-rules.sh` + bump plugin version) |

## Delivery budget — the cascade arrives in parts

A hook's stdout stops reaching the model past roughly 16KB: the harness writes
it to a file and shows a 2KB preview instead, with no error. The corpus is
larger than that, so `inject-rules.sh` emits it as `--part N --parts M`, one
hook command per part, each under `--max-bytes` (10000 by default) and packed on
`## ` boundaries.

**Growing the corpus is therefore a two-file change.** After adding or extending
a rule file, run `scripts/inject-rules.sh --count`; if it exceeds the number of
`--part` commands declared in `plugin.json`, add the missing ones and raise
`--parts` on all of them. The last declared part prints which rules had no slot,
so the overflow surfaces in context rather than vanishing — but it is still lost
guidance until the slot exists.

## Precedence — why placement matters (don't duplicate across layers)

Two layers mention same topic → OWNER above wins; others = stale copy / shorter
view. Wrong layer = drift.

- **State vs everything** — any _current_ number (chunk count, "stale 2d ago",
  drift fields, threshold cutoff) → **prime only**. Changes every reindex; copy
  in cascade rule goes stale immediately. Cascade rule may say "read threshold
  from prime", never "threshold is 8".
- **Resources vs cascade** — both describe tool routing
  (`tea-rags://schema/search-guide` ↔ cascade Decision Tree). Resources =
  **exhaustive** reference (generated from live registry → preset/signal/filter
  **names** authoritative there); cascade = **opinionated short path**. New
  heuristic → cascade; new preset/signal/filter → registry so resource
  regenerates.
- **Resources vs schema** — schema = what one tool accepts _now_; resources =
  catalog across tools. Wiring call → schema is binding; discovering what exists
  → resources is the map.
- **Cascade vs prime** — cascade = policy (stable across sessions), prime =
  state (per session). Cascade tells agent _what to do when_ prime reports a
  condition — e.g. `index-freshness.md` keys reindex triggers off prime's stale
  / schema-drift banners.

## Concrete example

Reindex-behavior knowledge ("stale index → `index_codebase` incremental; schema
drift → `force_reindex` with consent") = **selection policy**, so placed on
**search cascade** layer at `.claude-plugin/tea-rags/rules/index-freshness.md` —
keyed off **prime** layer's banners, not duplicating prime's live numbers. That
is the routing this rule prescribes.

## Cross-reference

- How consuming agent READS resource catalog + infra diagnosis:
  `.claude-plugin/tea-rags/rules/references/runtime-introspection.md`
- Where to add code components (DI wiring): `.claude/rules/wiring.md`
- Plugin version bump on `.claude-plugin/**` edits:
  `.claude/rules/plugin-versioning.md`
