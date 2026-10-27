---
paths:
  - "plugins/**"
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

| Layer                  | Owns (kind of fact)                                                                                                       | Lives in                                                                                                       | Delivered to agent                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **prime / digest**     | **Live runtime STATE** — index status, staleness, drift, infra health, polyglot set, version                              | `src/cli/prime/**` → `tea-rags prime`; `tea-rags://project/<alias>/digest` + `/metrics`                        | SessionStart hook; resource on demand                                |
| **MCP tool schema**    | **Call CONTRACT** — params, enums, defaults, addressing, pagination shape, per-tool description                           | `src/mcp/tools/**` (handler descriptions) + `src/core/api/internal/infra/schema-builder.ts` (generated Zod)    | at tool-call time                                                    |
| **resources + guides** | **REFERENCE + on-demand POLICY** — preset / signal / filter catalogs; navigation, decision tree, freshness, degraded mode | `src/mcp/resources/registry.ts` (builders) + `plugins/tea-rags/rules/guides/*.md` → `tea-rags://guide/<topic>` | on demand (`ReadMcpResource` / `tea-rags resource <uri>`)            |
| **core**               | **Always-on POLICY** — addressing, routing table, invariants, guide-trigger catalog, destructive-tool consent             | `plugins/tea-rags/rules/core.md` (≤ 8,500 chars)                                                               | server `instructions` + SessionStart (`inject-rules.sh`), every turn |

Guides and core are compiled into `src/mcp/resources/generated/agent-context.ts`
by `npm run gen:agent-context` (drift test fails otherwise).
`tea-rags://schema/*` = deprecated unlisted alias template, one release.

## Placement decision — new knowledge of kind K → layer L

| If the new knowledge is...                                           | It belongs to...   | Add it in...                                                                            |
| -------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| A current numeric/state fact about an index or infra                 | **prime / digest** | `src/cli/prime/**` / `src/mcp/resources/project/**` — never hard-code state into a rule |
| What a tool accepts / what one param means                           | **tool schema**    | the tool's `description` in `src/mcp/tools/**` (schema is generated)                    |
| The complete enumeration of presets / signals / filters / index opts | **resources**      | the builder behind `tea-rags://guide/*` in `src/mcp/resources/`                         |
| Situational policy: how to navigate, recover, reindex, pick a tool   | **guide**          | `plugins/tea-rags/rules/guides/<topic>.md` + a trigger line in `core.md` if new topic   |
| A rule every turn needs regardless of situation                      | **core**           | `plugins/tea-rags/rules/core.md` — only if it fits the 8,500-char budget                |

After any rules edit: `npm run gen:agent-context`, `npm run gen:harness-codex`,
`npm run gen:harness-cursor`; bump plugin version (new file → minor).

## Delivery budget — core is one part

`core.md` ≤ 8,500 chars, injected as `--part 1 --parts 1`
(`tests/hooks/agent-context-budgets.test.sh`). Server `instructions` get a ≤
4,096 head (first 512 self-contained: addressing first) + a
`tea-rags://guide/core` pointer; Cursor's `tea-rags-core.mdc` carries the full
core (≤ 8,900 incl. wrapper); Codex carries core and the digest in separate
SessionStart hooks: core ≤ `CODEX_CORE_HOOK_BUDGET` (9,650), digest ≤
`CODEX_HOOK_CONTEXT_BUDGET` (9,500). Grow a guide, not the core. Hook stdout
past ~16KB reaches the model as a 2KB preview; the splitter in `inject-rules.sh`
stays as a guard.

## Precedence — why placement matters (don't duplicate across layers)

Two layers mention same topic → OWNER above wins; others = stale copy / shorter
view. Wrong layer = drift.

- **State vs everything** — any _current_ number (chunk count, "stale 2d ago",
  drift fields, threshold cutoff) → **prime only**. Changes every reindex; copy
  in a rule goes stale immediately. Thresholds / labelMap live in the metrics
  resource, not prime. A rule may say "read threshold from the metrics
  resource", never "threshold is 8".
- **Builder resources vs guides/core** — both describe tool routing
  (`tea-rags://guide/search-examples` ↔ `guide/decision-tree`). Builder
  resources = **exhaustive** reference (generated from live registry →
  preset/signal/filter **names** authoritative there); guides/core =
  **opinionated short path**. New heuristic → guide; new preset/signal/filter →
  registry so resource regenerates.
- **Resources vs schema** — schema = what one tool accepts _now_; resources =
  catalog across tools. Wiring call → schema is binding; discovering what exists
  → resources is the map.
- **Policy vs prime** — core/guides = policy (stable across sessions), prime =
  state (per session). Policy tells agent _what to do when_ prime reports a
  condition — e.g. `tea-rags://guide/freshness` keys reindex triggers off
  prime's stale / schema-drift banners.

## Concrete example

Reindex-behavior knowledge ("stale index → `index_codebase` incremental; schema
drift → `force_reindex` with consent") = **situational policy**, so placed in
guide `plugins/tea-rags/rules/guides/freshness.md`
(`tea-rags://guide/freshness`) — keyed off **prime** layer's banners, not
duplicating prime's live numbers. That is the routing this rule prescribes.

## Cross-reference

- How consuming agent READS resource catalog + infra diagnosis:
  `plugins/tea-rags/rules/references/runtime-introspection.md`
- Where to add code components (DI wiring): `.claude/rules/wiring.md`
- Plugin version bump on `plugins/**` edits:
  `.claude/rules/plugin-versioning.md`
